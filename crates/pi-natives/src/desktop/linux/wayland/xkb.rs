//! Layout-aware character resolution for the libei Wayland backend.
//!
//! The RemoteDesktop portal announces the compositor's active keyboard layout
//! as a libxkbcommon-compatible XKB keymap (`ei_keyboard.keymap`). Emitting
//! fixed US evdev keycodes ignores that layout, so on e.g. French AZERTY
//! `type("a")` inserts `q` and accented characters cannot be produced at all.
//!
//! [`KeyboardLayout`] compiles the announced keymap and precomputes, for every
//! Unicode character the layout can produce, the evdev keycode plus the evdev
//! modifier keycodes that select it (Shift, AltGr, …). libxkbcommon is loaded
//! at runtime through `dlopen`, never linked, so the crate keeps building on
//! cross targets (musl, arm64) that cannot satisfy a `-lxkbcommon` link —
//! mirroring why the PipeWire dependency is opt-in. When the library is absent
//! the caller falls back to the fixed US table.

use std::{
	collections::HashMap,
	ffi::{CStr, CString, c_char, c_int, c_void},
	sync::LazyLock,
};

/// The evdev keycode and modifier keycodes that produce a character under the
/// active layout. `keycode` and every entry of `modifiers` are evdev codes
/// (`linux/input-event-codes.h`), i.e. XKB keycodes minus 8, as expected by
/// `ei_keyboard.key`.
#[derive(Debug, Clone)]
pub(super) struct KeyStroke {
	pub keycode:   u32,
	pub modifiers: Vec<u32>,
}

/// libxkbcommon entry points resolved once via `dlopen`.
///
/// Every field is a plain `extern "C"` function pointer, so the struct is
/// trivially `Send`/`Sync`. The `dlopen` handle is intentionally never closed —
/// the library stays mapped for the process lifetime.
struct Xkb {
	context_new:            unsafe extern "C" fn(c_int) -> *mut c_void,
	context_unref:          unsafe extern "C" fn(*mut c_void),
	keymap_new_from_string:
		unsafe extern "C" fn(*mut c_void, *const c_char, c_int, c_int) -> *mut c_void,
	keymap_unref:           unsafe extern "C" fn(*mut c_void),
	min_keycode:            unsafe extern "C" fn(*mut c_void) -> u32,
	max_keycode:            unsafe extern "C" fn(*mut c_void) -> u32,
	num_layouts_for_key:    unsafe extern "C" fn(*mut c_void, u32) -> u32,
	num_levels_for_key:     unsafe extern "C" fn(*mut c_void, u32, u32) -> u32,
	key_get_syms_by_level:
		unsafe extern "C" fn(*mut c_void, u32, u32, u32, *mut *const u32) -> c_int,
	key_get_mods_for_level:
		unsafe extern "C" fn(*mut c_void, u32, u32, u32, *mut u32, usize) -> usize,
	num_mods:               unsafe extern "C" fn(*mut c_void) -> u32,
	mod_get_name:           unsafe extern "C" fn(*mut c_void, u32) -> *const c_char,
	keysym_to_utf32:        unsafe extern "C" fn(u32) -> u32,
}

/// `XKB_KEYMAP_FORMAT_TEXT_V1`, the only keymap text format libxkbcommon
/// parses.
const KEYMAP_FORMAT_TEXT_V1: c_int = 1;

macro_rules! dlsym {
	($handle:expr, $name:literal) => {{
		// SAFETY: `$handle` is a live `dlopen` handle and the symbol name is a
		// NUL-terminated string literal. A missing symbol yields null, handled
		// below by aborting the load.
		let ptr = unsafe { libc::dlsym($handle, concat!($name, "\0").as_ptr().cast()) };
		if ptr.is_null() {
			return None;
		}
		// SAFETY: libxkbcommon exports `$name` with the signature declared in the
		// matching `Xkb` field; transmuting the symbol address to that pointer
		// type is the standard `dlsym` binding.
		unsafe { std::mem::transmute::<*mut c_void, _>(ptr) }
	}};
}

