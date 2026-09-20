/**
 * Diff pane of the git TUI, with four view modes:
 *
 * - `split` (default): old file left, new file right, aligned line-by-line
 *   with word-level intraline emphasis and faint fillers for one-sided rows.
 * - `inline`: the full file with deletions/additions stacked in place.
 * - `hunk`: only the changed regions (3 context lines), one block per hunk
 *   with `@@` headers and per-hunk stage/unstage/discard buttons.
 * - `file`: the current (new) side only, plain syntax-highlighted view.
 *
 * The right edge carries a minimap-style scrollbar encoding change density
 * (deletions > additions > changes > context, hunk headers in accent) with
 * the visible viewport brightened; clicking it seeks. Long lines either pan
 * horizontally (`←`/`→`) or soft-wrap when word wrap is enabled.
 */
import type { DiffStreamResult, HighlightStream } from "@oh-my-pi/pi-natives";
import { diffWords, structuredPatchHunks } from "@oh-my-pi/pi-natives";
import { createImagePaintState, type ImageBudget, type ImagePaintState } from "../../host/elements/image";
import { clampScrollOffset, scrollOffsetForRow, viewportRange } from "../../components/scroll-viewport";
import { parseAnsiRow } from "../../core/ansi";
import { cellWidth, RichText } from "../../core/richtext";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayText } from "../../overlays/extensions/display-text";
import { getLanguageFromPath } from "../../lang-from-path";
import { createHighlightStream, theme } from "../../theme/theme";
import { skipCells, spaces, takeCells } from "../../core/out";
import type { JSX } from "../../reactive";
import { Attr, type Color, DEFAULT_COLOR, Style } from "../../core/style";
import {
	bgStyle,
	canvasHex,
	colorHex,
	mixHex,
	pill,
	Runs,
	runsWidth,
	type StyledRun,
	selectionStyle,
	textHex,
} from "./colors";
import { DIFF_CONTEXT_LINES, type FileAssetSide, type FileStreamUpdate } from "./state";

/** Column ranges (inclusive start, exclusive end) carrying intraline emphasis. */
type MarkRanges = readonly (readonly [number, number])[];

type RowKind = "context" | "change" | "add" | "del";

interface DiffRow {
	readonly kind: RowKind;
	readonly oldNum?: number;
	readonly newNum?: number;
	/** Tab-expanded line for each side ("" when absent). */
	readonly oldText: string;
	readonly newText: string;
	readonly oldWidth: number;
	readonly newWidth: number;
	readonly oldMarks?: MarkRanges;
	readonly newMarks?: MarkRanges;
	/** Raw (untab-expanded) source lines, for patch construction. */
	readonly oldRaw?: string;
	readonly newRaw?: string;
}

/** One changed region with its applyable patch for hunk-level staging. */
export interface HunkBlock {
	/** `@@ -a,b +c,d @@` header shown above the block. */
	readonly header: string;
	/** Standalone patch text for this hunk, or "" when not applyable. */
	readonly patch: string;
	readonly rows: readonly DiffRow[];
}

/** Aligned diff document produced by {@link buildDiffDocument}. */
export interface DiffDocument {
	readonly filePath: string;
	readonly rows: readonly DiffRow[];
	readonly hunks: readonly HunkBlock[];
	/** Tab-expanded new-side lines for the `file` view. */
	readonly fileLines: readonly { text: string; width: number }[];
	/** Tab-expanded source lines, retained for progressive syntax highlighting. */
	readonly oldDisplayLines: readonly string[];
	/** Tab-expanded source lines, retained for progressive syntax highlighting. */
	readonly newDisplayLines: readonly string[];
	readonly additions: number;
	readonly deletions: number;
	readonly gutterWidth: number;
	readonly maxLineWidth: number;
	/** False when built with whitespace-ignore: hunk patches would not apply. */
	readonly canPatch: boolean;
	/** Raw input texts and newline state, for line-selection patches. */
	readonly rawOld: string;
	readonly rawNew: string;
	readonly oldEndsNewline: boolean;
	readonly newEndsNewline: boolean;
	/** Index into {@link rows} for each 1-based new-file line number. */
	readonly rowIndexByNewLine: readonly number[];
}

/** How the pane presents the document. */
export type ViewMode = "split" | "inline" | "hunk" | "file";

/** Hunk-button actions raised to the root component. */
export type HunkAction = "stage" | "unstage" | "discard";

/** Maximum source lines highlighted before yielding control back to the TUI. */
const HIGHLIGHT_BATCH_LINES = 32;
/** Cap on intraline word-diff pairs per document. */
const INTRALINE_PAIR_LIMIT = 1_500;

function intralineMarks(oldLine: string, newLine: string): { old: MarkRanges; new: MarkRanges } {
	const oldRanges: [number, number][] = [];
	const newRanges: [number, number][] = [];
	let oldCol = 0;
	let newCol = 0;
	for (const change of diffWords(oldLine, newLine)) {
		const width = cellWidth(change.value);
		if (change.removed) {
			pushRange(oldRanges, oldCol, oldCol + width);
			oldCol += width;
		} else if (change.added) {
			pushRange(newRanges, newCol, newCol + width);
			newCol += width;
		} else {
			oldCol += width;
			newCol += width;
		}
	}
	return { old: oldRanges, new: newRanges };
}

function pushRange(ranges: [number, number][], start: number, end: number): void {
	if (end <= start) return;
	const last = ranges[ranges.length - 1];
	if (last && start <= last[1]) last[1] = Math.max(last[1], end);
	else ranges.push([start, end]);
}

/**
 * Whitespace handling for {@link buildDiffDocument}:
 *
 * - `off`: exact, byte-level alignment.
 * - `whitespace`: align ignoring leading/trailing whitespace (disables hunk
 *   patches — the alignment no longer matches git's view of the file).
 * - `formatting`: exact alignment, but changed blocks that only move
 *   whitespace around (indentation, line splits/joins, blank lines) or only
 *   touch import statements (ts/js, rust, go) are demoted to context.
 */
export type WhitespaceMode = "off" | "whitespace" | "formatting";

/** Languages with import-statement demotion under formatting-ignore. */
type ImportLang = "ts" | "rust" | "go";

const IMPORT_LANG_BY_EXT: Record<string, ImportLang> = {
	ts: "ts",
	tsx: "ts",
	mts: "ts",
	cts: "ts",
	js: "ts",
	jsx: "ts",
	mjs: "ts",
	cjs: "ts",
	rs: "rust",
	go: "go",
};

/**
 * Per-language import recognition. `starter` marks a line that begins an
 * import statement; `continuation` admits inner/closing lines of multi-line
 * import blocks. A changed block is import-only when every changed line
 * matches either pattern and at least one matches `starter`.
 * `removable` matches self-contained import statement lines that may be
 * dropped before re-comparing a mixed block as a pure reflow.
 */
const IMPORT_LINES: Record<ImportLang, { starter: RegExp; continuation: RegExp; removable: RegExp }> = {
	ts: {
		starter: /^import\b|^export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']/,
		continuation:
			/^(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?\s*,?$|^\}\s*from\s*["'][^"']*["'](?:\s*with\s*\{[^}]*\})?\s*;?$/,
		removable:
			/^import\b[^"']*["'][^"']*["'][^"']*$|^export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'][^"']*["']\s*;?$|^\}\s*from\s*["'][^"']*["'](?:\s*with\s*\{[^}]*\})?\s*;?$/,
	},
	rust: {
		starter: /^(?:pub(?:\([^)]*\))?\s+)?use\b|^extern\s+crate\b/,
		continuation: /^[\w:*{},\s]+;?$/,
		removable: /^(?:pub(?:\([^)]*\))?\s+)?use\b[^;]*;$|^extern\s+crate\s+[^;]+;$/,
	},
	go: {
		starter: /^import\b/,
		continuation: /^(?:[\w.]+\s+)?"[^"]+"\s*,?$|^[()]$/,
		removable: /^import\b.*$|^(?:[\w.]+\s+)?"[^"]+"$|^\)$/,
	},
};

/** Options for {@link buildDiffDocument}. */
export interface DiffBuildOptions {
	/** Whitespace handling; defaults to `off`. */
	whitespace?: WhitespaceMode;
	/** Exact runs/hunks already computed by the native streaming differ. */
	streamResult?: DiffStreamResult;
}

