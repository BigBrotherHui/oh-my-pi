/**
 * Immutable, interned cell style for the run-based render pipeline.
 *
 * A {@link Style} is the complete SGR state of one run: foreground, background,
 * attribute bits, underline colour and OSC 8 link. Instances are interned, so
 * two styles with equal fields are the same object and every consumer (the
 * emitter, row diff, restyle adapters) compares by identity.
 *
 * Colours are packed numbers (see {@link Color}) so a style is five ints and
 * derivation (`withBg`, `plus`) hits a per-instance numeric cache — no strings
 * are built on the hot path.
 */

/**
 * Packed colour. `0` is the terminal default. Otherwise `kind << 24 | value`:
 * kind 1 = 24-bit RGB (value = 0xRRGGBB), kind 2 = 256-colour palette index,
 * kind 3 = 16-colour SGR code (30–37, 90–97 for fg; the same codes are used
 * for bg and translated by the emitter).
 */
export type Color = number & { readonly __color: unique symbol };

const KIND_SHIFT = 24;
export const enum ColorKind {
	Default = 0,
	Rgb = 1,
	Ansi256 = 2,
	Ansi16 = 3,
}

export const DEFAULT_COLOR = 0 as Color;

export function rgb(r: number, g: number, b: number): Color {
	return (((ColorKind.Rgb << KIND_SHIFT) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0) as Color;
}

export function ansi256(index: number): Color {
	return (((ColorKind.Ansi256 << KIND_SHIFT) | (index & 0xff)) >>> 0) as Color;
}

/** `code` is the SGR foreground code (30–37 or 90–97). */
export function ansi16(code: number): Color {
	return (((ColorKind.Ansi16 << KIND_SHIFT) | (code & 0xff)) >>> 0) as Color;
}

export function colorKind(c: Color): ColorKind {
	return (c >>> KIND_SHIFT) as ColorKind;
}

/** Low 24 bits: RGB triple, palette index, or SGR code depending on kind. */
export function colorValue(c: Color): number {
	return c & 0xffffff;
}

const HEX_COLOR = /^#([0-9a-f]{6})$/i;

/**
 * Parse a theme colour value: `""` → default, `#rrggbb` → RGB, integer →
 * palette index. Any other string goes through `Bun.color` (named colours).
 * Throws on unparseable input, matching `colorToAnsi`.
 */
export function parseColor(value: string | number): Color {
	if (typeof value === "number") return ansi256(value);
	if (value === "") return DEFAULT_COLOR;
	const hex = HEX_COLOR.exec(value);
	if (hex) {
		const n = Number.parseInt(hex[1]!, 16);
		return rgb(n >> 16, (n >> 8) & 0xff, n & 0xff);
	}
	const packed = Bun.color(value, "number");
	if (packed === null) throw new Error(`Invalid color value: ${value}`);
	return rgb(packed >> 16, (packed >> 8) & 0xff, packed & 0xff);
}

/** Attribute bits carried by a style. */
export const enum Attr {
	None = 0,
	Bold = 1 << 0,
	Dim = 1 << 1,
	Italic = 1 << 2,
	Underline = 1 << 3,
	Undercurl = 1 << 4,
	Strike = 1 << 5,
	Inverse = 1 << 6,
	Blink = 1 << 7,
	Overline = 1 << 8,
	Hidden = 1 << 9,
}

/** OSC 8 link registry: URLs interned to small ints so styles stay numeric. */
const linkIds = new Map<string, number>();
const linkUrls: string[] = [""];

/** Intern a hyperlink URL; `0` means no link. */
export function linkId(url: string): number {
	if (url === "") return 0;
	let id = linkIds.get(url);
	if (id === undefined) {
		id = linkUrls.length;
		linkUrls.push(url);
		linkIds.set(url, id);
	}
	return id;
}

export function linkUrl(id: number): string {
	return linkUrls[id] ?? "";
}

export interface StyleFields {
	fg: Color;
	bg: Color;
	attrs: Attr;
	/** Underline colour (SGR 58); default follows fg. */
	ul: Color;
	/** OSC 8 link id from {@link linkId}; 0 = none. */
	link: number;
}

let styleSerial = 0;

export class Style implements StyleFields {
	/** Dense identifier, unique per interned style; usable as a map key. */
	readonly id: number;
	#fgCache: Map<number, Style> | undefined;
	#bgCache: Map<number, Style> | undefined;
	#attrCache: Map<number, Style> | undefined;

	private constructor(
		readonly fg: Color,
		readonly bg: Color,
		readonly attrs: Attr,
		readonly ul: Color,
		readonly link: number,
	) {
		this.id = styleSerial++;
	}

	static #table = new Map<string, Style>();

	static readonly NONE: Style = Style.#intern(DEFAULT_COLOR, DEFAULT_COLOR, Attr.None, DEFAULT_COLOR, 0);

	/** Explicit terminal defaults that remain unstyled through enclosing background fills. */
	static readonly RESET: Style = new Style(DEFAULT_COLOR, DEFAULT_COLOR, Attr.None, DEFAULT_COLOR, 0);

	static #intern(fg: Color, bg: Color, attrs: Attr, ul: Color, link: number): Style {
		const key = `${fg},${bg},${attrs},${ul},${link}`;
		let s = Style.#table.get(key);
		if (s === undefined) {
			s = new Style(fg, bg, attrs, ul, link);
			Style.#table.set(key, s);
		}
		return s;
	}

	/** Build from explicit fields; missing fields default. */
	static of(fields: Partial<StyleFields>): Style {
		return Style.#intern(
			fields.fg ?? DEFAULT_COLOR,
			fields.bg ?? DEFAULT_COLOR,
			fields.attrs ?? Attr.None,
			fields.ul ?? DEFAULT_COLOR,
			fields.link ?? 0,
		);
	}

	with(patch: Partial<StyleFields>): Style {
		return Style.#intern(
			patch.fg ?? this.fg,
			patch.bg ?? this.bg,
			patch.attrs ?? this.attrs,
			patch.ul ?? this.ul,
			patch.link ?? this.link,
		);
	}

	withFg(fg: Color): Style {
		if (fg === this.fg) return this;
		const cache = (this.#fgCache ??= new Map());
		let s = cache.get(fg);
		if (s === undefined) {
			s = Style.#intern(fg, this.bg, this.attrs, this.ul, this.link);
			cache.set(fg, s);
		}
		return s;
	}

	withBg(bg: Color): Style {
		if (bg === this.bg) return this;
		const cache = (this.#bgCache ??= new Map());
		let s = cache.get(bg);
		if (s === undefined) {
			s = Style.#intern(this.fg, bg, this.attrs, this.ul, this.link);
			cache.set(bg, s);
		}
		return s;
	}

	withAttrs(attrs: Attr): Style {
		if (attrs === this.attrs) return this;
		const cache = (this.#attrCache ??= new Map());
		let s = cache.get(attrs);
		if (s === undefined) {
			s = Style.#intern(this.fg, this.bg, attrs, this.ul, this.link);
			cache.set(attrs, s);
		}
		return s;
	}

	plus(attr: Attr): Style {
		return this.withAttrs(this.attrs | attr);
	}

	minus(attr: Attr): Style {
		return this.withAttrs(this.attrs & ~attr);
	}

	has(attr: Attr): boolean {
		return (this.attrs & attr) !== 0;
	}

	withLink(link: number): Style {
		return link === this.link ? this : Style.#intern(this.fg, this.bg, this.attrs, this.ul, link);
	}

	withUl(ul: Color): Style {
		return ul === this.ul ? this : Style.#intern(this.fg, this.bg, this.attrs, ul, this.link);
	}

	/** True when every field is default: the emitter needs no SGR for it. */
	get isNone(): boolean {
		return this === Style.NONE || this === Style.RESET;
	}

	/**
	 * Fill in defaults from `base`: fields this style leaves at default take
	 * `base`'s value. Used by `restyle`/`bgFill` adapters so an explicit inner
	 * colour wins over an outer fill.
	 */
	over(base: Style): Style {
		if (base === Style.NONE || this === Style.RESET) return this;
		if (this === Style.NONE) return base;
		return Style.#intern(
			this.fg === DEFAULT_COLOR ? base.fg : this.fg,
			this.bg === DEFAULT_COLOR ? base.bg : this.bg,
			this.attrs | base.attrs,
			this.ul === DEFAULT_COLOR ? base.ul : this.ul,
			this.link === 0 ? base.link : this.link,
		);
	}
}
