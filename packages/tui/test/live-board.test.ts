import { describe, expect, test } from "bun:test";
import type { AgentProgress } from "../src/tools/task";
import {
	CleanseBoardModel,
	CleanseBoardView,
	createCleanseStatusBoard,
	type CleanseAssignment,
} from "../src/apps/cleanse-board";
import { dispatchKey, HostKeyEvent } from "../src/host/input";
import { mountForTest } from "../src/testing";
import { visibleWidth } from "../src/utils";

const assignment: CleanseAssignment = {
	index: 2,
	groups: [{ file: "src/first.ts" }, { file: "src/second.ts" }],
	weight: 3,
};

function runningProgress(): AgentProgress {
	return {
		index: 2,
		id: "agent-2",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Repair diagnostics",
		recentTools: [],
		recentOutput: [],
		toolCount: 2,
		requests: 1,
		tokens: 1_234,
		cost: 0.012,
		durationMs: 10,
	};
}

describe("cleanse board", () => {
	test("shares reactive live state and promotes completed agents to permanent rows", () => {
		const model = new CleanseBoardModel();
		model.phase("Resolving model @smol...");
		model.checkerStarted({ id: "typecheck", label: "TypeScript" });
		model.agentStarted("CleanseA2", assignment);
		model.agentProgress("CleanseA2", runningProgress());

		const running = model.snapshot();
		expect(running.phaseText).toBe("Resolving model @smol...");
		expect(running.checkers.get("typecheck")?.label).toBe("TypeScript");
		expect(running.agents.get("CleanseA2")?.assignment).toBe(assignment);
		expect(running.agents.get("CleanseA2")?.progress?.toolCount).toBe(2);
		expect(running.totals.get("CleanseA2")).toEqual({ tokens: 1_234, cost: 0.012 });
		expect(running.repairTotal).toBe(1);

		model.checkerFinished({ id: "typecheck", label: "TypeScript", diagnostics: [] });
		const completion = model.agentFinished({ name: "CleanseA2", success: true }, assignment);
		const completed = model.snapshot();
		expect(completion.agent?.assignment).toBe(assignment);
		expect(completion.total).toEqual({ tokens: 1_234, cost: 0.012 });
		expect(completion.durationMs).toBeGreaterThanOrEqual(0);
		expect(completed.checkers.size).toBe(0);
		expect(completed.agents.size).toBe(0);
		expect(completed.repairDone).toBe(1);

		model.repairFinished();
		const settled = model.snapshot();
		expect(settled.repairTotal).toBe(0);
		expect(settled.repairDone).toBe(0);
		expect(model.hasLiveRows()).toBe(true);
		model.phase("");
		expect(model.hasLiveRows()).toBe(false);
		model.phase(undefined);
	});

	test("renders retained live progress and promotes settled rows before root teardown", () => {
		const model = new CleanseBoardModel();
		let cancelled = 0;
		const root = mountForTest(
			() =>
				CleanseBoardView({
					model,
					onCancel: () => {
						cancelled += 1;
					},
				}),
			{ width: 80 },
		);
		try {
			model.phase("Detecting configured project checkers...");
			model.checkerStarted({ id: "lint", label: "Lint" });
			model.agentStarted("CleanseA2", assignment);
			model.agentProgress("CleanseA2", runningProgress());
			root.flush();

			const live = root.text().join("\n");
			expect(live).toContain("Detecting configured project checkers...");
			expect(live).toContain("Lint");
			expect(live).toContain("Repairing");
			expect(live).toContain("A2 src/first.ts +1");
			dispatchKey(root.root, new HostKeyEvent("\x1b"));
			expect(cancelled).toBe(1);

			model.checkerFinished({ id: "lint", label: "Lint", diagnostics: [{ message: "failure" }] }, 1_000);
			model.agentFinished({ name: "CleanseA2", success: true }, assignment);
			model.repairFinished();
			model.close();
			root.flush();

			const settled = root.text().join("\n");
			expect(settled).toContain("1 issue");
			expect(settled).toContain("src/first.ts +1");
		} finally {
			root.dispose();
		}
	});

	test("wraps wide agent failures through the native row without discarding text", () => {
		const model = new CleanseBoardModel();
		model.agentStarted("CleanseA2", assignment);
		model.agentFinished({ name: "CleanseA2", success: false, error: "界".repeat(300) }, assignment);
		const root = mountForTest(() => CleanseBoardView({ model }), { width: 40 });
		try {
			expect(root.text().join("\n")).toContain("界");
			for (const row of root.rows()) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
		} finally {
			root.dispose();
		}
	});

	test("keeps the CLI protocol plain when no retained terminal is supplied", () => {
		const output: string[] = [];
		const errors: string[] = [];
		const board = createCleanseStatusBoard(
			{ isTTY: true, write: text => output.push(text) },
			{ isTTY: true, write: text => errors.push(text) },
		);
		board.phase("Detecting configured project checkers...");
		board.checkerStarted({ id: "lint", label: "Lint" });
		board.checkerFinished({ id: "lint", label: "Lint", diagnostics: [{ message: "failure" }] }, 1_000);
		board.agentStarted("CleanseA2", assignment);
		board.agentFinished({ name: "CleanseA2", success: true, resolvedModel: "test/model" }, assignment);
		board.agentFinished({ name: "CleanseA3", success: false, error: "repair failed" }, assignment);
		board.close();

		expect(board.interactive).toBe(false);
		expect(output.join("")).toContain("Detecting configured project checkers...\n");
		expect(output.join("")).toContain("● Lint 1 issue ·");
		expect(output.join("")).toContain("[start] CleanseA2: src/first.ts, src/second.ts (weight 3)\n");
		expect(output.join("")).toContain("[done] CleanseA2 (test/model)\n");
		expect(errors).toEqual(["[fail] CleanseA3: repair failed\n"]);
	});
});
