import { afterEach, describe, expect, test } from "bun:test";
import { mountForTest, type TestRoot } from "../src/testing";
import { AgentTreeRowView, type AgentTreeRowOptions } from "../src/tools/agent-tree";

const mounted: TestRoot[] = [];
afterEach(() => {
	for (const root of mounted.splice(0)) root.dispose();
});

function mountAgentRow(width: number, props: AgentTreeRowOptions): TestRoot {
	const root = mountForTest(() => <AgentTreeRowView {...props} />, { width });
	mounted.push(root);
	return root;
}

describe("AgentTreeRowView", () => {
	test("keeps completed eval metadata in the compact row", () => {
		const root = mountAgentRow(120, {
			presentation: "eval",
			status: "completed",
			prefix: "└─",
			id: "Scout",
			description: "Checked the changed files",
			role: "reviewer",
			stats: { toolCount: 3, requests: 2, contextTokens: 8000, contextWindow: 200000, cost: 0.42 },
			durationMs: 1500,
		});

		const lines = root.text();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Scout: Checked the changed files");
		expect(lines[0]).toContain("reviewer");
		expect(lines[0]).toContain("2 req");
		expect(lines[0]).toContain("$0.42");
	});

	test("moves an oversized task description beneath its status row with its tree continuation", () => {
		const root = mountAgentRow(34, {
			presentation: "task",
			status: "running",
			prefix: "├─",
			continuationPrefix: "│  ",
			id: "long-running-reviewer",
			description: "Restoring the original agent progress layout without losing details",
			role: "reviewer",
		});

		const lines = root.text();
		expect(lines[0]).toContain("long");
		expect(
			lines
				.slice(1)
				.map(line => line.slice("│  ".length).trim())
				.join(" "),
		).toContain("Restoring the original agent progress layout without losing details");
		expect(lines[1]).toStartWith("│  ");
	});

	test("retains terminal failure state and explicit retry label at narrow widths", () => {
		const root = mountAgentRow(46, {
			presentation: "eval",
			status: "aborted",
			prefix: "└─",
			id: "agent-with-a-long-name",
			statusBadge: "rate-limited",
			statusBadgeColor: "error",
			detail: "Waiting for provider quota",
		});

		const line = root.text().join("\n");
		expect(line).toContain("rate-limited");
		expect(line).toContain("agent");
	});
});
