/**
 * Parser for ANSI produced *outside* the pipeline (syntax highlighters, PTY
 * replay, third-party callbacks) into runs. Never use it to round-trip the
 * pipeline's own output.
 */
import { KITTY_PLACEHOLDER } from "../kitty-graphics";
import { replaceTabs, visibleWidth } from "../utils";
import { type Out, RunFlag } from "./richtext";
import { ansi16, ansi256, Attr, type Color, DEFAULT_COLOR, linkId, rgb, Style } from "./style";

const ESC = 0x1b;
const BEL = 0x07;
const TAB = 0x09;
const ST_BACKSLASH = 0x5c;
const KITTY_HIGH = KITTY_PLACEHOLDER.charCodeAt(0);
const KITTY_LOW = KITTY_PLACEHOLDER.charCodeAt(1);

function pushText(out: Out, style: Style, line: string, start: number, end: number, hasTab: boolean): void {
	if (start === end) return;
	const text = start === 0 && end === line.length ? line : line.slice(start, end);
	out.push(style, hasTab ? replaceTabs(text) : text);
}

function controlEnd(line: string, start: number, allowBel: boolean): number {
	for (let i = start; i < line.length; i++) {
		const code = line.charCodeAt(i);
		if (allowBel && code === BEL) return i + 1;
		if (code === ESC && line.charCodeAt(i + 1) === ST_BACKSLASH) return i + 2;
	}
	return line.length;
}

function csiEnd(line: string, start: number): number {
	for (let i = start; i < line.length; i++) {
		const code = line.charCodeAt(i);
		if (code >= 0x40 && code <= 0x7e) return i + 1;
	}
	return line.length;
}

function finiteByte(value: string | undefined): number | undefined {
	if (value === undefined || value.length === 0) return undefined;
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 && n <= 255 ? n : undefined;
}

function colonColor(parts: readonly string[]): Color | undefined {
	const mode = Number(parts[1]);
	if (mode === 5) {
		const n = finiteByte(parts.at(-1));
		return n === undefined ? undefined : ansi256(n);
	}
	if (mode !== 2 || parts.length < 5) return undefined;
	const r = finiteByte(parts.at(-3));
	const g = finiteByte(parts.at(-2));
	const b = finiteByte(parts.at(-1));
	return r === undefined || g === undefined || b === undefined ? undefined : rgb(r, g, b);
}

