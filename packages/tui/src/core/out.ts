/**
 * Single-pass transforms over an {@link Out}. Each wraps a downstream sink and
 * rewrites runs as they stream through; none builds an intermediate string.
 *
 * Row-scoped transforms (`wrap`, `clip`, `pad`) buffer at most the current row
 * in a scratch {@link RichText} that keeps its capacity. Output-scoped
 * transforms (`tail`, `head`) buffer everything until {@link Transform.end}.
 * Producers only ever call `push`/`raw`/`br`/`cursor`; the owner of the chain
 * calls `end()` once after the producer returns (see {@link pipe}).
 */
import { Ellipsis, sliceWithWidth } from "@oh-my-pi/pi-natives";
import { DEFAULT_TAB_WIDTH } from "../utils";
import { cellWidth, hasRowControl, type Out, RichText, RunFlag } from "./richtext";
import { Style } from "./style";

/** An `Out` that wraps another and may hold state needing a final flush. */
export interface Transform extends Out {
	readonly downstream: Out;
	/** Flush buffered rows downstream. Idempotent. */
	end(): void;
}

/** Run `producer` into `out`, then flush every transform in the chain, outermost first. */
export function pipe(out: Out, producer: (out: Out) => void): void {
	producer(out);
	let t: Out = out;
	while (t instanceof Forward) {
		t.end();
		t = t.downstream;
	}
}

/** Leading `cells` columns of plain text; grapheme-safe, never splits a wide char. */
export function takeCells(text: string, cells: number): string {
	if (cells <= 0) return "";
	if (text.length <= cells && isAscii(text)) return text;
	return sliceWithWidth(text, 0, cells, true, DEFAULT_TAB_WIDTH).text;
}

/** Plain text after skipping `cells` columns. */
export function skipCells(text: string, cells: number): string {
	if (cells <= 0) return text;
	if (isAscii(text)) return text.slice(cells);
	return sliceWithWidth(text, cells, Number.MAX_SAFE_INTEGER, false, DEFAULT_TAB_WIDTH).text;
}

function isAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7e) return false;
	return true;
}

const ELLIPSIS_TEXT: Record<Ellipsis, string> = {
	[Ellipsis.Unicode]: "…",
	[Ellipsis.Ascii]: "...",
	[Ellipsis.Omit]: "",
};

const SPACES = " ".repeat(512);
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Push `text` into `out` as plain rows: `\n` becomes `br()` and `\t` expands.
 * The `Out` contract asks producers for single-row plain text, but a stray
 * newline (markdown soft breaks, raw tool output) must never reach the
 * terminal, where it would move the cursor and desync every later row.
 */
export function splitLines(out: Out, style: Style, text: string): void {
	let start = 0;
	let pending = "";
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c !== 0x0a && c !== 0x09) continue;
		if (i > start) pending += text.slice(start, i);
		start = i + 1;
		if (c === 0x0a) {
			if (pending.length > 0) out.push(style, pending);
			pending = "";
			out.br();
		} else {
			pending += TAB_SPACES;
		}
	}
	if (start < text.length) pending += text.slice(start);
	if (pending.length > 0) out.push(style, pending);
}

const TAB_SPACES = " ".repeat(DEFAULT_TAB_WIDTH);

/** `n` spaces without allocating for common widths. */
export function spaces(n: number): string {
	return n <= SPACES.length ? SPACES.slice(0, n) : " ".repeat(n);
}

/**
 * Base for transforms: forwards everything to `downstream` unless overridden.
 * `push` normalizes embedded `\n` into row breaks (see {@link splitLines}) and
 * hands single-row text to `pushText`, which is what subclasses override.
 */
abstract class Forward implements Transform {
	constructor(readonly downstream: Out) {}
	push(style: Style, text: string): void {
		if (text.length === 0) return;
		if (hasRowControl(text)) {
			splitLines(this, style, text);
			return;
		}
		this.pushText(style, text);
	}
	/** Append single-row text (no `\n`). */
	pushText(style: Style, text: string): void {
		this.downstream.push(style, text);
	}
	raw(style: Style, payload: string, width: number, flags?: RunFlag): void {
		this.downstream.raw(style, payload, width, flags);
	}
	br(): void {
		this.downstream.br();
	}
	cursor(): void {
		this.downstream.cursor();
	}
	end(): void {}
}

