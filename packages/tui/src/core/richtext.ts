/**
 * `RichText` is the pipeline's arena: rows of `(Style, text)` runs recorded once
 * and replayed into any downstream sink without re-parsing or re-measuring.
 *
 * Producers never see it directly — they push into an {@link Out}. `RichText`
 * is itself an `Out` (it records), and {@link RichText.replay} re-pushes what it
 * recorded, which is how a clean component contributes to a frame for the cost
 * of a pointer copy per run.
 *
 * Text pushed into the pipeline is *plain*: no `\n`, no ESC. Escape payloads
 * that must reach the terminal verbatim (Kitty placeholders, sixel, OSC 133
 * zones) go through {@link Out.raw} with an explicit cell width.
 *
 * Capacity is retained across {@link RichText.clear}: a streaming component
 * that re-renders every tick allocates nothing after the first frame.
 */
import { DEFAULT_TAB_WIDTH, visibleWidth } from "../utils";
import { Style } from "./style";

/** Per-run flags. */
export const enum RunFlag {
	None = 0,
	/** `text` is an escape payload written verbatim; `width` was supplied by the producer. */
	Raw = 1 << 0,
	/** Zero-width hardware-cursor anchor. */
	Cursor = 1 << 1,
	/** Raw run that places a terminal image (Kitty placeholder / sixel). */
	Image = 1 << 2,
	/** Raw run carrying an OSC 66 text-sizing span (scaled glyphs, multi-row). */
	Sized = 1 << 3,
	/** Raw payload preserves the terminal's SGR and OSC 8 state. */
	StyleSafe = 1 << 4,
}

/** Abstract sink every producer and transform writes into (`&mut impl Out`). */
export interface Out {
	/** Append plain text in `style` to the current row. */
	push(style: Style, text: string): void;
	/** Append a verbatim escape payload occupying `width` cells. */
	raw(style: Style, payload: string, width: number, flags?: RunFlag): void;
	/** Terminate the current row. */
	br(): void;
	/** Mark the hardware-cursor position (zero width). */
	cursor(): void;
}

/** Cells occupied by plain text (ASCII fast path, else Unicode tables + Hangul correction). */
export function cellWidth(text: string): number {
	return visibleWidth(text);
}

// A run that opens with a mark, joiner, variation selector, keycap or Thai/Lao
// AM vowel measures differently on its own than glued to the previous run's
// last grapheme (the terminal sees one string). Such runs are measured in
// context so a row's width equals the width of its concatenation.
const CONTEXT_LEAD = /^[\p{M}\u200d\ufe0f\u20e3\u0e33\u0eb3]/u;
const CONTEXT_TAIL_UNITS = 8;

const TAB_SPACES = " ".repeat(DEFAULT_TAB_WIDTH);

/** True when `text` holds a `\n` or `\t` — the two bytes that change row geometry. */
export function hasRowControl(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === 0x0a || c === 0x09) return true;
	}
	return false;
}

function contextWidth(prevText: string, text: string): number {
	const tail = prevText.length > CONTEXT_TAIL_UNITS ? prevText.slice(-CONTEXT_TAIL_UNITS) : prevText;
	return visibleWidth(tail + text) - visibleWidth(tail);
}

export class RichText implements Out {
	// Parallel run arrays; `runs` is the logical length, arrays keep capacity.
	text: string[] = [];
	style: Style[] = [];
	width: number[] = [];
	flags: RunFlag[] = [];
	runs = 0;

	// Row index: rowEnd[r] is the run index one past row r's last run.
	rowEnd: number[] = [];
	rowWidth: number[] = [];
	rows = 0;

	/** Width of the row currently being written. */
	#openWidth = 0;
	/** Whether a row is open with at least one push since the last br(). */
	#open = false;

	push(style: Style, text: string): void {
		if (text.length === 0) return;
		if (hasRowControl(text)) {
			this.#pushSanitized(style, text);
			return;
		}
		let width: number;
		const prev = this.runs - 1;
		if (
			text.charCodeAt(0) >= 0x0300 &&
			this.#open &&
			prev >= 0 &&
			this.flags[prev] === RunFlag.None &&
			CONTEXT_LEAD.test(text)
		) {
			width = contextWidth(this.text[prev]!, text);
		} else {
			width = cellWidth(text);
		}
		this.#append(style, text, width, RunFlag.None);
	}