function applySgr(style: Style, params: string): Style {
	const fields = params.length === 0 ? [""] : params.split(";");
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i]!;
		if (field.includes(":")) {
			const parts = field.split(":");
			const code = Number(parts[0]);
			if (code === 4 && Number(parts[1]) === 3) {
				style = style.minus(Attr.Underline).plus(Attr.Undercurl);
			} else if (code === 38 || code === 48 || code === 58) {
				const color = colonColor(parts);
				if (color !== undefined) {
					style = code === 38 ? style.withFg(color) : code === 48 ? style.withBg(color) : style.withUl(color);
				}
			}
			continue;
		}

		const code = field.length === 0 ? 0 : Number(field);
		if (!Number.isInteger(code)) continue;
		switch (code) {
			case 0:
				style = Style.of({ link: style.link });
				break;
			case 1:
				style = style.plus(Attr.Bold);
				break;
			case 2:
				style = style.plus(Attr.Dim);
				break;
			case 3:
				style = style.plus(Attr.Italic);
				break;
			case 4:
				style = style.minus(Attr.Undercurl).plus(Attr.Underline);
				break;
			case 5:
				style = style.plus(Attr.Blink);
				break;
			case 7:
				style = style.plus(Attr.Inverse);
				break;
			case 8:
				style = style.plus(Attr.Hidden);
				break;
			case 9:
				style = style.plus(Attr.Strike);
				break;
			case 22:
				style = style.minus(Attr.Bold | Attr.Dim);
				break;
			case 23:
				style = style.minus(Attr.Italic);
				break;
			case 24:
				style = style.minus(Attr.Underline | Attr.Undercurl);
				break;
			case 25:
				style = style.minus(Attr.Blink);
				break;
			case 27:
				style = style.minus(Attr.Inverse);
				break;
			case 28:
				style = style.minus(Attr.Hidden);
				break;
			case 29:
				style = style.minus(Attr.Strike);
				break;
			case 39:
				style = style.withFg(DEFAULT_COLOR);
				break;
			case 49:
				style = style.withBg(DEFAULT_COLOR);
				break;
			case 53:
				style = style.plus(Attr.Overline);
				break;
			case 55:
				style = style.minus(Attr.Overline);
				break;
			case 59:
				style = style.withUl(DEFAULT_COLOR);
				break;
			default:
				if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
					style = style.withFg(ansi16(code));
				} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
					style = style.withBg(ansi16(code - 10));
				} else if (code === 38 || code === 48 || code === 58) {
					const mode = Number(fields[i + 1]);
					let color: Color | undefined;
					if (mode === 5) {
						const n = finiteByte(fields[i + 2]);
						if (n !== undefined) color = ansi256(n);
						i += 2;
					} else if (mode === 2) {
						const r = finiteByte(fields[i + 2]);
						const g = finiteByte(fields[i + 3]);
						const b = finiteByte(fields[i + 4]);
						if (r !== undefined && g !== undefined && b !== undefined) color = rgb(r, g, b);
						i += 4;
					}
					if (color !== undefined) {
						style = code === 38 ? style.withFg(color) : code === 48 ? style.withBg(color) : style.withUl(color);
					}
				}
		}
	}
	return style;
}