/** Build the aligned document for one file from its raw old/new texts. */
export function buildDiffDocument(
	oldRaw: string,
	newRaw: string,
	filePath: string,
	options: DiffBuildOptions = {},
): DiffDocument {
	const mode = options.whitespace ?? "off";
	const ignoreWs = mode === "whitespace";
	const ignoreFormatting = mode === "formatting";
	const dot = filePath.lastIndexOf(".");
	const importLang =
		ignoreFormatting && dot >= 0 ? (IMPORT_LANG_BY_EXT[filePath.slice(dot + 1).toLowerCase()] ?? null) : null;
	const oldLines = oldRaw.length === 0 ? [] : oldRaw.replace(/\n$/, "").split("\n");
	const newLines = newRaw.length === 0 ? [] : newRaw.replace(/\n$/, "").split("\n");
	const oldPlain = oldLines.map(sanitizeDisplayText);
	const newPlain = newLines.map(sanitizeDisplayText);

	// Alignment basis: raw lines, or trimmed lines when ignoring whitespace.
	// Line numbers stay 1:1 with the raw text either way.
	// The raw text is passed through untouched so trailing-newline state is
	// preserved — hunk patches must match `git apply`'s view of the file.
	const oldBasis = ignoreWs
		? oldLines.map(line => line.trim()).join("\n") + (oldRaw.endsWith("\n") ? "\n" : "")
		: oldRaw;
	const newBasis = ignoreWs
		? newLines.map(line => line.trim()).join("\n") + (newRaw.endsWith("\n") ? "\n" : "")
		: newRaw;

	let additions = 0;
	let deletions = 0;
	let intralinePairs = 0;
	let maxLineWidth = 0;
	const touch = (line: string | undefined): void => {
		if (line !== undefined) maxLineWidth = Math.max(maxLineWidth, line.length);
	};

	const makeRow = (kind: RowKind, oldIdx: number | undefined, newIdx: number | undefined): DiffRow => {
		let marks: { old: MarkRanges; new: MarkRanges } | undefined;
		if (kind === "change" && oldIdx !== undefined && newIdx !== undefined && intralinePairs < INTRALINE_PAIR_LIMIT) {
			intralinePairs++;
			marks = intralineMarks(oldPlain[oldIdx] ?? "", newPlain[newIdx] ?? "");
		}
		return {
			kind,
			oldNum: oldIdx === undefined ? undefined : oldIdx + 1,
			newNum: newIdx === undefined ? undefined : newIdx + 1,
			oldText: oldIdx === undefined ? "" : (oldPlain[oldIdx] ?? ""),
			newText: newIdx === undefined ? "" : (newPlain[newIdx] ?? ""),
			oldWidth: oldIdx === undefined ? 0 : cellWidth(oldPlain[oldIdx] ?? ""),
			newWidth: newIdx === undefined ? 0 : cellWidth(newPlain[newIdx] ?? ""),
			oldMarks: marks?.old,
			newMarks: marks?.new,
			oldRaw: oldIdx === undefined ? undefined : oldLines[oldIdx],
			newRaw: newIdx === undefined ? undefined : newLines[newIdx],
		};
	};
	/** True when a changed block should demote to context under formatting-ignore. */
	const demoteBlock = (dels: number[], adds: number[]): boolean => {
		if (!ignoreFormatting) return false;
		const stripBlock = (lines: string[], indices: number[], removable: RegExp | null): string => {
			let out = "";
			for (const idx of indices) {
				const raw = lines[idx] ?? "";
				if (removable?.test(raw.trim())) continue;
				out += raw.replace(/\s+/g, "");
			}
			return out;
		};
		if (stripBlock(oldLines, dels, null) === stripBlock(newLines, adds, null)) return true;
		if (!importLang) return false;
		const { starter, continuation, removable } = IMPORT_LINES[importLang];
		let sawImport = false;
		const importish = (lines: string[], indices: number[]): boolean => {
			for (const idx of indices) {
				const line = (lines[idx] ?? "").trim();
				if (line.length === 0) continue;
				if (starter.test(line)) sawImport = true;
				else if (!continuation.test(line)) return false;
			}
			return true;
		};
		if (importish(oldLines, dels) && importish(newLines, adds) && sawImport) return true;
		// Mixed block: whole-line import statements dropped, the remainder must
		// be a pure whitespace reflow for the block to stay hidden.
		return stripBlock(oldLines, dels, removable) === stripBlock(newLines, adds, removable);
	};

	/** Pair a pending del/add block into rows; ignored blocks become context. */
	const flushBlock = (rows: DiffRow[], dels: number[], adds: number[], count: boolean): void => {
		if (dels.length === 0 && adds.length === 0) return;
		const paired = Math.min(dels.length, adds.length);
		if (demoteBlock(dels, adds)) {
			for (let i = 0; i < paired; i++) rows.push(makeRow("context", dels[i], adds[i]));
			for (let i = paired; i < dels.length; i++) rows.push(makeRow("context", dels[i], undefined));
			for (let i = paired; i < adds.length; i++) rows.push(makeRow("context", undefined, adds[i]));
			return;
		}
		if (count) {
			deletions += dels.length;
			additions += adds.length;
		}
		for (let i = 0; i < paired; i++) rows.push(makeRow("change", dels[i], adds[i]));
		for (let i = paired; i < dels.length; i++) rows.push(makeRow("del", dels[i], undefined));
		for (let i = paired; i < adds.length; i++) rows.push(makeRow("add", undefined, adds[i]));
	};

	/** Walk one structured hunk into aligned rows (shared by both passes). */
	const walkHunk = (hunk: { oldStart: number; newStart: number; lines: string[] }, count: boolean): DiffRow[] => {
		const rows: DiffRow[] = [];
		let oldNum = hunk.oldStart;
		let newNum = hunk.newStart;
		let pendingDel: number[] = [];
		let pendingAdd: number[] = [];
		const flush = (): void => {
			flushBlock(rows, pendingDel, pendingAdd, count);
			pendingDel = [];
			pendingAdd = [];
		};
		for (const line of hunk.lines) {
			const tag = line[0];
			if (tag === "\\") continue;
			if (tag === "-") {
				touch(oldPlain[oldNum - 1]);
				pendingDel.push(oldNum - 1);
				oldNum++;
			} else if (tag === "+") {
				touch(newPlain[newNum - 1]);
				pendingAdd.push(newNum - 1);
				newNum++;
			} else {
				flush();
				touch(oldPlain[oldNum - 1]);
				touch(newPlain[newNum - 1]);
				rows.push(makeRow("context", oldNum - 1, newNum - 1));
				oldNum++;
				newNum++;
			}
		}
		flush();
		return rows;
	};

	const streamed = ignoreWs ? undefined : options.streamResult;
	const rows: DiffRow[] = [];
	if (streamed) {
		let oldIndex = 0;
		let newIndex = 0;
		let pendingDel: number[] = [];
		let pendingAdd: number[] = [];
		const flush = (): void => {
			flushBlock(rows, pendingDel, pendingAdd, true);
			pendingDel = [];
			pendingAdd = [];
		};
		for (const run of streamed.runs) {
			if (run.removed) {
				for (let index = 0; index < run.count; index++) {
					touch(oldPlain[oldIndex]);
					pendingDel.push(oldIndex++);
				}
			} else if (run.added) {
				for (let index = 0; index < run.count; index++) {
					touch(newPlain[newIndex]);
					pendingAdd.push(newIndex++);
				}
			} else {
				flush();
				for (let index = 0; index < run.count; index++) {
					touch(oldPlain[oldIndex]);
					touch(newPlain[newIndex]);
					rows.push(makeRow("context", oldIndex++, newIndex++));
				}
			}
		}
		flush();
	} else {
		// The synchronous path remains for direct callers and whitespace-ignore.
		const megaHunks = structuredPatchHunks(oldBasis, newBasis, oldLines.length + newLines.length + 1);
		for (const hunk of megaHunks) rows.push(...walkHunk(hunk, true));
		if (megaHunks.length === 0) {
			for (let index = 0; index < oldLines.length; index++) {
				touch(oldPlain[index]);
				rows.push(makeRow("context", index, index));
			}
		}
	}

	// Tight hunks drive the hunk view and patch actions. Whitespace-ignore
	// cannot use the raw streamed result because its equality basis differs.
	const canPatch = !ignoreWs;
	const tightHunks = streamed?.hunks ?? structuredPatchHunks(oldBasis, newBasis, DIFF_CONTEXT_LINES);
	const allHunks: HunkBlock[] = tightHunks.map(hunk => ({
		header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
		patch: canPatch
			? `--- a/${filePath}\n+++ b/${filePath}\n@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}\n`
			: "",
		rows: walkHunk(hunk, false),
	}));
	// Formatting-ignore: hunks whose every changed block was demoted vanish
	// from the hunk view; mixed hunks stay (their patches include the
	// formatting noise — staging follows git's real content).
	const hunks = ignoreFormatting ? allHunks.filter(hunk => hunk.rows.some(row => row.kind !== "context")) : allHunks;

	const fileLines = newPlain.map(line => ({ text: line, width: cellWidth(line) }));
	const gutterWidth = Math.max(3, String(Math.max(oldLines.length, newLines.length)).length);
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const rowIndexByNewLine: number[] = new Array(newLines.length + 1).fill(-1);
	rows.forEach((row, index) => {
		if (row.newNum !== undefined && rowIndexByNewLine[row.newNum] === -1) rowIndexByNewLine[row.newNum] = index;
	});
	return {
		filePath,
		rows,
		hunks,
		fileLines,
		oldDisplayLines: oldPlain,
		newDisplayLines: newPlain,
		additions,
		deletions,
		gutterWidth,
		maxLineWidth,
		canPatch,
		rawOld: oldRaw,
		rawNew: newRaw,
		oldEndsNewline: oldRaw.endsWith("\n"),
		newEndsNewline: newRaw.endsWith("\n"),
		rowIndexByNewLine,
	};
}
/**
 * Build a patch covering only the changed rows inside `[from, to]` (indices
 * into `doc.rows`).
 *
 * - `apply`: base is the old side; the target adopts only the selected
 *   changes. Staging selected lines = apply this to the index.
 * - `revert`: base is the new side; the target undoes only the selected
 *   changes. Unstaging selected lines = apply `--cached`; discarding
 *   selected lines = apply to the worktree.
 *
 * Returns `null` when the selection touches no changes or the document
 * cannot produce patches (whitespace-ignore alignment).
 */
