import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "../../src/reactive";
import { mountForTest, type TestRoot } from "../../src/testing";
import { ToolCard } from "../../src/view/tool-card";
import { cellGrid } from "../cell-grid";

const mounted: TestRoot[] = [];
afterEach(() => {
	for (const root of mounted.splice(0)) root.dispose();
});

describe("ToolCard", () => {
	test("phase tint fills content and both border rows", () => {
		const width = 36;
		const root = mountForTest(
			() => (
				<ToolCard phase="running" framed expanded header={<text>Shell</text>}>
					<stack>
						<text>first row</text>
						<text>second row</text>
					</stack>
				</ToolCard>
			),
			{ width },
		);
		mounted.push(root);
		const grid = cellGrid(root.rows(), width);
		expect(grid.length).toBeGreaterThanOrEqual(4);
		const tint = grid[0]?.[0]?.bg;
		expect(tint).not.toBeNull();
		for (const row of grid) {
			for (const cell of row) expect(cell.bg).toEqual(tint);
		}
	});

	test("keeps a self-bounded preview visible when no separate compact summary exists", () => {
		const [message, setMessage] = createSignal("partial edit");
		const root = mountForTest(() => (
			<ToolCard phase="running" expanded={false} header={<text>Edit</text>}>
				<text>{message()}</text>
			</ToolCard>
		));
		mounted.push(root);
		expect(root.text().join("\n")).toContain("partial edit");
		setMessage("complete diff");
		expect(root.text().join("\n")).toContain("complete diff");
		expect(root.text().join("\n")).not.toContain("partial edit");
	});

	test("expanded selects details while collapsed selects the summary", () => {
		const [expanded, setExpanded] = createSignal(false);
		const root = mountForTest(
			() => (
				<ToolCard
					phase="settled"
					outcome="success"
					framed={false}
					expanded={expanded()}
					summary={<text>summary</text>}
				>
					<text>details</text>
				</ToolCard>
			),
			{ width: 30 },
		);
		mounted.push(root);
		expect(root.text().join("\n")).toContain("summary");
		expect(root.text().join("\n")).not.toContain("details");
		setExpanded(true);
		root.flush();
		expect(root.text().join("\n")).toContain("details");
		expect(root.text().join("\n")).not.toContain("summary");
	});
});