function isCombiningMark(codePoint: number): boolean {
	return (
		(codePoint >= 0x0300 && codePoint <= 0x036f) ||
		(codePoint >= 0x0483 && codePoint <= 0x0489) ||
		(codePoint >= 0x0591 && codePoint <= 0x05c7) ||
		(codePoint >= 0x0610 && codePoint <= 0x061a) ||
		(codePoint >= 0x064b && codePoint <= 0x065f) ||
		(codePoint >= 0x06d6 && codePoint <= 0x06ed) ||
		(codePoint >= 0x0730 && codePoint <= 0x074a) ||
		(codePoint >= 0x07eb && codePoint <= 0x07f3) ||
		(codePoint >= 0x0816 && codePoint <= 0x082d) ||
		(codePoint >= 0x0951 && codePoint <= 0x0954) ||
		(codePoint >= 0x0f82 && codePoint <= 0x0f87) ||
		(codePoint >= 0x135d && codePoint <= 0x135f) ||
		codePoint == 6109 ||
		codePoint == 6458 ||
		(codePoint >= 0x1a17 && codePoint <= 0x1a7c) ||
		(codePoint >= 0x1b6b && codePoint <= 0x1b73) ||
		(codePoint >= 0x1cd0 && codePoint <= 0x1cfa) ||
		(codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
		(codePoint >= 0x20d0 && codePoint <= 0x20f0) ||
		(codePoint >= 0x2cef && codePoint <= 0x2cf1) ||
		(codePoint >= 0x2de0 && codePoint <= 0x2dff) ||
		(codePoint >= 0xa66f && codePoint <= 0xa67d) ||
		(codePoint >= 0xa6f0 && codePoint <= 0xa6f1) ||
		(codePoint >= 0xa8e0 && codePoint <= 0xa8f1) ||
		(codePoint >= 0xaab0 && codePoint <= 0xaac1) ||
		(codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
		(codePoint >= 0x10a0f && codePoint <= 0x10a38) ||
		(codePoint >= 0x1d185 && codePoint <= 0x1d244)
	);
}

function kittyPlaceholderEnd(line: string, start: number): number {
	let i = start;
	do {
		i += 2;
		while (i < line.length) {
			const codePoint = line.codePointAt(i)!;
			if (!isCombiningMark(codePoint)) break;
			i += codePoint > 0xffff ? 2 : 1;
		}
	} while (line.charCodeAt(i) === KITTY_HIGH && line.charCodeAt(i + 1) === KITTY_LOW);
	return i;
}

/**
 * Parse one self-contained ANSI row produced outside the pipeline (syntax
 * highlighters, PTY replay, third-party callbacks). Does not terminate the
 * destination row. Never use this to round-trip pipeline output.
 */
export function parseAnsiRow(line: string, out: Out): void {
	let style = Style.NONE;
	let textStart = 0;
	let textHasTab = false;
	let i = 0;

	while (i < line.length) {
		const code = line.charCodeAt(i);
		if (code === TAB) {
			textHasTab = true;
			i++;
			continue;
		}
		if (code === KITTY_HIGH && line.charCodeAt(i + 1) === KITTY_LOW) {
			pushText(out, style, line, textStart, i, textHasTab);
			const end = kittyPlaceholderEnd(line, i);
			const payload = line.slice(i, end);
			out.raw(style, payload, visibleWidth(payload), RunFlag.Raw | RunFlag.Image);
			i = end;
			textStart = i;
			textHasTab = false;
			continue;
		}
		if (code !== ESC) {
			i++;
			continue;
		}

		pushText(out, style, line, textStart, i, textHasTab);
		const kind = line.charCodeAt(i + 1);
		if (kind === 0x5b) {
			const end = csiEnd(line, i + 2);
			if (end > i + 2 && line.charCodeAt(end - 1) === 0x6d) style = applySgr(style, line.slice(i + 2, end - 1));
			else out.raw(style, line.slice(i, end), 0, RunFlag.Raw);
			i = end;
		} else if (kind === 0x5d) {
			const contentStart = i + 2;
			const end = controlEnd(line, contentStart, true);
			let handled = false;
			if (line.charCodeAt(contentStart) === 0x38 && line.charCodeAt(contentStart + 1) === 0x3b) {
				let separator = contentStart + 2;
				while (separator < end && line.charCodeAt(separator) !== 0x3b) separator++;
				if (separator < end) {
					let urlEnd = end;
					if (line.charCodeAt(urlEnd - 1) === BEL) urlEnd--;
					else if (line.charCodeAt(urlEnd - 2) === ESC && line.charCodeAt(urlEnd - 1) === ST_BACKSLASH)
						urlEnd -= 2;
					style = style.withLink(linkId(line.slice(separator + 1, urlEnd)));
					handled = true;
				}
			}
			if (!handled) {
				const payload = line.slice(i, end);
				const sized =
					line.charCodeAt(contentStart) === 0x36 &&
					line.charCodeAt(contentStart + 1) === 0x36 &&
					line.charCodeAt(contentStart + 2) === 0x3b;
				out.raw(
					style,
					payload,
					sized ? visibleWidth(payload) : 0,
					sized ? RunFlag.Raw | RunFlag.Sized : RunFlag.Raw,
				);
			}
			i = end;
		} else if (kind === 0x5f) {
			const end = controlEnd(line, i + 2, true);
			const payload = line.slice(i, end);
			out.raw(style, payload, 0, RunFlag.Raw | RunFlag.Image);
			i = end;
		} else if (kind === 0x50) {
			const end = controlEnd(line, i + 2, false);
			out.raw(style, line.slice(i, end), 0, RunFlag.Raw | RunFlag.Image);
			i = end;
		} else {
			const end = Math.min(i + 2, line.length);
			out.raw(style, line.slice(i, end), 0, RunFlag.Raw);
			i = end;
		}
		textStart = i;
		textHasTab = false;
	}

	pushText(out, style, line, textStart, line.length, textHasTab);
}

/**
 * Parse ANSI rows produced outside the pipeline, terminating each input row in
 * the destination sink. Never use this to round-trip pipeline output.
 */
export function parseAnsiRows(lines: readonly string[], out: Out): void {
	for (const line of lines) {
		parseAnsiRow(line, out);
		out.br();
	}
}
