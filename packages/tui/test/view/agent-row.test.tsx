import { afterEach, describe, expect, test } from "bun:test";
import { mountForTest, type TestRoot } from "../../src/testing";
import { AgentRow } from "../../src/view/agent-row";
import { cellGrid } from "../cell-grid";

const mounted: TestRoot[] = [];
afterEach(() => {
	for (const root of mounted.splice(0)) root.dispose();
});

function visibleRow(root: TestRoot, width: number): string {
	const grid = cellGrid(root.rows(), width);
	return (grid[0] ?? [])
		.map(cell => cell.ch)
		.join("")
		.trimEnd();
}

describe("AgentRow", () => {
	for (const width of [60, 100]) {
		test(`preserves status and id before shrinking trailing fields at ${width} columns`, () => {
			const root = mountForTest(
				() => (
					<AgentRow
						status="running"
						id="agent-42"
						role="integration-reviewer-with-a-long-role"
						model="openai-codex/gpt-5.6-with-a-long-model-name"
						detail="Investigating a deliberately long status detail that cannot fit in one terminal row"
					/>
				),
				{ width },
			);
			mounted.push(root);
			const grid = cellGrid(root.rows(), width);
			const row = visibleRow(root, width);
			expect(grid[0]?.[0]?.ch).not.toBe(" ");
			expect(row).toContain("agent-42");
			expect(row).toContain("…");
			expect(row).not.toContain(
				"Investigating a deliberately long status detail that cannot fit in one terminal row",
			);
			expect(grid[0]?.length).toBe(width);
		});
	}
});