export function buildLineSelectionPatch(
	doc: DiffDocument,
	from: number,
	to: number,
	intent: "apply" | "revert",
): string | null {
	if (!doc.canPatch) return null;
	const target: string[] = [];
	let touched = false;
	for (let i = 0; i < doc.rows.length; i++) {
		const row = doc.rows[i];
		const selected = i >= from && i <= to;
		if (selected && row.kind !== "context") touched = true;
		const useNew = intent === "apply" ? selected : !selected;
		switch (row.kind) {
			case "context": {
				// Formatting-demoted rows can be one-sided or differ across
				// sides; the target must mirror the patch base outside changes.
				const line = intent === "apply" ? row.oldRaw : row.newRaw;
				if (line !== undefined) target.push(line);
				break;
			}
			case "change":
				target.push((useNew ? row.newRaw : row.oldRaw) ?? "");
				break;
			case "del":
				if (!useNew) target.push(row.oldRaw ?? "");
				break;
			case "add":
				if (useNew) target.push(row.newRaw ?? "");
				break;
		}
	}
	if (!touched) return null;
	const base = intent === "apply" ? doc.rawOld : doc.rawNew;
	const baseEndsNL = intent === "apply" ? doc.oldEndsNewline : doc.newEndsNewline;
	const otherEndsNL = intent === "apply" ? doc.newEndsNewline : doc.oldEndsNewline;
	const lastRow = doc.rows[doc.rows.length - 1];
	const lastSelected = lastRow !== undefined && to >= doc.rows.length - 1 && lastRow.kind !== "context";
	const endsNL = lastSelected ? otherEndsNL : baseEndsNL;
	const targetText = target.join("\n") + (endsNL && target.length > 0 ? "\n" : "");
	const hunks = structuredPatchHunks(base, targetText, DIFF_CONTEXT_LINES);
	if (hunks.length === 0) return null;
	const body = hunks
		.map(
			hunk =>
				`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
		)
		.join("\n");
	return `--- a/${doc.filePath}\n+++ b/${doc.filePath}\n${body}\n`;
}

// ── palette ──────────────────────────────────────────────────────────────────

interface MapColor {
	readonly base: Color;
	readonly bright: Color;
}

interface DiffPalette {
	addSoft: Style;
	addStrong: Style;
	delSoft: Style;
	delStrong: Style;
	fillAdd: Style;
	fillDel: Style;
	mapAdd: MapColor;
	mapDel: MapColor;
	mapChange: MapColor;
	mapContext: MapColor;
	mapHunk: MapColor;
	gutterAdd: Style;
	gutterDel: Style;
}

let paletteCache: { key: string; palette: DiffPalette } | undefined;

function palette(): DiffPalette {
	const added = theme.getColorHex("toolDiffAdded");
	const removed = theme.getColorHex("toolDiffRemoved");
	const accent = theme.getColorHex("accent");
	const luminance = theme.statusLineLuminance;
	const dark = luminance === undefined || luminance <= 0.5;
	const canvas = canvasHex();
	const text = textHex();
	const key = `${added}\u0000${removed}\u0000${accent}\u0000${dark}\u0000${canvas}\u0000${text}`;
	if (paletteCache?.key === key) return paletteCache.palette;
	const mapColor = (hex: string): MapColor => ({
		base: colorHex(hex),
		bright: colorHex(mixHex(hex, text, 0.25)),
	});
	const built: DiffPalette = {
		addSoft: bgStyle(mixHex(canvas, added, dark ? 0.18 : 0.24)),
		addStrong: bgStyle(mixHex(canvas, added, dark ? 0.42 : 0.48)),
		delSoft: bgStyle(mixHex(canvas, removed, dark ? 0.18 : 0.24)),
		delStrong: bgStyle(mixHex(canvas, removed, dark ? 0.42 : 0.48)),
		fillAdd: bgStyle(mixHex(canvas, added, 0.07)),
		fillDel: bgStyle(mixHex(canvas, removed, 0.07)),
		mapAdd: mapColor(added),
		mapDel: mapColor(removed),
		mapChange: mapColor(mixHex(added, removed, 0.5)),
		mapContext: mapColor(mixHex(canvas, text, 0.2)),
		mapHunk: mapColor(accent),
		gutterAdd: Style.of({ fg: colorHex(added) }),
		gutterDel: Style.of({ fg: colorHex(removed) }),
	};
	paletteCache = { key, palette: built };
	return built;
}

function ClippedRuns({ runs, width }: { runs: readonly StyledRun[]; width: number }): JSX.Element {
	const total = runsWidth(runs);
	if (total <= width) return <Runs runs={runs} />;
	let remaining = Math.max(0, width - 1);
	const shown: StyledRun[] = [];
	for (const run of runs) {
		if (remaining <= 0) break;
		const text = takeCells(run.text, remaining);
		if (text) shown.push({ style: run.style, text });
		remaining -= Bun.stringWidth(text);
	}
	return (
		<span>
			<Runs runs={shown} />
			<span style={Style.NONE}>…</span>
		</span>
	);
}

function TextSlice({
	text,
	start,
	width,
	base = Style.NONE,
	marks,
	strong,
	syntax,
}: {
	text: string;
	start: number;
	width: number;
	base?: Style;
	marks?: MarkRanges;
	strong?: Style;
	/** Parsed syntax-highlighter output for `text`, when coloring is ready. */
	syntax?: RichText;
}): JSX.Element {
	const end = start + width;
	const segments: Array<{ text: string; style: Style }> = [];
	let used = 0;
	let column = 0;
	const append = (source: string, sourceStyle: Style, from: number, to: number): void => {
		const shown = takeCells(skipCells(source, from), to - from);
		let shownColumn = column + from;
		let offset = 0;
		while (offset < shown.length) {
			const mark = marks?.find(([markFrom, markTo]) => shownColumn >= markFrom && shownColumn < markTo);
			const nextBoundary = mark
				? Math.min(to + column, mark[1])
				: Math.min(
						to + column,
						...(marks?.filter(([markFrom]) => markFrom > shownColumn).map(([markFrom]) => markFrom) ?? [
							to + column,
						]),
					);
			const piece = takeCells(shown.slice(offset), Math.max(1, nextBoundary - shownColumn));
			if (!piece) break;
			segments.push({ text: piece, style: sourceStyle.over(mark && strong ? strong : base) });
			const cells = Bun.stringWidth(piece);
			used += cells;
			shownColumn += cells;
			offset += piece.length;
		}
	};
	if (syntax) {
		const rowEnd = syntax.rowEnd[0] ?? 0;
		for (let index = syntax.rowStart(0); index < rowEnd && column < end; index++) {
			const run = syntax.text[index] ?? "";
			const runWidth = syntax.width[index] ?? 0;
			const runEnd = column + runWidth;
			const from = Math.max(start, column);
			const to = Math.min(end, runEnd);
			if (to > from) append(run, syntax.style[index] ?? Style.NONE, from - column, to - column);
			column = runEnd;
		}
	} else {
		const lineWidth = Bun.stringWidth(text);
		const from = Math.max(start, 0);
		const to = Math.min(end, lineWidth);
		if (to > from) append(text, Style.NONE, from, to);
	}
	return (
		<span style={base}>
			{segments.map((segment, index) => (
				<span key={index} style={segment.style}>
					{segment.text}
				</span>
			))}
			{" ".repeat(Math.max(0, width - used))}
		</span>
	);
}

// ── pane ─────────────────────────────────────────────────────────────────────

/** Placeholder states shown instead of a document. */
export type DiffPaneState = "empty" | "loading" | "streaming" | "asset" | "ready";

/** One rendered line of the current view. */
type Visual =
	| { t: "split"; row: DiffRow; seg: number; rowIndex: number }
	| { t: "line"; row: DiffRow; side: "old" | "new" | "both"; seg: number; rowIndex: number }
	| { t: "file"; index: number; seg: number; rowIndex: number }
	| { t: "header"; hunk: number }
	| { t: "blank" };

/** Incremental syntax-coloring state layered over an immutable document. */
interface SyntaxHighlights {
	readonly old: (RichText | undefined)[];
	readonly new: (RichText | undefined)[];
}

interface DisplayText {
	readonly text: string;
	readonly syntax: RichText | undefined;
}

/** Provisional complete lines exposed while native ingestion is active. */
interface StreamingDocument {
	readonly filePath: string;
	readonly oldLines: string[];
	readonly newLines: string[];
	stableCommonLines: number;
	maxLineWidth: number;
}
interface AssetDocument {
	readonly filePath: string;
	readonly old: FileAssetSide;
	readonly new: FileAssetSide;
}

/** Result of a left click inside the pane. */
export type PaneClick = { type: "hunk-action"; hunk: HunkBlock; action: HunkAction } | { type: "handled" } | null;

/**
 * Scrollable diff viewport. The root component feeds it key/mouse input and
 * composes its rendered lines into the frame.
 */
export class DiffPane {
	readonly #imageBudget: ImageBudget | undefined;
	#doc: DiffDocument | null = null;
	#docVersion = 0;
	#highlights: SyntaxHighlights | null = null;
	#streaming: StreamingDocument | null = null;
	#asset: AssetDocument | null = null;
	state: DiffPaneState = "empty";
	/** Message shown in the empty state. */
	emptyMessage = "No changes";
	mode: ViewMode = "split";
	wrap = false;
	/** Which hunk buttons apply: staging (unstaged), unstaging (staged), or none. */
	patchTarget: "stage" | "unstage" | null = null;
	selectedHunk = 0;
	scrollTop = 0;
	scrollLeft = 0;
	/** Pane holds keyboard focus: the cursor band renders at full strength (dimmed otherwise). */
	focused = false;
	/** Cursor as a visual-row index; navigation keys move it. */
	cursor = 0;
	/** Shift-selection anchor (visual-row index), or null when no selection. */
	anchor: number | null = null;
	#lastHeight = 1;
	#lastWidth = 0;
	#layoutCache: { key: string; visuals: Visual[] } | undefined;
	readonly #assetImages = new Map<string, ImagePaintState>();
	/** Per visible row: clickable hunk-button ranges retained for raw SGR fallback. */
	#hits: ({ hunk: number; primary?: [number, number]; discard?: [number, number] } | undefined)[] = [];
	/** Retained hunk controls dispatch their domain action directly. */
	onHunkAction: ((hunk: HunkBlock, action: HunkAction) => void) | undefined;
	constructor(imageBudget?: ImageBudget) {
		this.#imageBudget = imageBudget;
	}

	get doc(): DiffDocument | null {
		return this.#doc;
	}

	setDocument(doc: DiffDocument | null, state: DiffPaneState): void {
		this.#doc = doc;
		this.#docVersion++;
		this.#highlights = null;
		this.#streaming = null;
		this.#asset = null;
		this.state = state;
		this.scrollTop = 0;
		this.scrollLeft = 0;
		this.selectedHunk = 0;
		this.cursor = 0;
		this.anchor = null;
		if (doc && this.mode !== "file" && this.mode !== "hunk") {
			const visuals = this.#layout(this.#lastWidth || 80);
			const first = visuals.findIndex(visual => visualKind(visual) !== "context");
			if (first > 0) {
				this.cursor = first;
				this.scrollTop = clampScrollOffset(
					first - Math.floor(this.#lastHeight / 3),
					visuals.length,
					this.#lastHeight,
				);
			}
		}
	}
	/** Show media previews and safe placeholders for non-text Git objects. */
	setAsset(filePath: string, old: FileAssetSide, next: FileAssetSide): void {
		this.setDocument(null, "asset");
		this.#asset = { filePath, old, new: next };
	}

	/** Start a provisional file view while the native stream ingests both sides. */
	startStream(filePath: string): void {
		this.setDocument(null, "streaming");
		this.#streaming = { filePath, oldLines: [], newLines: [], stableCommonLines: 0, maxLineWidth: 0 };
	}

	/** Merge newly completed native-stream lines into the provisional viewport. */
	updateStream(update: FileStreamUpdate): void {
		const streaming = this.#streaming;
		if (!streaming) return;
		const oldLines = update.oldLines.map(sanitizeDisplayText);
		const newLines = update.newLines.map(sanitizeDisplayText);
		streaming.oldLines.splice(update.oldLineOffset, streaming.oldLines.length - update.oldLineOffset, ...oldLines);
		streaming.newLines.splice(update.newLineOffset, streaming.newLines.length - update.newLineOffset, ...newLines);
		for (const line of oldLines) streaming.maxLineWidth = Math.max(streaming.maxLineWidth, line.length);
		for (const line of newLines) streaming.maxLineWidth = Math.max(streaming.maxLineWidth, line.length);
		streaming.stableCommonLines = update.progress.stableCommonLines;
		this.#clampScroll();
	}

	/** Incrementally syntax-highlight the active document without blocking input. */
	async highlightAsync(signal: AbortSignal, notify: () => void): Promise<void> {
		const doc = this.#doc;
		if (!doc || signal.aborted) return;
		const language = getLanguageFromPath(doc.filePath);
		const oldStream = createHighlightStream(language);
		const newStream = createHighlightStream(language);
		if (!oldStream && !newStream) return;

		const highlights: SyntaxHighlights = {
			// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
			old: new Array(doc.oldDisplayLines.length),
			// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
			new: new Array(doc.newDisplayLines.length),
		};
		this.#highlights = highlights;
		let oldOffset = oldStream ? 0 : doc.oldDisplayLines.length;
		let newOffset = newStream ? 0 : doc.newDisplayLines.length;
		while (oldOffset < doc.oldDisplayLines.length || newOffset < doc.newDisplayLines.length) {
			if (signal.aborted || this.#doc !== doc) return;
			if (oldStream && oldOffset < doc.oldDisplayLines.length) {
				oldOffset = this.#highlightChunk(
					oldStream,
					doc.oldDisplayLines,
					doc.oldEndsNewline,
					highlights.old,
					oldOffset,
				);
			}
			if (newStream && newOffset < doc.newDisplayLines.length) {
				newOffset = this.#highlightChunk(
					newStream,
					doc.newDisplayLines,
					doc.newEndsNewline,
					highlights.new,
					newOffset,
				);
			}
			notify();
			if (oldOffset < doc.oldDisplayLines.length || newOffset < doc.newDisplayLines.length) await Bun.sleep(0);
		}
	}

	#highlightChunk(
		stream: HighlightStream,
		lines: readonly string[],
		endsNewline: boolean,
		highlights: (RichText | undefined)[],
		offset: number,
	): number {
		const end = Math.min(lines.length, offset + HIGHLIGHT_BATCH_LINES);
		const final = end === lines.length;
		const chunk = `${lines.slice(offset, end).join("\n")}${!final || endsNewline ? "\n" : ""}`;
		const rendered = stream.push(chunk).split("\n");
		if (chunk.endsWith("\n")) rendered.pop();
		for (let index = offset; index < end; index++) {
			const highlighted = rendered[index - offset] ?? lines[index] ?? "";
			if (!highlighted.includes("\x1b")) continue;
			const row = new RichText();
			parseAnsiRow(highlighted, row);
			row.br();
			highlights[index] = row;
		}
		return end;
	}

	setMode(mode: ViewMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.scrollTop = 0;
		this.scrollLeft = 0;
		this.cursor = 0;
		this.anchor = null;
	}

	cycleMode(): void {
		const order: ViewMode[] = ["split", "inline", "hunk", "file"];
		this.setMode(order[(order.indexOf(this.mode) + 1) % order.length]);
	}

	toggleWrap(): void {
		this.wrap = !this.wrap;
		this.scrollLeft = 0;
		this.#layoutCache = undefined;
	}

	// ── scrolling ──────────────────────────────────────────────────────────

	#total(): number {
		if (this.#doc) return this.#layout(this.#lastWidth || 80).length;
		return this.#streaming ? Math.max(this.#streaming.oldLines.length, this.#streaming.newLines.length) : 0;
	}

	#clampScroll(): void {
		this.scrollTop = clampScrollOffset(this.scrollTop, this.#total(), this.#lastHeight);
		const maxLineWidth = this.#doc?.maxLineWidth ?? this.#streaming?.maxLineWidth ?? 0;
		const maxLeft = this.wrap ? 0 : Math.max(0, maxLineWidth - 8);
		this.scrollLeft = Math.max(0, Math.min(this.scrollLeft, maxLeft));
	}

	setHeight(height: number): void {
		this.#lastHeight = Math.max(0, Math.trunc(height));
		this.#clampScroll();
	}

	scrollBy(delta: number): void {
		this.scrollTop += delta;
		this.#clampScroll();
	}

	pageBy(direction: 1 | -1): void {
		this.scrollBy(direction * Math.max(1, this.#lastHeight - 2));
	}

	scrollLeftBy(delta: number): void {
		this.scrollLeft += delta;
		this.#clampScroll();
	}
	/** Move the read-only cursor; `extend` grows the shift selection. */
	moveCursor(delta: number, extend: boolean): void {
		const total = this.#total();
		if (total === 0) return;
		if (extend) {
			if (this.anchor === null) this.anchor = this.cursor;
		} else {
			this.anchor = null;
		}
		this.cursor = Math.max(0, Math.min(total - 1, this.cursor + delta));
		this.scrollTop = scrollOffsetForRow(this.scrollTop, this.cursor, total, this.#lastHeight);
		this.#clampScroll();
	}

	/** Drop the shift selection. True when there was one. */
	clearSelection(): boolean {
		if (this.anchor === null) return false;
		this.anchor = null;
		return true;
	}

	/**
	 * Selected span as indices into `doc.rows` (shift selection, or the cursor
	 * row alone). Null when the cursor sits on rows that cannot map back to the
	 * document (hunk-view rows, headers).
	 */
	get selection(): { from: number; to: number; explicit: boolean } | null {
		if (!this.#doc) return null;
		const visuals = this.#layout(this.#lastWidth || 80);
		const a = this.anchor === null ? this.cursor : Math.min(this.anchor, this.cursor);
		const b = this.anchor === null ? this.cursor : Math.max(this.anchor, this.cursor);
		let from = Number.POSITIVE_INFINITY;
		let to = -1;
		for (let i = a; i <= b; i++) {
			const index = visualRowIndex(visuals[i]);
			if (index >= 0) {
				from = Math.min(from, index);
				to = Math.max(to, index);
			}
		}
		return to >= 0 ? { from, to, explicit: this.anchor !== null } : null;
	}

	/** Center the viewport on a visual row (minimap seek, hunk jump). */
	seekTo(row: number): void {
		const total = this.#total();
		this.scrollTop = scrollOffsetForRow(this.scrollTop, row, total, this.#lastHeight, "center");
		this.#clampScroll();
	}

	/** Jump to the next/previous hunk. False when already at the boundary. */
	jumpHunk(direction: 1 | -1): boolean {
		const doc = this.#doc;
		if (!doc || doc.hunks.length === 0) return false;
		const visuals = this.#layout(this.#lastWidth || 80);
		if (this.mode === "hunk") {
			const next = this.selectedHunk + direction;
			if (next < 0 || next >= doc.hunks.length) return false;
			this.#focusHunkHeader(next, visuals);
			return true;
		}
		// Other modes: jump between change blocks.
		const starts = this.#changeStarts(visuals);
		const reference = this.cursor;
		const next =
			direction > 0
				? starts.find(start => start > reference)
				: [...starts].reverse().find(start => start < reference);
		if (next === undefined) return false;
		this.#focusChange(next);
		return true;
	}

	/** Snap to the first/last hunk — the landing spot when hunk nav crosses files. */
	seekHunk(edge: "first" | "last"): void {
		const doc = this.#doc;
		if (!doc || doc.hunks.length === 0) return;
		const visuals = this.#layout(this.#lastWidth || 80);
		if (this.mode === "hunk") {
			this.#focusHunkHeader(edge === "first" ? 0 : doc.hunks.length - 1, visuals);
			return;
		}
		const starts = this.#changeStarts(visuals);
		if (starts.length === 0) return;
		this.#focusChange(edge === "first" ? starts[0] : starts[starts.length - 1]);
	}

	/** Move the cursor to the first/last visual row (home/end, `g`/`G`). */
	cursorToEdge(edge: "start" | "end"): void {
		const total = this.#total();
		if (total === 0) return;
		this.anchor = null;
		this.cursor = edge === "start" ? 0 : total - 1;
		this.scrollTop = scrollOffsetForRow(this.scrollTop, this.cursor, total, this.#lastHeight);
		this.#clampScroll();
	}

	/** Select a hunk in hunk view and scroll its header into view. */
	#focusHunkHeader(index: number, visuals: Visual[]): void {
		this.selectedHunk = index;
		const header = visuals.findIndex(visual => visual.t === "header" && visual.hunk === index);
		if (header >= 0) {
			this.cursor = header;
			this.anchor = null;
			this.scrollTop = clampScrollOffset(header - 1, visuals.length, this.#lastHeight);
			this.#clampScroll();
		}
	}

	/** First visual row of every change block, in document order. */
	#changeStarts(visuals: Visual[]): number[] {
		const starts: number[] = [];
		let inChange = false;
		for (let i = 0; i < visuals.length; i++) {
			const kind = this.#changeKind(visuals[i]);
			const changed = kind !== "context" && kind !== null;
			if (changed && !inChange) starts.push(i);
			inChange = changed;
		}
		return starts;
	}

	/** Like {@link visualKind}, but resolves file-view rows through the document. */
	#changeKind(visual: Visual): RowKind | "hunk" | null {
		if (visual.t === "file") {
			const row = visual.rowIndex >= 0 ? this.#doc?.rows[visual.rowIndex] : undefined;
			return row?.kind ?? "context";
		}
		return visualKind(visual);
	}

	/** Put the cursor on a change block and scroll it into the upper third. */
	#focusChange(row: number): void {
		this.cursor = row;
		this.anchor = null;
		this.scrollTop = clampScrollOffset(row - Math.floor(this.#lastHeight / 3), this.#total(), this.#lastHeight);
		this.#clampScroll();
	}

	/** Currently selected hunk (hunk view), if any. */
	get currentHunk(): HunkBlock | null {
		return this.#doc?.hunks[this.selectedHunk] ?? null;
	}

	// ── mouse ──────────────────────────────────────────────────────────────

	/** Handle a left click at pane-local coordinates. */
	clickAt(col: number, row: number, shift = false): PaneClick {
		if (this.#lastWidth > 0 && col >= this.#lastWidth - 2) {
			const total = this.#total();
			if (total > 0 && this.#lastHeight > 0) this.seekTo(Math.floor(((row + 0.5) / this.#lastHeight) * total));
			return { type: "handled" };
		}
		const hit = this.#hits[row];
		if (hit && this.#doc) {
			this.selectedHunk = hit.hunk;
			if (hit.primary && col >= hit.primary[0] && col < hit.primary[1] && this.patchTarget) {
				return { type: "hunk-action", hunk: this.#doc.hunks[hit.hunk], action: this.patchTarget };
			}
			if (hit.discard && col >= hit.discard[0] && col < hit.discard[1] && this.patchTarget === "stage") {
				return { type: "hunk-action", hunk: this.#doc.hunks[hit.hunk], action: "discard" };
			}
			return { type: "handled" };
		}
		const visual = this.scrollTop + row;
		if (visual < this.#total()) {
			if (shift) {
				if (this.anchor === null) this.anchor = this.cursor;
			} else {
				this.anchor = null;
			}
			this.cursor = visual;
			return { type: "handled" };
		}
		return null;
	}

	// ── layout ─────────────────────────────────────────────────────────────

	#splitTextWidth(width: number): number {
		const gutter = this.#doc?.gutterWidth ?? 4;
		// [gutterL][ textL ][│][gutterR][ textR ][minimap(2)]
		return Math.max(8, Math.floor((width - 2 * (gutter + 2) - 1 - 2) / 2));
	}

	#lineTextWidth(width: number): number {
		const gutter = this.#doc?.gutterWidth ?? 4;
		// [oldNum][newNum][ text ][minimap(2)]
		return Math.max(8, width - 2 * (gutter + 1) - 3);
	}

	#layout(width: number): Visual[] {
		const doc = this.#doc;
		if (!doc) return [];
		const key = `${this.#docVersion}\u0000${this.mode}\u0000${this.wrap}\u0000${width}`;
		if (this.#layoutCache?.key === key) return this.#layoutCache.visuals;
		const visuals: Visual[] = [];
		const segsFor = (textWidth: number, ...widths: number[]): number =>
			this.wrap ? Math.max(1, Math.ceil(Math.max(...widths, 1) / textWidth)) : 1;
		switch (this.mode) {
			case "split": {
				const textWidth = this.#splitTextWidth(width);
				doc.rows.forEach((row, rowIndex) => {
					const segs = segsFor(textWidth, row.oldWidth, row.newWidth);
					for (let seg = 0; seg < segs; seg++) visuals.push({ t: "split", row, seg, rowIndex });
				});
				break;
			}
			case "inline": {
				const textWidth = this.#lineTextWidth(width);
				doc.rows.forEach((row, rowIndex) => {
					if (row.kind === "change") {
						for (let seg = 0; seg < segsFor(textWidth, row.oldWidth); seg++)
							visuals.push({ t: "line", row, side: "old", seg, rowIndex });
						for (let seg = 0; seg < segsFor(textWidth, row.newWidth); seg++)
							visuals.push({ t: "line", row, side: "new", seg, rowIndex });
					} else {
						const side = row.kind === "del" ? "old" : row.kind === "add" ? "new" : "both";
						const rowWidth = side === "old" ? row.oldWidth : row.newWidth;
						for (let seg = 0; seg < segsFor(textWidth, rowWidth); seg++)
							visuals.push({ t: "line", row, side, seg, rowIndex });
					}
				});
				break;
			}
			case "hunk": {
				const textWidth = this.#lineTextWidth(width);
				doc.hunks.forEach((hunk, index) => {
					visuals.push({ t: "header", hunk: index });
					for (const row of hunk.rows) {
						if (row.kind === "change") {
							for (let seg = 0; seg < segsFor(textWidth, row.oldWidth); seg++)
								visuals.push({ t: "line", row, side: "old", seg, rowIndex: -1 });
							for (let seg = 0; seg < segsFor(textWidth, row.newWidth); seg++)
								visuals.push({ t: "line", row, side: "new", seg, rowIndex: -1 });
						} else {
							const side = row.kind === "del" ? "old" : row.kind === "add" ? "new" : "both";
							const rowWidth = side === "old" ? row.oldWidth : row.newWidth;
							for (let seg = 0; seg < segsFor(textWidth, rowWidth); seg++)
								visuals.push({ t: "line", row, side, seg, rowIndex: -1 });
						}
					}
					visuals.push({ t: "blank" });
				});
				break;
			}
			case "file": {
				const gutter = doc.gutterWidth;
				const textWidth = Math.max(8, width - gutter - 1 - 2 - 2);
				doc.fileLines.forEach((line, index) => {
					const rowIndex = doc.rowIndexByNewLine[index + 1] ?? -1;
					for (let seg = 0; seg < segsFor(textWidth, line.width); seg++)
						visuals.push({ t: "file", index, seg, rowIndex });
				});
				break;
			}
		}
		this.#layoutCache = { key, visuals };
		return visuals;
	}

	// ── view ───────────────────────────────────────────────────────────────

	viewNode(width: number, height: number = this.#lastHeight): JSX.Element {
		this.#lastWidth = Math.max(0, Math.trunc(width));
		this.#lastHeight = Math.max(0, Math.trunc(height));
		this.#hits = new Array(this.#lastHeight);
		if (this.state === "streaming" && this.#streaming) return this.#streamingView(this.#lastWidth, this.#lastHeight);
		if (this.state === "asset" && this.#asset) return this.#assetView(this.#lastWidth, this.#lastHeight);
		const doc = this.#doc;
		if (!doc || this.state !== "ready") {
			const message = this.state === "loading" ? "Loading diff…" : this.emptyMessage;
			const clipped =
				Bun.stringWidth(message) > this.#lastWidth
					? this.#lastWidth <= 1
						? "…"
						: `${takeCells(message, this.#lastWidth - 1)}…`
					: message;
			const left = spaces(Math.max(0, (this.#lastWidth - Bun.stringWidth(clipped)) >> 1));
			const messageNode = <span color="dim">{clipped}</span>;
			return (
				<stack>
					{Array.from({ length: this.#lastHeight }, (_, row) => (
						<text key={row} wrap="none">
							{row === Math.floor(this.#lastHeight / 2) ? (
								<span>
									{left}
									{messageNode}
								</span>
							) : (
								""
							)}
						</text>
					))}
				</stack>
			);
		}

		const visuals = this.#layout(this.#lastWidth);
		this.#clampScroll();
		const colors = palette();
		const selectFrom = this.anchor === null ? this.cursor : Math.min(this.anchor, this.cursor);
		const selectTo = this.anchor === null ? this.cursor : Math.max(this.anchor, this.cursor);
		const selectedFill = selectionStyle(!this.focused);
		const { start } = viewportRange(visuals.length, this.#lastHeight, this.scrollTop);
		const bodyWidth = Math.max(0, this.#lastWidth - 2);
		return (
			<stack>
				{Array.from({ length: this.#lastHeight }, (_, screenRow) => {
					const visualIndex = start + screenRow;
					const visual = visuals[visualIndex];
					const selected = visual !== undefined && visualIndex >= selectFrom && visualIndex <= selectTo;
					return (
						<row key={screenRow}>
							<text width={bodyWidth} wrap="clip" pad style={selected ? selectedFill : Style.NONE}>
								{visual ? this.#visualContent(visual, doc, this.#lastWidth, colors, screenRow) : ""}
							</text>
							<text width={1}> </text>
							<text width={1}>{this.#minimapCell(visuals, screenRow, this.#lastHeight, colors)}</text>
						</row>
					);
				})}
			</stack>
		);
	}

	#displayText(row: DiffRow, side: "old" | "new" | "both"): DisplayText {
		const actualSide = side === "old" || (side === "both" && row.newNum === undefined) ? "old" : "new";
		const number = actualSide === "old" ? row.oldNum : row.newNum;
		return {
			text: actualSide === "old" ? row.oldText : row.newText,
			syntax: number === undefined ? undefined : this.#highlights?.[actualSide][number - 1],
		};
	}

	#visualContent(
		visual: Visual,
		doc: DiffDocument,
		width: number,
		colors: DiffPalette,
		screenRow: number,
	): JSX.Element {
		switch (visual.t) {
			case "blank":
				return spaces(Math.max(0, width - 2));
			case "header":
				return this.#headerContent(visual.hunk, doc, width, screenRow);
			case "split": {
				const textWidth = this.#splitTextWidth(width);
				const startCol = this.wrap ? visual.seg * textWidth : this.scrollLeft;
				return (
					<span>
						{this.#sideContent(visual.row, "old", doc.gutterWidth, textWidth, colors, startCol, visual.seg === 0)}
						<span color="borderMuted">│</span>
						{this.#sideContent(visual.row, "new", doc.gutterWidth, textWidth, colors, startCol, visual.seg === 0)}
					</span>
				);
			}
			case "line":
				return this.#lineContent(visual, doc, width, colors);
			case "file": {
				const gutter = doc.gutterWidth;
				const textWidth = Math.max(8, width - gutter - 5);
				const startCol = this.wrap ? visual.seg * textWidth : this.scrollLeft;
				const text = doc.fileLines[visual.index]?.text ?? "";
				return (
					<span>
						<span color={visual.seg === 0 ? "dim" : undefined}>
							{visual.seg === 0 ? String(visual.index + 1).padStart(gutter) : spaces(gutter)}
						</span>{" "}
						<TextSlice
							text={text}
							start={startCol}
							width={textWidth}
							syntax={this.#highlights?.new[visual.index]}
						/>
					</span>
				);
			}
		}
	}

	#headerContent(hunkIndex: number, doc: DiffDocument, width: number, screenRow: number): JSX.Element {
		const hunk = doc.hunks[hunkIndex]!;
		const selected = this.mode === "hunk" && hunkIndex === this.selectedHunk;
		const bodyWidth = Math.max(0, width - 2);
		const prefix = selected ? "▶ " : "";
		const headerStyle = selected ? theme.style("accent").plus(Attr.Bold) : theme.style("accent");
		const patchTarget = this.patchTarget;
		if (patchTarget && doc.canPatch) {
			const primaryRuns =
				patchTarget === "stage"
					? pill(" Stage Hunk ", theme.getColorHex("toolDiffAdded"))
					: pill(" Unstage Hunk ", theme.getColorHex("warning"));
			const discardRuns =
				patchTarget === "stage" ? pill(" Discard Hunk ", theme.getColorHex("toolDiffRemoved")) : [];
			const primaryWidth = runsWidth(primaryRuns);
			const discardWidth = runsWidth(discardRuns);
			const total = primaryWidth + (discardWidth > 0 ? discardWidth + 1 : 0);
			const from = Math.max(0, bodyWidth - total);
			let cursor = from;
			let discard: [number, number] | undefined;
			if (discardWidth > 0) {
				discard = [cursor, cursor + discardWidth];
				cursor += discardWidth + 1;
			}
			this.#hits[screenRow] = { hunk: hunkIndex, primary: [cursor, cursor + primaryWidth], discard };
			return (
				<span>
					<span style={headerStyle}>
						{prefix}
						{hunk.header}
					</span>
					{spaces(Math.max(1, from - Bun.stringWidth(prefix) - Bun.stringWidth(hunk.header)))}
					{discardWidth > 0 ? (
						<span
							onMouse={event => {
								if (event.action !== "down" || event.button !== 0) return;
								event.stopPropagation();
								this.onHunkAction?.(hunk, "discard");
							}}
						>
							<Runs runs={discardRuns} />
						</span>
					) : null}
					{discardWidth > 0 ? " " : null}
					<span
						onMouse={event => {
							if (event.action !== "down" || event.button !== 0) return;
							event.stopPropagation();
							this.onHunkAction?.(hunk, patchTarget);
						}}
					>
						<Runs runs={primaryRuns} />
					</span>
				</span>
			);
		}
		this.#hits[screenRow] = { hunk: hunkIndex };
		return (
			<span style={headerStyle}>
				{prefix}
				{takeCells(hunk.header, Math.max(0, bodyWidth - Bun.stringWidth(prefix)))}
			</span>
		);
	}

	#lineContent(visual: Visual & { t: "line" }, doc: DiffDocument, width: number, colors: DiffPalette): JSX.Element {
		const { row, side, seg } = visual;
		const gutter = doc.gutterWidth;
		const textWidth = this.#lineTextWidth(width);
		const startCol = this.wrap ? seg * textWidth : this.scrollLeft;
		const first = seg === 0;
		const oldLabel =
			first && row.oldNum !== undefined && side !== "new" ? String(row.oldNum).padStart(gutter) : spaces(gutter);
		const newLabel =
			first && row.newNum !== undefined && side !== "old" ? String(row.newNum).padStart(gutter) : spaces(gutter);
		const isDel = side === "old" && row.kind !== "context";
		const isAdd = side === "new" && row.kind !== "context";
		const display = this.#displayText(row, side);
		const marks = side === "old" ? row.oldMarks : row.newMarks;
		const gutterNode = isDel ? (
			<span style={colors.gutterDel}>
				{oldLabel}
				{spaces(gutter + 1)}
			</span>
		) : isAdd ? (
			<span>
				{spaces(gutter)}
				<span style={colors.gutterAdd}>{newLabel}</span>{" "}
			</span>
		) : (
			<span color="dim">
				{oldLabel}
				{newLabel}{" "}
			</span>
		);
		if (!isDel && !isAdd) {
			return (
				<span>
					{gutterNode}{" "}
					<TextSlice text={display.text} start={startCol} width={textWidth} syntax={display.syntax} />{" "}
				</span>
			);
		}
		const soft = isDel ? colors.delSoft : colors.addSoft;
		const strong = isDel ? colors.delStrong : colors.addStrong;
		return (
			<span>
				{gutterNode}
				<span style={soft}>
					{" "}
					<TextSlice
						text={display.text}
						start={startCol}
						width={textWidth}
						base={soft}
						marks={row.kind === "change" ? marks : undefined}
						strong={strong}
						syntax={display.syntax}
					/>{" "}
				</span>
			</span>
		);
	}

	#sideContent(
		row: DiffRow,
		side: "old" | "new",
		gutter: number,
		textWidth: number,
		colors: DiffPalette,
		startCol: number,
		first: boolean,
	): JSX.Element {
		const number = side === "old" ? row.oldNum : row.newNum;
		const display = this.#displayText(row, side);
		const marks = side === "old" ? row.oldMarks : row.newMarks;
		const present = number !== undefined;
		const changed = row.kind === "change" || (side === "old" ? row.kind === "del" : row.kind === "add");
		const gutterStyle = changed ? (side === "old" ? colors.gutterDel : colors.gutterAdd) : theme.style("dim");
		const label = present && first ? String(number).padStart(gutter) : spaces(gutter);
		if (!present) {
			const tinted = row.kind === "add" || row.kind === "del";
			return (
				<span>
					<span>{label}</span>
					<span style={tinted ? (side === "old" ? colors.fillDel : colors.fillAdd) : Style.NONE}>
						{spaces(textWidth + 2)}
					</span>
				</span>
			);
		}
		if (!changed)
			return (
				<span>
					<span style={gutterStyle}>{label}</span>{" "}
					<TextSlice text={display.text} start={startCol} width={textWidth} syntax={display.syntax} />{" "}
				</span>
			);
		const soft = side === "old" ? colors.delSoft : colors.addSoft;
		const strong = side === "old" ? colors.delStrong : colors.addStrong;
		return (
			<span>
				<span style={gutterStyle}>{label}</span>
				<span style={soft}>
					{" "}
					<TextSlice
						text={display.text}
						start={startCol}
						width={textWidth}
						base={soft}
						marks={marks}
						strong={strong}
						syntax={display.syntax}
					/>{" "}
				</span>
			</span>
		);
	}

	#minimapCell(visuals: readonly Visual[], row: number, height: number, colors: DiffPalette): JSX.Element {
		const total = visuals.length;
		const bandKind = (band: number): RowKind | "hunk" | null => {
			const from = Math.floor((band * total) / (height * 2));
			const to = Math.max(from + 1, Math.floor(((band + 1) * total) / (height * 2)));
			if (from >= total) return null;
			let best: RowKind | "hunk" = "context";
			for (let index = from; index < Math.min(to, total); index++) {
				const kind = visualKind(visuals[index]);
				if (kind === "del") return "del";
				if (kind === "add") best = "add";
				else if (kind === "change" && best !== "add") best = "change";
				else if (kind === "hunk" && best === "context") best = "hunk";
			}
			return best;
		};
		const bandColor = (kind: RowKind | "hunk" | null, band: number): Color => {
			if (kind === null) return DEFAULT_COLOR;
			const pair =
				kind === "del"
					? colors.mapDel
					: kind === "add"
						? colors.mapAdd
						: kind === "change"
							? colors.mapChange
							: kind === "hunk"
								? colors.mapHunk
								: colors.mapContext;
			const docRow = Math.floor((band * total) / (height * 2));
			return docRow >= this.scrollTop && docRow < this.scrollTop + height ? pair.bright : pair.base;
		};
		const top = bandColor(bandKind(row * 2), row * 2);
		const bottom = bandColor(bandKind(row * 2 + 1), row * 2 + 1);
		return top === DEFAULT_COLOR && bottom === DEFAULT_COLOR ? (
			<span> </span>
		) : (
			<span style={Style.of({ fg: top === DEFAULT_COLOR ? bottom : top, bg: bottom })}>▀</span>
		);
	}

	#streamingView(width: number, height: number): JSX.Element {
		const streaming = this.#streaming;
		if (!streaming) return <stack />;
		const total = this.#total();
		if (total === 0) {
			return (
				<stack>
					{Array.from({ length: height }, (_, row) => (
						<text key={row} align={row === Math.floor(height / 2) ? "center" : "left"} color="dim">
							{row === Math.floor(height / 2) ? "Streaming file…" : ""}
						</text>
					))}
				</stack>
			);
		}
		this.#clampScroll();
		const gutter = Math.max(3, String(total).length);
		const { start } = viewportRange(total, height, this.scrollTop);
		return (
			<stack>
				{Array.from({ length: height }, (_, screenRow) => {
					const index = start + screenRow;
					if (index >= total) return <text key={screenRow} />;
					const oldText = streaming.oldLines[index];
					const newText = streaming.newLines[index];
					const selected = index === this.cursor ? selectionStyle(!this.focused) : Style.NONE;
					if (this.mode === "file") {
						const textWidth = Math.max(8, width - gutter - 1);
						return (
							<text key={screenRow} wrap="clip" pad style={selected}>
								<span color="dim">{String(index + 1).padStart(gutter)}</span>{" "}
								<TextSlice text={newText ?? ""} start={this.scrollLeft} width={textWidth} />
							</text>
						);
					}
					const textWidth = Math.max(8, Math.floor((width - 2 * (gutter + 1) - 1) / 2));
					return (
						<text key={screenRow} wrap="clip" pad style={selected}>
							<span color="dim">
								{oldText === undefined ? spaces(gutter) : String(index + 1).padStart(gutter)}
							</span>{" "}
							<TextSlice text={oldText ?? ""} start={this.scrollLeft} width={textWidth} />
							<span color="borderMuted">│</span>
							<span color="dim">
								{newText === undefined ? spaces(gutter) : String(index + 1).padStart(gutter)}
							</span>{" "}
							<TextSlice text={newText ?? ""} start={this.scrollLeft} width={textWidth} />
						</text>
					);
				})}
			</stack>
		);
	}

	#assetView(width: number, height: number): JSX.Element {
		const asset = this.#asset;
		if (!asset) return <stack />;
		const leftWidth = Math.max(1, Math.floor((width - 1) / 2));
		const rightWidth = Math.max(1, width - leftWidth - 1);
		const bodyHeight = Math.max(0, height - 1);
		return (
			<stack>
				<row>
					<text width={leftWidth} align="center" wrap="clip" bold>
						{this.#assetTitle("Before", asset.old)}
					</text>
					<text width={1} color="borderMuted">
						│
					</text>
					<text width={rightWidth} align="center" wrap="clip" bold>
						{this.#assetTitle("After", asset.new)}
					</text>
				</row>
				<row align="center">
					<box width={leftWidth}>
						{this.#assetSideView(asset.old, leftWidth, bodyHeight, `old:${asset.filePath}`)}
					</box>
					<stack width={1}>
						{Array.from({ length: bodyHeight }, (_, row) => (
							<text key={row} color="borderMuted">
								│
							</text>
						))}
					</stack>
					<box width={rightWidth}>
						{this.#assetSideView(asset.new, rightWidth, bodyHeight, `new:${asset.filePath}`)}
					</box>
				</row>
			</stack>
		);
	}

	#assetSideView(side: FileAssetSide, width: number, height: number, placementKey: string): JSX.Element {
		if (side.kind === "image") {
			const imageKey = `${placementKey}:${side.image.key}:${width}:${height}`;
			let image = this.#assetImages.get(imageKey);
			if (!image) {
				image = createImagePaintState({
					base64Data: side.image.data,
					mimeType: side.image.mimeType,
					theme: { fallbackStyle: theme.style("dim") },
					options: {
						maxWidthCells: Math.max(1, width - 2),
						maxHeightCells: height,
						filename: this.#asset?.filePath,
						budget: this.#imageBudget,
						imageKey: `git-review:${placementKey}:${side.image.key}`,
					},
					dimensions: { widthPx: side.image.widthPx, heightPx: side.image.heightPx },
				});
				this.#assetImages.set(imageKey, image);
			}
			return <image state={image} />;
		}
		let details: readonly string[];
		switch (side.kind) {
			case "empty":
				details = ["No file"];
				break;
			case "text":
				details = ["Text object", formatBytes(side.byteLength)];
				break;
			case "binary":
				details = [
					"Binary object",
					side.byteLength === undefined ? "Size unavailable" : formatBytes(side.byteLength),
				];
				break;
			case "tooLarge":
				details = [
					"Object too large to preview",
					side.byteLength === undefined ? "Exceeds preview limit" : formatBytes(side.byteLength),
				];
				break;
			case "lfsMissing":
				details = [
					"Git LFS object unavailable",
					`sha256:${side.oid.slice(0, 12)}… · ${formatBytes(side.byteLength)}`,
				];
				break;
		}
		return (
			<stack>
				{details.map((detail, index) => (
					<text key={index} align="center" wrap="clip" color="dim">
						{detail}
					</text>
				))}
			</stack>
		);
	}

	#assetTitle(label: string, side: FileAssetSide): string {
		let kind: string;
		let lfs = false;
		switch (side.kind) {
			case "empty":
				return label;
			case "image":
				kind =
					side.image.sourceMimeType === "image/svg+xml"
						? "SVG"
						: side.image.sourceMimeType.replace(/^image\//, "").toUpperCase();
				lfs = side.image.lfsOid !== undefined;
				break;
			case "text":
				kind = "Text";
				lfs = side.lfsOid !== undefined;
				break;
			case "binary":
				kind = "Binary";
				lfs = side.lfsOid !== undefined;
				break;
			case "tooLarge":
				kind = "Too large";
				lfs = side.lfsOid !== undefined;
				break;
			case "lfsMissing":
				kind = "LFS missing";
				lfs = true;
				break;
		}
		return `${label} · ${kind}${lfs ? " · Git LFS" : ""}`;
	}
}

/** Index into `doc.rows` a visual maps to, or -1 (headers, blanks, hunk rows). */
function visualRowIndex(visual: Visual | undefined): number {
	if (!visual) return -1;
	switch (visual.t) {
		case "split":
		case "line":
		case "file":
			return visual.rowIndex;
		default:
			return -1;
	}
}

function visualKind(visual: Visual): RowKind | "hunk" | null {
	switch (visual.t) {
		case "split":
			return visual.row.kind;
		case "line":
			return visual.row.kind === "change" ? (visual.side === "old" ? "del" : "add") : visual.row.kind;
		case "header":
			return "hunk";
		case "file":
			return "context";
		default:
			return null;
	}
}
