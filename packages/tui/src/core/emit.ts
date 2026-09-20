/**
 * ANSI emission for {@link RichText} rows: one pass over runs, emitting only the
 * SGR/OSC 8 transitions between adjacent styles. This is where escape bytes are
 * born — nothing upstream ever holds an ANSI string.
 *
 * Raw runs (image placeholders, sixel, OSC 133 zones) may carry their own SGR,
 * so the tracked style is invalidated after them and the next styled run
 * re-emits its full state after a `\x1b[0m`.
 */
import type { ColorMode } from "../theme/schema";
import { type RichText, RunFlag } from "./richtext";
import { Attr, type Color, ColorKind, colorKind, colorValue, linkUrl, Style } from "./style";

const OSC8_CLOSE = "\x1b]8;;\x07";

/** Emit options; `mode` selects truecolor vs 256-colour SGR for RGB colours. */
export interface EmitOptions {
	mode: ColorMode;
}

const ANSI256_CACHE = new Map<Color, number>();

function toAnsi256(c: Color): number {
	let n = ANSI256_CACHE.get(c);
	if (n === undefined) {
		const v = colorValue(c);
		const hex = `#${v.toString(16).padStart(6, "0")}`;
		const seq = Bun.color(hex, "ansi-256") ?? "";
		// `\x1b[38;5;<n>m`
		const m = /38;5;(\d+)m/.exec(seq);
		n = m ? Number.parseInt(m[1]!, 10) : 7;
		ANSI256_CACHE.set(c, n);
	}
	return n;
}

/** SGR parameter string for a colour in slot `base` (38 fg, 48 bg, 58 underline). */
function colorParams(c: Color, base: 38 | 48 | 58, mode: ColorMode): string {
	switch (colorKind(c)) {
		case ColorKind.Default:
			return base === 38 ? "39" : base === 48 ? "49" : "59";
		case ColorKind.Rgb: {
			if (mode === "truecolor") {
				const v = colorValue(c);
				return `${base};2;${v >> 16};${(v >> 8) & 0xff};${v & 0xff}`;
			}
			return `${base};5;${toAnsi256(c)}`;
		}
		case ColorKind.Ansi256:
			return `${base};5;${colorValue(c)}`;
		case ColorKind.Ansi16: {
			const code = colorValue(c);
			if (base === 38) return String(code);
			if (base === 48) return String(code + 10);
			return `58;5;${code >= 90 ? code - 90 + 8 : code - 30}`;
		}
	}
}

const ATTR_ON: readonly [Attr, string][] = [
	[Attr.Bold, "1"],
	[Attr.Dim, "2"],
	[Attr.Italic, "3"],
	[Attr.Underline, "4"],
	[Attr.Undercurl, "4:3"],
	[Attr.Blink, "5"],
	[Attr.Inverse, "7"],
	[Attr.Hidden, "8"],
	[Attr.Strike, "9"],
	[Attr.Overline, "53"],
];

/**
 * Append to `params` the SGR parameters turning `prev` into `next`. Returns
 * the params joined with `;` (empty when no change is needed).
 */
export function sgrDelta(prev: Style, next: Style, mode: ColorMode): string {
	if (prev === next) return "";
	let p = "";
	const removed = prev.attrs & ~next.attrs;
	let attrsToAdd = next.attrs & ~prev.attrs;
	if (removed !== 0) {
		if (removed & (Attr.Bold | Attr.Dim)) {
			p += "22;";
			// 22 clears both weight attributes; restore the surviving one.
			attrsToAdd |= next.attrs & (Attr.Bold | Attr.Dim);
		}
		if (removed & Attr.Italic) p += "23;";
		if (removed & (Attr.Underline | Attr.Undercurl)) {
			p += "24;";
			attrsToAdd |= next.attrs & (Attr.Underline | Attr.Undercurl);
		}
		if (removed & Attr.Blink) p += "25;";
		if (removed & Attr.Inverse) p += "27;";
		if (removed & Attr.Hidden) p += "28;";
		if (removed & Attr.Strike) p += "29;";
		if (removed & Attr.Overline) p += "55;";
	}
	if (attrsToAdd !== 0) {
		for (const [bit, code] of ATTR_ON) if (attrsToAdd & bit) p += `${code};`;
	}
	if (prev.fg !== next.fg) p += `${colorParams(next.fg, 38, mode)};`;
	if (prev.bg !== next.bg) p += `${colorParams(next.bg, 48, mode)};`;
	if (prev.ul !== next.ul) p += `${colorParams(next.ul, 58, mode)};`;
	return p.length === 0 ? "" : p.slice(0, -1);
}

/** Full SGR sequence (after a reset) establishing `s`; empty for `Style.NONE`. */
export function sgrFull(s: Style, mode: ColorMode): string {
	const params = sgrDelta(Style.NONE, s, mode);
	return params.length === 0 ? "" : `\x1b[${params}m`;
}

/**
 * Serialize row `row` of `rt` as ANSI. Starts from the default style and ends
 * with `\x1b[0m` (plus an OSC 8 close) when the row leaves a style or link
 * open — so the returned string is self-contained.
 */
export function emitRow(rt: RichText, row: number, opts: EmitOptions): string {
	const end = rt.rowEnd[row]!;
	let out = "";
	let prev: Style | null = Style.NONE; // null = unknown after a raw run
	// Style of the last styled (non-raw) run; decides the trailing reset. Raw
	// payloads (image placements) are self-contained and must end the row
	// byte-exact, so they neither require nor receive a reset.
	let lastStyled: Style = Style.NONE;
	let link = 0;
	for (let i = rt.rowStart(row); i < end; i++) {
		const flags = rt.flags[i]!;
		if (flags & RunFlag.Cursor) continue;
		if ((flags & (RunFlag.Raw | RunFlag.StyleSafe)) === (RunFlag.Raw | RunFlag.StyleSafe)) {
			out += rt.text[i]!;
			continue;
		}
		const style = rt.style[i]!;
		if (style.link !== link) {
			out += style.link === 0 ? OSC8_CLOSE : `\x1b]8;;${linkUrl(style.link)}\x07`;
			link = style.link;
		}
		if (prev === null) {
			out += "\x1b[0m";
			const full = sgrFull(style, opts.mode);
			if (full.length > 0) out += full;
		} else if (style !== prev) {
			const d = sgrDelta(prev, style, opts.mode);
			if (d.length > 0) out += `\x1b[${d}m`;
		}
		out += rt.text[i]!;
		if (flags & RunFlag.Raw) prev = null;
		else prev = lastStyled = style;
	}
	if (lastStyled !== Style.NONE) out += "\x1b[0m";
	if (link !== 0) out += OSC8_CLOSE;
	return out;
}

/** Convenience: every row of `rt` as ANSI strings. */
export function emitRows(rt: RichText, opts: EmitOptions): string[] {
	const rows: string[] = new Array(rt.rows);
	for (let r = 0; r < rt.rows; r++) rows[r] = emitRow(rt, r, opts);
	return rows;
}