	// A run carrying a newline would move the terminal cursor and desync every
	// later row (one extra line per repaint); a tab would be measured as fixed
	// cells but rendered to the next tab stop. Producers promise plain text;
	// enforce it here: `\n` breaks the row, `\t` expands. Other bytes pass
	// through exactly as the legacy pipeline did.
	#pushSanitized(style: Style, text: string): void {
		let start = 0;
		let pending = "";
		for (let i = 0; i < text.length; i++) {
			const c = text.charCodeAt(i);
			if (c !== 0x0a && c !== 0x09) continue;
			if (i > start) pending += text.slice(start, i);
			start = i + 1;
			if (c === 0x0a) {
				if (pending.length > 0) this.push(style, pending);
				pending = "";
				this.br();
			} else {
				pending += TAB_SPACES;
			}
		}
		if (start < text.length) pending += text.slice(start);
		if (pending.length > 0) this.push(style, pending);
	}

	raw(style: Style, payload: string, width: number, flags: RunFlag = RunFlag.Raw): void {
		this.#append(style, payload, width, flags | RunFlag.Raw);
	}

	cursor(): void {
		this.#append(Style.NONE, "", 0, RunFlag.Cursor);
	}

	br(): void {
		const r = this.rows++;
		this.rowEnd[r] = this.runs;
		this.rowWidth[r] = this.#openWidth;
		this.#openWidth = 0;
		this.#open = false;
	}

	#append(style: Style, text: string, width: number, flags: RunFlag): void {
		const i = this.runs++;
		this.text[i] = text;
		this.style[i] = style;
		this.width[i] = width;
		this.flags[i] = flags;
		this.#openWidth += width;
		this.#open = true;
	}

	/** True when runs were pushed after the last `br()` (an unterminated row). */
	get hasOpenRow(): boolean {
		return this.#open;
	}

	/**
	 * Width of the row being written so far. Hosts that prefix replayed child
	 * rows (padding, gutters, gaps) must size padding from the delta of this
	 * value around the replay — not from the child's own `rowWidth` — because a
	 * child row opening with a mark/joiner measures differently in context.
	 */
	get openWidth(): number {
		return this.#openWidth;
	}

	/** Close a trailing unterminated row, if any. */
	finish(): void {
		if (this.#open) this.br();
	}

	/** Forget all content; capacity is kept. */
	clear(): void {
		this.runs = 0;
		this.rows = 0;
		this.#openWidth = 0;
		this.#open = false;
	}

	/** Trim arrays to `runs`/`rows` so stale references past the end are released. */
	compact(): void {
		this.text.length = this.runs;
		this.style.length = this.runs;
		this.width.length = this.runs;
		this.flags.length = this.runs;
		this.rowEnd.length = this.rows;
		this.rowWidth.length = this.rows;
	}

	rowStart(row: number): number {
		return row === 0 ? 0 : this.rowEnd[row - 1]!;
	}

	/** Re-push rows `[from, to)` into `out`. Each row is terminated with `br()`. */
	replay(out: Out, from = 0, to = this.rows): void {
		let i = this.rowStart(from);
		for (let r = from; r < to; r++) {
			const end = this.rowEnd[r]!;
			for (; i < end; i++) this.#replayRun(out, i);
			out.br();
		}
	}

	/** Re-push the runs of one row without terminating it. */
	replayRow(out: Out, row: number): void {
		const end = this.rowEnd[row]!;
		for (let i = this.rowStart(row); i < end; i++) this.#replayRun(out, i);
	}

	#replayRun(out: Out, i: number): void {
		const f = this.flags[i]!;
		if (f === RunFlag.None) out.push(this.style[i]!, this.text[i]!);
		else if (f & RunFlag.Cursor) out.cursor();
		else out.raw(this.style[i]!, this.text[i]!, this.width[i]!, f);
	}

	/** Structural equality of one row against a row of another RichText. */
	rowEquals(row: number, other: RichText, otherRow: number): boolean {
		if (this.rowWidth[row] !== other.rowWidth[otherRow]) return false;
		let a = this.rowStart(row);
		let b = other.rowStart(otherRow);
		const aEnd = this.rowEnd[row]!;
		const bEnd = other.rowEnd[otherRow]!;
		if (aEnd - a !== bEnd - b) return false;
		for (; a < aEnd; a++, b++) {
			if (this.style[a] !== other.style[b] || this.flags[a] !== other.flags[b] || this.text[a] !== other.text[b])
				return false;
		}
		return true;
	}

	/** Plain text of a row (escapes and cursor omitted). Test/debug aid. */
	rowText(row: number): string {
		let s = "";
		const end = this.rowEnd[row]!;
		for (let i = this.rowStart(row); i < end; i++) {
			if ((this.flags[i]! & RunFlag.Raw) === 0) s += this.text[i]!;
		}
		return s;
	}

	/** Index of the first cursor run at or after row `from` scanning downward, or -1. */
	cursorRun(): number {
		for (let i = this.runs - 1; i >= 0; i--) if (this.flags[i]! & RunFlag.Cursor) return i;
		return -1;
	}

	/** Row containing run `i`. */
	rowOfRun(i: number): number {
		// rows are small relative to runs; binary search rowEnd.
		let lo = 0;
		let hi = this.rows - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.rowEnd[mid]! > i) hi = mid;
			else lo = mid + 1;
		}
		return lo;
	}
}
