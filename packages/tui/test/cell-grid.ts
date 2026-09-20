/**
 * Cell-grid assertions backed by a real VT parser.
 *
 * kitty-vt-wasm exposes bold, dim, italic, underline style (including
 * undercurl), strike, inverse, blink, and OSC 8 hyperlinks. Hidden and
 * overline are not exposed in its cell flags; underline colour is exposed by
 * the engine but intentionally absent from this harness's cell contract.
 */
import { CELL_U32, CellFlags, decodeColor, type Color as TerminalColor } from "kitty-vt-wasm";
import { VirtualTerminal } from "./virtual-terminal";

export { renderToRows as richRows } from "../src/testing";

export interface CellAttrs {
	readonly bold: boolean;
	readonly dim: boolean;
	readonly italic: boolean;
	/** 0 = none, 1 = straight, 2 = double, 3 = curly, 4 = dotted, 5 = dashed. */
	readonly underline: number;
	readonly strike: boolean;
	readonly inverse: boolean;
	readonly blink: boolean;
}

export interface Cell {
	readonly ch: string;
	readonly fg: TerminalColor;
	readonly bg: TerminalColor;
	readonly attrs: CellAttrs;
	readonly link?: string;
}

export type CellGrid = readonly (readonly Cell[])[];

export interface GridDiff {
	readonly row: number;
	readonly col: number;
	readonly a: Cell;
	readonly b: Cell;
	readonly rendering: string;
}

const DEFAULT_ATTRS: CellAttrs = {
	bold: false,
	dim: false,
	italic: false,
	underline: 0,
	strike: false,
	inverse: false,
	blink: false,
};

const DEFAULT_CELL: Cell = { ch: " ", fg: null, bg: null, attrs: DEFAULT_ATTRS };

function codePoint(words: Uint32Array, offset: number): string {
	const value = words[offset] ?? 0;
	return value === 0 ? "" : String.fromCodePoint(value);
}

function readCell(terminal: VirtualTerminal, words: Uint32Array, col: number): Cell {
	const offset = col * CELL_U32;
	const flags = words[offset + 6] ?? 0;
	const wideTrail = (flags & CellFlags.WIDE_TRAIL) !== 0;
	const base = codePoint(words, offset);
	const visibleBase = base === "" || base === " " || base === "\t" ? " " : base;
	const ch = wideTrail ? "" : `${visibleBase}${codePoint(words, offset + 1)}${codePoint(words, offset + 2)}`;
	const hyperlinkId = words[offset + 7] ?? 0;
	const link = hyperlinkId === 0 ? undefined : terminal.getHyperlinkTarget(hyperlinkId);
	return {
		ch,
		fg: decodeColor(words[offset + 3] ?? 0),
		bg: decodeColor(words[offset + 4] ?? 0),
		attrs: {
			bold: (flags & CellFlags.BOLD) !== 0,
			dim: (flags & CellFlags.DIM) !== 0,
			italic: (flags & CellFlags.ITALIC) !== 0,
			underline: (flags & CellFlags.UNDERLINE_MASK) >> CellFlags.UNDERLINE_SHIFT,
			strike: (flags & CellFlags.STRIKETHROUGH) !== 0,
			inverse: (flags & CellFlags.REVERSE) !== 0,
			blink: (flags & CellFlags.BLINK) !== 0,
		},
		...(link === undefined ? {} : { link }),
	};
}

function normalizeTrailingBlanks(row: Cell[]): void {
	let lastMeaningful = row.length - 1;
	while (lastMeaningful >= 0) {
		const cell = row[lastMeaningful]!;
		if (
			cell.ch !== " " ||
			cell.bg !== null ||
			cell.attrs.inverse ||
			cell.attrs.underline !== 0 ||
			cell.attrs.strike ||
			cell.link !== undefined
		)
			break;
		lastMeaningful--;
	}
	for (let col = lastMeaningful + 1; col < row.length; col++) row[col] = DEFAULT_CELL;
}

/** Render ANSI rows through a real VT parser and return their visible cells. */
export function cellGrid(rows: readonly string[], columns: number): CellGrid {
	if (!Number.isInteger(columns) || columns <= 0)
		throw new RangeError(`columns must be a positive integer, got ${columns}`);
	if (rows.length === 0) return [];
	const terminal = new VirtualTerminal(columns, rows.length, 0);
	for (let row = 0; row < rows.length; row++) terminal.write(`\x1b[${row + 1};1H${rows[row] ?? ""}`);

	const grid: Cell[][] = [];
	for (let row = 0; row < rows.length; row++) {
		const words = terminal.getViewportRowCells(row);
		if (words === null) throw new Error(`VirtualTerminal returned no cells for row ${row}`);
		const cells: Cell[] = new Array(columns);
		for (let col = 0; col < columns; col++) cells[col] = readCell(terminal, words, col);
		normalizeTrailingBlanks(cells);
		grid.push(cells);
	}
	return grid;
}

function sameColor(a: TerminalColor, b: TerminalColor): boolean {
	if (a === null || b === null) return a === b;
	if ("index" in a) return "index" in b && a.index === b.index;
	return "rgb" in b && a.rgb === b.rgb;
}

function sameCell(a: Cell, b: Cell): boolean {
	return (
		a.ch === b.ch &&
		sameColor(a.fg, b.fg) &&
		sameColor(a.bg, b.bg) &&
		a.attrs.bold === b.attrs.bold &&
		a.attrs.dim === b.attrs.dim &&
		a.attrs.italic === b.attrs.italic &&
		a.attrs.underline === b.attrs.underline &&
		a.attrs.strike === b.attrs.strike &&
		a.attrs.inverse === b.attrs.inverse &&
		a.attrs.blink === b.attrs.blink &&
		a.link === b.link
	);
}

function renderRow(row: readonly Cell[]): string {
	return row
		.map(cell => cell.ch)
		.join("")
		.replace(/ +$/, "");
}

function renderDiff(row: number, col: number, aRow: readonly Cell[], bRow: readonly Cell[], a: Cell, b: Cell): string {
	return [
		`cell mismatch at row ${row}, col ${col}`,
		`expected: ${renderRow(aRow)}`,
		`actual:   ${renderRow(bRow)}`,
		`          ${" ".repeat(col)}^`,
		`expected cell: ${JSON.stringify(a)}`,
		`actual cell:   ${JSON.stringify(b)}`,
	].join("\n");
}

/** Return the first physical cell difference, or null when both grids match. */
export function diffGrids(a: CellGrid, b: CellGrid): GridDiff | null {
	const rows = Math.max(a.length, b.length);
	for (let row = 0; row < rows; row++) {
		const aRow = a[row] ?? [];
		const bRow = b[row] ?? [];
		const columns = Math.max(aRow.length, bRow.length);
		for (let col = 0; col < columns; col++) {
			const aCell = aRow[col] ?? DEFAULT_CELL;
			const bCell = bRow[col] ?? DEFAULT_CELL;
			if (!sameCell(aCell, bCell)) {
				return { row, col, a: aCell, b: bCell, rendering: renderDiff(row, col, aRow, bRow, aCell, bCell) };
			}
		}
	}
	return null;
}

/** Assert terminal-cell identity between expected and actual ANSI rows. */
export function expectSameCells(expectedRows: readonly string[], actualRows: readonly string[], columns: number): void {
	const diff = diffGrids(cellGrid(expectedRows, columns), cellGrid(actualRows, columns));
	if (diff !== null) throw new Error(diff.rendering);
}
