import { describe, expect, test } from "bun:test";
import { cursorPositions, isImageRow, replayCells, spliceRow } from "../src/core/frame";
import { Clip, Indent, Pad, over, pipe, Wrap } from "../src/core/out";
import { RichText, RunFlag } from "../src/core/richtext";
import { rgb, Style } from "../src/core/style";
import { emitRows } from "../src/core/emit";
import { cellGrid } from "./cell-grid";
import { DEFAULT_TAB_WIDTH } from "../src/utils";

function rows(rt: RichText): string[] {
	const out: string[] = [];
	for (let r = 0; r < rt.rows; r++) out.push(rt.rowText(r));
	return out;
}

describe("RichText row geometry", () => {
	// A markdown soft break once reached the terminal as a literal LF inside a
	// padded bubble row: the terminal moved down a line the engine did not know
	// about, and every later repaint drifted (duplicated headers in scrollback).
	test("a newline inside a pushed run breaks the row through the whole transform chain", () => {
		const rt = new RichText();
		const sink = new Indent(new Pad(rt, 12, Style.NONE), [Style.NONE, " "]);
		pipe(new Wrap(sink, 10), out => {
			out.push(Style.NONE, "add ARM64.\nCan you");
			out.br();
		});
		expect(rows(rt)).toEqual([" add ARM64. ", " Can you    "]);
		for (let r = 0; r < rt.rows; r++) expect(rt.rowWidth[r]).toBe(12);
	});

	test("tabs expand to fixed cells so measured width matches what the terminal draws", () => {
		const rt = new RichText();
		rt.push(Style.NONE, "a\tb");
		rt.br();
		expect(rt.rowText(0)).toBe(`a${" ".repeat(DEFAULT_TAB_WIDTH)}b`);
		expect(rt.rowWidth[0]).toBe(2 + DEFAULT_TAB_WIDTH);
	});

	test("zero-width bytes other than newline and tab pass through unchanged", () => {
		const rt = new RichText();
		rt.push(Style.NONE, "a\u0000b");
		rt.br();
		expect(rt.rowText(0)).toBe("a\u0000b");
		expect(rt.rowWidth[0]).toBe(2);
	});
});

describe("frame composition", () => {
	test("an explicit default overflow marker survives nested background fills", () => {
		const output = new RichText();
		const tinted = over(output, Style.of({ fg: rgb(10, 20, 30), bg: rgb(40, 50, 60) }));
		const clipped = new Clip(tinted, 4);
		clipped.ellipsisStyle = Style.RESET;
		pipe(clipped, sink => {
			sink.push(Style.NONE, "abcdef");
			sink.br();
		});
		const cells = cellGrid(emitRows(output, { mode: "truecolor" }), 4)[0]!;
		expect(cells.map(cell => cell.ch).join("")).toBe("abc…");
		expect(cells[0]!.bg).not.toBeNull();
		expect(cells[3]!.fg).toBeNull();
		expect(cells[3]!.bg).toBeNull();
	});
	test("splices overlay cells and pads its allocated band", () => {
		const base = new RichText();
		base.push(Style.NONE, "abcdefgh");
		base.br();
		const overlay = new RichText();
		overlay.push(Style.NONE, "XY");
		overlay.br();
		const composed = new RichText();

		spliceRow(composed, base, 0, overlay, 0, 2, 3, 8);
		composed.br();

		expect(composed.rowText(0)).toBe("abXY fgh");
		expect(composed.rowWidth[0]).toBe(8);
	});

	test("replays zero-width image control runs inside the selected row", () => {
		const source = new RichText();
		source.raw(Style.NONE, "placement", 0, RunFlag.Raw | RunFlag.Image);
		source.br();
		const replayed = new RichText();

		replayCells(replayed, source, 0, 0, 20);
		replayed.br();

		expect(replayed.text[0]).toBe("placement");
		expect(replayed.flags[0]! & RunFlag.Image).not.toBe(0);
	});

	test("does not split a wide grapheme at a replay boundary", () => {
		const source = new RichText();
		source.push(Style.NONE, "界a");
		source.br();
		const clipped = new RichText();

		const written = replayCells(clipped, source, 0, 0, 1);
		clipped.br();

		expect(written).toBe(0);
		expect(clipped.rowText(0)).toBe("");
	});

	test("keeps partial overlays off image rows and finds bottom-most cursor anchors first", () => {
		const base = new RichText();
		base.raw(Style.NONE, "image", 4, RunFlag.Raw | RunFlag.Image);
		base.br();
		base.push(Style.NONE, "ab");
		base.cursor();
		base.br();
		base.push(Style.NONE, "z");
		base.cursor();
		base.br();
		const overlay = new RichText();
		overlay.push(Style.NONE, "XX");
		overlay.br();
		const composed = new RichText();

		spliceRow(composed, base, 0, overlay, 0, 1, 2, 4);
		composed.br();

		expect(isImageRow(base, 0)).toBe(true);
		expect(isImageRow(base, 3)).toBe(false);
		expect(composed.flags[0]! & RunFlag.Image).not.toBe(0);
		expect(cursorPositions(base)).toEqual([
			{ row: 2, col: 1 },
			{ row: 1, col: 2 },
		]);
	});
});