/** Map every run's style through `f`. `f` must be pure over interned styles. */
export class Restyle extends Forward {
	#memo: Map<Style, Style> = new Map();
	constructor(
		downstream: Out,
		readonly f: (style: Style) => Style,
	) {
		super(downstream);
	}
	#map(style: Style): Style {
		let s = this.#memo.get(style);
		if (s === undefined) {
			s = this.f(style);
			this.#memo.set(style, s);
		}
		return s;
	}
	override pushText(style: Style, text: string): void {
		this.downstream.push(this.#map(style), text);
	}
	override raw(style: Style, payload: string, width: number, flags?: RunFlag): void {
		this.downstream.raw(this.#map(style), payload, width, flags);
	}
}

/**
 * Fill defaults from `base`: runs that leave fg/bg/attrs unset take the base
 * values. This is `bgFill`/`fgOnBg` without the reset-resumption regexes.
 */
export function over(downstream: Out, base: Style): Restyle {
	return new Restyle(downstream, s => s.over(base));
}

/**
 * Pad every row to `width` cells (at `br()`) with spaces in `fill`. Rows are
 * buffered so the width comes from the row's own context-aware measurement.
 */
export class Pad extends Forward {
	#scratch = new RichText();
	constructor(
		downstream: Out,
		readonly width: number,
		readonly fill: Style = Style.NONE,
		readonly align: "left" | "center" | "right" = "left",
	) {
		super(downstream);
	}
	override pushText(style: Style, text: string): void {
		this.#scratch.push(style, text);
	}
	override raw(style: Style, payload: string, width: number, flags?: RunFlag): void {
		this.#scratch.raw(style, payload, width, flags);
	}
	override cursor(): void {
		this.#scratch.cursor();
	}
	override br(): void {
		const row = this.#scratch;
		row.br();
		const rest = Math.max(0, this.width - row.rowWidth[0]!);
		const left = this.align === "left" ? 0 : this.align === "center" ? rest >> 1 : rest;
		if (left > 0) this.downstream.push(this.fill, spaces(left));
		row.replayRow(this.downstream, 0);
		if (rest - left > 0) this.downstream.push(this.fill, spaces(rest - left));
		this.downstream.br();
		row.clear();
	}
}

/** Cells of plain text, measured exactly as `RichText.push` measures a standalone run. */
function cellsOf(text: string): number {
	return cellWidth(text);
}

/**
 * Truncate rows to `width` cells. Overflowing rows keep `width - ellipsis`
 * cells and end with the ellipsis in the style of the last kept run —
 * mirrors native `truncateToWidth`. `pad` fills short rows to `width`.
 */
export class Clip extends Forward {
	#row = new RichText();
	/** Optional chrome style; RESET keeps an overflow marker outside surrounding tints. */
	ellipsisStyle: Style = Style.NONE;
	/** Keep a clipped linked label's destination on its overflow marker. */
	preserveEllipsisLink = false;
	constructor(
		downstream: Out,
		readonly width: number,
		readonly ellipsis: Ellipsis = Ellipsis.Unicode,
		readonly pad = false,
		readonly fill: Style = Style.NONE,
	) {
		super(downstream);
	}
	override pushText(style: Style, text: string): void {
		this.#row.push(style, text);
	}
	override raw(style: Style, payload: string, width: number, flags?: RunFlag): void {
		this.#row.raw(style, payload, width, flags);
	}
	override cursor(): void {
		this.#row.cursor();
	}
	override br(): void {
		const row = this.#row;
		row.br();
		const total = row.rowWidth[0]!;
		const out = this.downstream;
		if (total <= this.width) {
			row.replayRow(out, 0);
			if (this.pad && total < this.width) out.push(this.fill, spaces(this.width - total));
		} else {
			const ell = takeCells(ELLIPSIS_TEXT[this.ellipsis], this.width);
			const ellW = ell.length;
			const keep = Math.max(0, this.width - ellW);
			let used = 0;
			let last = Style.NONE;
			for (let i = 0; i < row.runs && used < keep; i++) {
				const w = row.width[i]!;
				const f = row.flags[i]!;
				last = row.style[i]!;
				if (f & RunFlag.Cursor) {
					out.cursor();
					continue;
				}
				if (used + w <= keep) {
					if (f & RunFlag.Raw) out.raw(last, row.text[i]!, w, f);
					else out.push(last, row.text[i]!);
					used += w;
				} else if ((f & RunFlag.Raw) === 0) {
					const part = takeCells(row.text[i]!, keep - used);
					out.push(last, part);
					used += cellsOf(part);
					break;
				} else {
					break;
				}
			}
			// The ellipsis is chrome, not content: unstyled like a legacy
			// `truncateToWidth` suffix, so an accent/link run never bleeds into it.
			if (ellW > 0) {
				out.push(this.preserveEllipsisLink ? this.ellipsisStyle.withLink(last.link) : this.ellipsisStyle, ell);
				used += ellW;
			}
			if (this.pad && used < this.width) out.push(this.fill, spaces(this.width - used));
		}
		out.br();
		row.clear();
	}
}

/**
 * Prefix rows: `first` on the first row, `rest` on continuation rows. Rows
 * that receive no runs still get a prefix when `emptyRows` is true.
 */
export class Indent extends Forward {
	#rowIndex = 0;
	#started = false;
	constructor(
		downstream: Out,
		readonly first: readonly [Style, string],
		readonly rest: readonly [Style, string] = first,
		readonly emptyRows = true,
	) {
		super(downstream);
	}
	#start(): void {
		if (this.#started) return;
		this.#started = true;
		const p = this.#rowIndex === 0 ? this.first : this.rest;
		if (p[1].length > 0) this.downstream.push(p[0], p[1]);
	}
	override pushText(style: Style, text: string): void {
		this.#start();
		this.downstream.push(style, text);
	}
	override raw(style: Style, payload: string, width: number, flags?: RunFlag): void {
		this.#start();
		this.downstream.raw(style, payload, width, flags);
	}
	override cursor(): void {
		this.#start();
		this.downstream.cursor();
	}
	override br(): void {
		if (this.emptyRows) this.#start();
		this.downstream.br();
		this.#rowIndex++;
		this.#started = false;
	}
}

/** Write to `downstream` and record into `cache` simultaneously. */
export class Tee extends Forward {
	constructor(
		downstream: Out,
		readonly cache: RichText,
	) {
		super(downstream);
	}
	override pushText(style: Style, text: string): void {
		this.cache.push(style, text);
		this.downstream.push(style, text);
	}
	override raw(style: Style, payload: string, width: number, flags?: RunFlag): void {
		this.cache.raw(style, payload, width, flags);
		this.downstream.raw(style, payload, width, flags);
	}
	override cursor(): void {
		this.cache.cursor();
		this.downstream.cursor();
	}
	override br(): void {
		this.cache.br();
		this.downstream.br();
	}
}

/** Keep only the last `count` rows (`tail`) or the first `count` rows (`head`). */
export class RowWindow extends Forward {
	#buf = new RichText();
	#ended = false;
	constructor(
		downstream: Out,
		readonly count: number,
		readonly mode: "head" | "tail",
		/** Called with the number of dropped rows when any were dropped; may emit a marker row. */
		readonly onElide?: (dropped: number, out: Out) => void,
	) {
		super(downstream);
	}
	override pushText(style: Style, text: string): void {
		this.#buf.push(style, text);
	}
	override raw(style: Style, payload: string, width: number, flags?: RunFlag): void {
		this.#buf.raw(style, payload, width, flags);
	}
	override cursor(): void {
		this.#buf.cursor();
	}
	override br(): void {
		this.#buf.br();
	}
	override end(): void {
		if (this.#ended) return;
		this.#ended = true;
		const buf = this.#buf;
		buf.finish();
		const dropped = Math.max(0, buf.rows - this.count);
		if (this.mode === "head") {
			buf.replay(this.downstream, 0, buf.rows - dropped);
			if (dropped > 0) this.onElide?.(dropped, this.downstream);
		} else {
			if (dropped > 0) this.onElide?.(dropped, this.downstream);
			buf.replay(this.downstream, dropped, buf.rows);
		}
		buf.clear();
	}
}

/**
 * Word-wrap rows to `width` cells. Mirrors native `wrapTextWithAnsi`:
 * tokens are runs of spaces vs. non-spaces, a token that does not fit starts
 * the next row (a whitespace token at the break is dropped), tokens wider than
 * the row are hard-broken at grapheme boundaries, and every emitted row has
 * trailing spaces trimmed when wrapping occurred. Rows that already fit pass
 * through untouched.
 */
export class Wrap extends Forward {
	#row = new RichText();
	// Token pieces for the current row: parallel arrays reused across rows.
	#pStyle: Style[] = [];
	#pText: string[] = [];
	#pWidth: number[] = [];
	#pFlags: RunFlag[] = [];
	#pToken: number[] = []; // token index per piece
	#pCount = 0;
	#tokWs: boolean[] = [];
	#tokWidth: number[] = [];
	#tokStart: number[] = [];
	#tokCount = 0;
	// Current output row under construction.
	#line = new RichText();
	// Style in effect at the last soft break. Native wrap re-emits active SGR
	// codes at the start of every continuation row, which makes an otherwise
	// empty row "non-empty" for the long-word flush; mirrored here so styled
	// text wraps identically.
	#carried: Style = Style.NONE;

	constructor(
		downstream: Out,
		readonly width: number,
	) {
		super(downstream);
	}
	override pushText(style: Style, text: string): void {
		this.#row.push(style, text);
	}
	override raw(style: Style, payload: string, width: number, flags?: RunFlag): void {
		this.#row.raw(style, payload, width, flags);
	}
	override cursor(): void {
		this.#row.cursor();
	}
	override br(): void {
		const row = this.#row;
		row.br();
		if (row.rowWidth[0]! <= this.width) {
			row.replayRow(this.downstream, 0);
			this.downstream.br();
			row.clear();
			return;
		}
		this.#tokenize(row);
		this.#wrapTokens();
		row.clear();
	}

	#piece(style: Style, text: string, width: number, flags: RunFlag, ws: boolean): void {
		const t = this.#tokCount - 1;
		const startNew = t < 0 || this.#tokWs[t] !== ws || (flags & RunFlag.Cursor) !== 0;
		let tok = t;
		if (startNew && !(flags & RunFlag.Cursor)) {
			tok = this.#tokCount++;
			this.#tokWs[tok] = ws;
			this.#tokWidth[tok] = 0;
			this.#tokStart[tok] = this.#pCount;
		} else if (flags & RunFlag.Cursor) {
			// Cursor markers glue to the current token (zero width) so they wrap with it.
			if (tok < 0) {
				tok = this.#tokCount++;
				this.#tokWs[tok] = false;
				this.#tokWidth[tok] = 0;
				this.#tokStart[tok] = this.#pCount;
			}
		}
		const i = this.#pCount++;
		this.#pStyle[i] = style;
		this.#pText[i] = text;
		this.#pWidth[i] = width;
		this.#pFlags[i] = flags;
		this.#pToken[i] = tok;
		this.#tokWidth[tok]! += width;
	}

	#tokenize(row: RichText): void {
		this.#pCount = 0;
		this.#tokCount = 0;
		for (let r = 0; r < row.runs; r++) {
			const style = row.style[r]!;
			const text = row.text[r]!;
			const flags = row.flags[r]!;
			if (flags !== RunFlag.None) {
				this.#piece(style, text, row.width[r]!, flags, false);
				continue;
			}
			// Split plain text into space / non-space segments.
			let start = 0;
			let ws = text.charCodeAt(0) === 0x20;
			for (let i = 1; i <= text.length; i++) {
				const isWs = i < text.length && text.charCodeAt(i) === 0x20;
				if (i === text.length || isWs !== ws) {
					const seg = text.slice(start, i);
					this.#piece(style, seg, ws ? seg.length : cellsOf(seg), RunFlag.None, ws);
					start = i;
					ws = isWs;
				}
			}
		}
	}

	#emitLine(): void {
		const line = this.#line;
		if (line.runs > 0) this.#carried = line.style[line.runs - 1]!;
		line.br();
		this.#trimReplay(line);
		this.downstream.br();
		line.clear();
	}

	// Replay `line` row 0 with trailing spaces trimmed.
	#trimReplay(line: RichText): void {
		let end = line.runs;
		// Trim whole trailing space-only plain runs, then a partial one.
		while (end > 0) {
			const i = end - 1;
			if (line.flags[i] !== RunFlag.None) break;
			const t = line.text[i]!;
			let k = t.length;
			while (k > 0 && t.charCodeAt(k - 1) === 0x20) k--;
			if (k === t.length) break;
			if (k === 0) {
				end--;
				continue;
			}
			for (let j = 0; j < i; j++) this.#replayRun(line, j);
			this.downstream.push(line.style[i]!, t.slice(0, k));
			return;
		}
		for (let j = 0; j < end; j++) this.#replayRun(line, j);
	}

	#replayRun(line: RichText, i: number): void {
		const f = line.flags[i]!;
		if (f === RunFlag.None) this.downstream.push(line.style[i]!, line.text[i]!);
		else if (f & RunFlag.Cursor) this.downstream.cursor();
		else this.downstream.raw(line.style[i]!, line.text[i]!, line.width[i]!, f);
	}

	#appendPiece(i: number): void {
		const f = this.#pFlags[i]!;
		if (f === RunFlag.None) this.#line.push(this.#pStyle[i]!, this.#pText[i]!);
		else if (f & RunFlag.Cursor) this.#line.cursor();
		else this.#line.raw(this.#pStyle[i]!, this.#pText[i]!, this.#pWidth[i]!, f);
	}

	#lineWidth(): number {
		let w = 0;
		for (let i = 0; i < this.#line.runs; i++) w += this.#line.width[i]!;
		return w;
	}

	#wrapTokens(): void {
		const width = this.width;
		const n = this.#tokCount;
		let curWidth = 0;
		// True when the current (possibly empty) row would carry re-emitted SGR
		// codes in the native implementation.
		let lineHasCodes = false;
		this.#carried = Style.NONE;
		for (let t = 0; t < n; t++) {
			const tw = this.#tokWidth[t]!;
			const ws = this.#tokWs[t]!;
			const from = this.#tokStart[t]!;
			const to = t + 1 < n ? this.#tokStart[t + 1]! : this.#pCount;
			if (tw > width && !ws) {
				if (this.#line.runs > 0 || lineHasCodes) {
					this.#emitLine();
					curWidth = 0;
				}
				this.#breakLong(from, to);
				curWidth = this.#lineWidth();
				lineHasCodes = this.#carried !== Style.NONE;
				continue;
			}
			if (curWidth + tw > width && curWidth > 0) {
				this.#emitLine();
				curWidth = 0;
				lineHasCodes = this.#carried !== Style.NONE;
				if (ws) continue;
			}
			for (let i = from; i < to; i++) this.#appendPiece(i);
			curWidth += tw;
		}
		if (this.#line.runs > 0 || lineHasCodes) this.#emitLine();
	}

	// Hard-break pieces [from,to) grapheme by grapheme into #line, emitting
	// full rows. Mirrors native `break_long_word`: a grapheme that does not fit
	// flushes the current row even when that row is empty.
	#breakLong(from: number, to: number): void {
		const width = this.width;
		let cur = this.#lineWidth();
		for (let i = from; i < to; i++) {
			const f = this.#pFlags[i]!;
			if (f !== RunFlag.None) {
				const w = this.#pWidth[i]!;
				if (cur + w > width) {
					this.#emitLine();
					cur = 0;
				}
				this.#appendPiece(i);
				cur += w;
				continue;
			}
			const text = this.#pText[i]!;
			const style = this.#pStyle[i]!;
			if (isAscii(text)) {
				let start = 0;
				for (let k = 0; k < text.length; k++) {
					if (cur + 1 > width) {
						if (k > start) this.#line.push(style, text.slice(start, k));
						start = k;
						this.#emitLine();
						cur = 0;
					}
					cur += 1;
				}
				if (start < text.length) this.#line.push(style, text.slice(start));
				continue;
			}
			for (const { segment } of GRAPHEMES.segment(text)) {
				const gw = cellsOf(segment);
				if (cur + gw > width) {
					this.#emitLine();
					cur = 0;
				}
				this.#line.push(style, segment);
				cur += gw;
			}
		}
	}
}
