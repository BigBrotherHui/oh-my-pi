import { describe, expect, it } from "bun:test";
import { cellGrid, diffGrids, expectSameCells } from "./cell-grid";

const COLUMNS = 12;

describe("cell-grid harness", () => {
	it("returns no diff for terminal-identical rows", () => {
		const a = cellGrid(["same", "\x1b[32mgreen\x1b[39m"], COLUMNS);
		const b = cellGrid(["same", "\x1b[32mgreen\x1b[39m"], COLUMNS);
		expect(diffGrids(a, b)).toBeNull();
	});

	it("reports the physical row and column of a foreground change", () => {
		const a = cellGrid(["first", `ab\x1b[31mc\x1b[39m`], COLUMNS);
		const b = cellGrid(["first", `ab\x1b[34mc\x1b[39m`], COLUMNS);
		const diff = diffGrids(a, b);
		expect(diff).not.toBeNull();
		expect({ row: diff?.row, col: diff?.col }).toEqual({ row: 1, col: 2 });
		expect(diff?.rendering).toContain("          ^");
	});

	it("detects bold versus plain cells", () => {
		const diff = diffGrids(cellGrid(["\x1b[1mB\x1b[22m"], COLUMNS), cellGrid(["B"], COLUMNS));
		expect(diff?.row).toBe(0);
		expect(diff?.col).toBe(0);
		expect(diff?.a.attrs.bold).toBe(true);
		expect(diff?.b.attrs.bold).toBe(false);
	});

	it("detects different OSC 8 targets", () => {
		const a = cellGrid(["\x1b]8;;https://a.example\x07link\x1b]8;;\x07"], COLUMNS);
		const b = cellGrid(["\x1b]8;;https://b.example\x07link\x1b]8;;\x07"], COLUMNS);
		const diff = diffGrids(a, b);
		expect(diff?.row).toBe(0);
		expect(diff?.col).toBe(0);
		expect(diff?.a.link).toBe("https://a.example");
		expect(diff?.b.link).toBe("https://b.example");
	});

	it("ignores foreground-only trailing padding but retains background padding", () => {
		expectSameCells(["x\x1b[31m   \x1b[39m"], ["x"], COLUMNS);
		const diff = diffGrids(cellGrid(["x\x1b[41m \x1b[49m"], COLUMNS), cellGrid(["x"], COLUMNS));
		expect({ row: diff?.row, col: diff?.col }).toEqual({ row: 0, col: 1 });
	});
});
