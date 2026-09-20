import { afterEach, describe, expect, test } from "bun:test";
import { mountForTest, type TestRoot } from "../../src/testing";
import { cellGrid } from "../cell-grid";

const mounted: TestRoot[] = [];
afterEach(() => {
	for (const root of mounted.splice(0)) root.dispose();
});

function columnOf(row: readonly { readonly ch: string }[], text: string): number {
	return row.findIndex(cell => cell.ch === text);
}

describe("choice", () => {
	test("aligns every multiline label row after the choice glyph", () => {
		const width = 18;
		const root = mountForTest(
			() => (
				<choice kind="checkbox" checked>
					<text>alpha{"\n"}beta</text>
				</choice>
			),
			{ width },
		);
		mounted.push(root);
		const grid = cellGrid(root.rows(), width);
		expect(grid).toHaveLength(2);
		const firstLabelColumn = columnOf(grid[0] ?? [], "a");
		const continuationColumn = columnOf(grid[1] ?? [], "b");
		expect(firstLabelColumn).toBeGreaterThan(0);
		expect(continuationColumn).toBe(firstLabelColumn);
	});
});