/// Loads libxkbcommon on first use, caching the resolved symbols (or `None`
/// when the library is unavailable).
#[allow(
	clippy::missing_transmute_annotations,
	reason = "each symbol's fn-pointer type is fixed by the destination Xkb field"
)]
static XKB: LazyLock<Option<Xkb>> = LazyLock::new(|| {
	// SAFETY: `dlopen` with a NUL-terminated literal; a null return (library not
	// installed) is handled by falling back to `None`.
	let handle =
		unsafe { libc::dlopen(c"libxkbcommon.so.0".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
	if handle.is_null() {
		return None;
	}
	Some(Xkb {
		context_new:            dlsym!(handle, "xkb_context_new"),
		context_unref:          dlsym!(handle, "xkb_context_unref"),
		keymap_new_from_string: dlsym!(handle, "xkb_keymap_new_from_string"),
		keymap_unref:           dlsym!(handle, "xkb_keymap_unref"),
		min_keycode:            dlsym!(handle, "xkb_keymap_min_keycode"),
		max_keycode:            dlsym!(handle, "xkb_keymap_max_keycode"),
		num_layouts_for_key:    dlsym!(handle, "xkb_keymap_num_layouts_for_key"),
		num_levels_for_key:     dlsym!(handle, "xkb_keymap_num_levels_for_key"),
		key_get_syms_by_level:  dlsym!(handle, "xkb_keymap_key_get_syms_by_level"),
		key_get_mods_for_level: dlsym!(handle, "xkb_keymap_key_get_mods_for_level"),
		num_mods:               dlsym!(handle, "xkb_keymap_num_mods"),
		mod_get_name:           dlsym!(handle, "xkb_keymap_mod_get_name"),
		keysym_to_utf32:        dlsym!(handle, "xkb_keysym_to_utf32"),
	})
});

/// Maps an XKB real-modifier name to the evdev keycode that engages it. Returns
/// `None` for modifiers that cannot be held to select a printable character
/// (`Lock`/`Mod2` toggle Caps/Num lock rather than acting as a live modifier).
fn modifier_evdev(name: &str) -> Option<u32> {
	match name {
		"Shift" => Some(42),   // KEY_LEFTSHIFT
		"Control" => Some(29), // KEY_LEFTCTRL
		"Mod1" => Some(56),    // KEY_LEFTALT
		"Mod4" => Some(125),   // KEY_LEFTMETA
		"Mod5" => Some(100),   // KEY_RIGHTALT (AltGr / ISO level-3 shift)
		_ => None,
	}
}

impl KeyboardLayout {
	/// Compiles the announced XKB keymap text and precomputes the character
	/// table. Returns `None` when libxkbcommon is unavailable, the text does not
	/// compile, or the layout produces no usable character.
	pub(super) fn compile(keymap: &str) -> Option<Self> {
		let xkb = XKB.as_ref()?;
		let source = CString::new(keymap).ok()?;
		// SAFETY: `xkb` holds valid libxkbcommon entry points. The context and
		// keymap handles are created and unconditionally released within this
		// block; `source` outlives the parse call; every raw pointer handed to a
		// call is either freshly returned by libxkbcommon or the NUL-terminated
		// `source` buffer.
		let table = unsafe {
			let ctx = (xkb.context_new)(0);
			if ctx.is_null() {
				return None;
			}
			let keymap = (xkb.keymap_new_from_string)(ctx, source.as_ptr(), KEYMAP_FORMAT_TEXT_V1, 0);
			if keymap.is_null() {
				(xkb.context_unref)(ctx);
				return None;
			}
			let table = build_table(xkb, keymap);
			(xkb.keymap_unref)(keymap);
			(xkb.context_unref)(ctx);
			table
		};
		(!table.is_empty()).then_some(Self { table })
	}

	/// Returns the keystroke that produces `ch`, or `None` if the active layout
	/// cannot type it.
	pub(super) fn resolve_char(&self, ch: char) -> Option<&KeyStroke> {
		self.table.get(&ch)
	}
}

/// A compiled keyboard layout: the characters it can produce mapped to the
/// evdev keystroke that produces each.
pub(super) struct KeyboardLayout {
	table: HashMap<char, KeyStroke>,
}

/// Walks every keycode/layout/level of `keymap`, recording the simplest
/// keystroke (fewest modifiers) for each producible Unicode character.
///
/// # Safety
///
/// `xkb` must hold valid libxkbcommon entry points and `keymap` a live keymap
/// created by them.
unsafe fn build_table(xkb: &Xkb, keymap: *mut c_void) -> HashMap<char, KeyStroke> {
	let mut table: HashMap<char, KeyStroke> = HashMap::new();
	// SAFETY: guaranteed by this function's contract; all keycodes/layouts/levels
	// are queried within the ranges libxkbcommon reports, and `syms` is only read
	// for the `count` entries the call returns.
	unsafe {
		let num_mods = (xkb.num_mods)(keymap).min(8);
		let min = (xkb.min_keycode)(keymap);
		let max = (xkb.max_keycode)(keymap);
		for keycode in min..=max {
			for layout in 0..(xkb.num_layouts_for_key)(keymap, keycode) {
				for level in 0..(xkb.num_levels_for_key)(keymap, keycode, layout) {
					let mut syms: *const u32 = std::ptr::null();
					let count =
						(xkb.key_get_syms_by_level)(keymap, keycode, layout, level, &raw mut syms);
					if count <= 0 || syms.is_null() {
						continue;
					}
					let Some(modifiers) = mods_for_level(xkb, keymap, keycode, layout, level, num_mods)
					else {
						continue;
					};
					for &sym in std::slice::from_raw_parts(syms, count as usize) {
						let Some(ch) = char::from_u32((xkb.keysym_to_utf32)(sym)) else {
							continue;
						};
						if ch.is_control() {
							continue;
						}
						let candidate =
							KeyStroke { keycode: keycode.wrapping_sub(8), modifiers: modifiers.clone() };
						match table.get(&ch) {
							Some(existing) if existing.modifiers.len() <= candidate.modifiers.len() => {},
							_ => {
								table.insert(ch, candidate);
							},
						}
					}
				}
			}
		}
	}
	table
}

/// Resolves the evdev modifier keycodes required to reach `level`, or `None`
/// when no announced modifier combination is expressible with holdable keys.
///
/// # Safety
///
/// Same contract as [`build_table`]: `xkb`/`keymap` valid, indices in range.
unsafe fn mods_for_level(
	xkb: &Xkb,
	keymap: *mut c_void,
	keycode: u32,
	layout: u32,
	level: u32,
	num_mods: u32,
) -> Option<Vec<u32>> {
	let mut masks = [0u32; 4];
	// SAFETY: `masks` provides `masks.len()` slots for the call to fill.
	let count = unsafe {
		(xkb.key_get_mods_for_level)(keymap, keycode, layout, level, masks.as_mut_ptr(), masks.len())
	};
	if count == 0 {
		// Base level with no modifiers recorded.
		return Some(Vec::new());
	}
	'mask: for &mask in masks.iter().take(count) {
		let mut modifiers = Vec::new();
		for bit in 0..num_mods {
			if mask & (1 << bit) == 0 {
				continue;
			}
			// SAFETY: `bit < num_mods <= num_mods(keymap)`, a valid modifier index.
			let name = unsafe { (xkb.mod_get_name)(keymap, bit) };
			if name.is_null() {
				continue 'mask;
			}
			// SAFETY: libxkbcommon returns a NUL-terminated static string.
			match modifier_evdev(&unsafe { CStr::from_ptr(name) }.to_string_lossy()) {
				Some(code) => modifiers.push(code),
				None => continue 'mask,
			}
		}
		return Some(modifiers);
	}
	None
}

#[cfg(test)]
mod tests {
	use super::modifier_evdev;

	#[test]
	fn holdable_modifiers_map_to_their_evdev_keycodes() {
		// These are the exact keycodes `type_text` presses to select shifted and
		// AltGr characters; a wrong value silently types the wrong glyph (e.g.
		// AltGr must be RightAlt=100 so `#`/`@`/`€` reach XKB level 3).
		assert_eq!(modifier_evdev("Shift"), Some(42));
		assert_eq!(modifier_evdev("Control"), Some(29));
		assert_eq!(modifier_evdev("Mod1"), Some(56));
		assert_eq!(modifier_evdev("Mod4"), Some(125));
		assert_eq!(modifier_evdev("Mod5"), Some(100));
	}

	#[test]
	fn lock_modifiers_are_rejected() {
		// Caps/Num lock toggle state instead of acting as a held level selector,
		// so a level requiring them is treated as untypeable rather than emitting
		// the wrong character.
		assert_eq!(modifier_evdev("Lock"), None);
		assert_eq!(modifier_evdev("Mod2"), None);
		assert_eq!(modifier_evdev("Mod3"), None);
	}
}
