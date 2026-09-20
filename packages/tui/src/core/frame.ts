/**
 * Frame-level helpers for the engine: overlay splicing and cursor lookup over
 * {@link RichText} rows. These replace the string-slicing compositors
 * (`extractSegments`/`sliceWithWidth` on ANSI rows) — runs carry their widths,
 * so a splice is a run walk with at most two grapheme-level cuts.
 */
import { skipCells, spaces, takeCells } from "./out";
import { cellWidth, type Out, type RichText, RunFlag } from "./richtext";
import { Style } from "./style";

/**
 * Replay `base` row `baseRow` into `out` with cells `[col, col + width)`
 * replaced by `overlay` row `overlayRow`, padded/clipped so the result is
 * exactly `totalWidth` cells. Image rows are opaque to partial overlays: a
 * placement cannot be cut, so only a full-width overlay replaces them.
 */
export function spliceRow(
	out: Out,
	base: RichText,
	baseRow: number,
	overlay: RichText,
	overlayRow: number,
	col: number,
	width: number,
	totalWidth: number,
): void {
	if (isImageRow(base, baseRow)) {
		if (col !== 0 || width < totalWidth) {
			base.replayRow(out, baseRow);
			return;
		}
		const used = replayCells(out, overlay, overlayRow, 0, totalWidth);
		if (used < totalWidth) out.push(Style.NONE, spaces(totalWidth - used));
		return;
	}
	const before = replayCells(out, base, baseRow, 0, col);
	if (before < col) out.push(Style.NONE, spaces(col - before));
	const painted = replayCells(out, overlay, overlayRow, 0, width);
	if (painted < width) out.push(Style.NONE, spaces(width - painted));
	const afterStart = col + width;
	if (afterStart < totalWidth) {
		const after = replayCells(out, base, baseRow, afterStart, totalWidth - afterStart);
		if (after < totalWidth - afterStart) out.push(Style.NONE, spaces(totalWidth - afterStart - after));
	}
}

/** Replay the cells `[from, from + count)` of a row into `out`; returns the cells written. */
export function replayCells(out: Out, rt: RichText, row: number, from: number, count: number): number {
	if (count <= 0 || row >= rt.rows) return 0;
	const end = rt.rowEnd[row]!;
	let cursor = 0;
	let written = 0;
	for (let i = rt.rowStart(row); i < end && written < count; i++) {
		const f = rt.flags[i]!;
		const w = rt.width[i]!;
		if (f & RunFlag.Cursor) {
			if (cursor >= from) out.cursor();
			continue;
		}
		const runStart = cursor;
		const runEnd = cursor + w;
		cursor = runEnd;
		if ((f & RunFlag.Raw) !== 0 && w === 0) {
			if (runStart >= from && runStart < from + count) out.raw(rt.style[i]!, rt.text[i]!, 0, f);
			continue;
		}
		if (runEnd <= from) continue;
		const sliceFrom = Math.max(0, from - runStart);
		const sliceTo = Math.min(w, from + count - runStart);
		if (f & RunFlag.Raw) {
			// Raw payloads cannot be cut; include them only when wholly inside the window.
			if (sliceFrom === 0 && sliceTo === w) {
				out.raw(rt.style[i]!, rt.text[i]!, w, f);
				written += w;
			}
			continue;
		}
		let text = rt.text[i]!;
		if (sliceFrom > 0) text = skipCells(text, sliceFrom);
		if (sliceTo - sliceFrom < w - sliceFrom) text = takeCells(text, sliceTo - sliceFrom);
		if (text.length > 0) {
			out.push(rt.style[i]!, text);
			written += cellWidth(text);
		}
	}
	return written;
}

/** True when the row carries a terminal image placement. */
export function isImageRow(rt: RichText, row: number): boolean {
	if (row < 0 || row >= rt.rows) return false;
	const end = rt.rowEnd[row]!;
	for (let i = rt.rowStart(row); i < end; i++) if (rt.flags[i]! & RunFlag.Image) return true;
	return false;
}

/** Cursor anchors in `rt`, bottom-most first, as `{row, col}`. */
export function cursorPositions(rt: RichText): { row: number; col: number }[] {
	const found: { row: number; col: number }[] = [];
	for (let row = rt.rows - 1; row >= 0; row--) {
		const end = rt.rowEnd[row]!;
		let col = 0;
		for (let i = rt.rowStart(row); i < end; i++) {
			if (rt.flags[i]! & RunFlag.Cursor) {
				found.push({ row, col });
				break;
			}
			col += rt.width[i]!;
		}
	}
	return found;
}
