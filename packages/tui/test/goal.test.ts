import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import { goalToolView, goalSummary, type GoalRenderArgs, type GoalToolDetails } from "../src/tools/goal";

describe("goal tool view", () => {
	it("keeps the historical creation row live while arguments stream", () => {
		const model = createToolCallModel<GoalRenderArgs, GoalToolDetails>({
			id: "goal-create",
			toolName: "goal",
			label: "goal",
		});
		model.applyArgsChunk({ op: "create", objective: "Draft the first release", token_budget: 10_000 });
		const root = mountForTest(() => goalToolView.view(model), { width: 100 });
		try {
			expect(root.text(100).join("\n")).toContain('Goal: set "Draft the first release" · budget 10K');

			model.applyArgsChunk({ objective: "Ship the reactive terminal rewrite" });
			model.markRunning();
			root.flush();
			const streaming = root.text(100).join("\n");
			expect(streaming).toContain('Goal: set "Ship the reactive terminal rewrite" · budget 10K');
			expect(streaming).not.toContain("Draft the first release");
			expect(goalSummary(model).status).toBe("running");
		} finally {
			root.dispose();
		}
	});

	it("preserves completed goal budget, elapsed time, report, and collapsed body", () => {
		const model = createToolCallModel<GoalRenderArgs, GoalToolDetails>({
			id: "goal-complete",
			toolName: "goal",
			label: "goal",
		});
		model.applyArgsChunk({ op: "complete" });
		model.applyResult({
			content: [{ type: "text", text: "Goal completed" }],
			details: {
				op: "complete",
				goal: {
					id: "g1",
					objective: "Ship reactive TUI rewrite",
					status: "complete",
					tokenBudget: 10_000,
					tokensUsed: 1250,
					timeUsedSeconds: 45,
					createdAt: 1000,
					updatedAt: 1045,
				},
				completionBudgetReport: "input 1,000\noutput 250",
			},
		});
		model.setUi({ expanded: false });
		const root = mountForTest(() => goalToolView.view(model), { width: 100 });
		try {
			const collapsed = root.text(100).join("\n");
			expect(collapsed).toContain("Goal: complete");
			expect(collapsed).toContain('"Ship reactive TUI rewrite"');
			expect(collapsed).toContain("1.3K / 10K tokens (8.8K left)");
			expect(collapsed).toContain("elapsed");
			expect(collapsed).toContain("Report");
			expect(collapsed).toContain("input 1,000");
			expect(collapsed).toContain("output 250");

			model.setUi({ expanded: true });
			root.flush();
			const expanded = root.text(100).join("\n");
			expect(expanded).toContain('"Ship reactive TUI rewrite"');
			expect(expanded).toContain("input 1,000");
			expect(goalSummary(model)).toEqual({
				label: "goal",
				detail: "complete: Ship reactive TUI rewrite",
				status: "success",
			});
		} finally {
			root.dispose();
		}
	});

	it("distinguishes errors, no active goal, and aborted calls", () => {
		const failed = createToolCallModel<GoalRenderArgs, GoalToolDetails>({
			id: "goal-failed",
			toolName: "goal",
			label: "goal",
		});
		failed.applyArgsChunk({ op: "create" });
		failed.applyResult({ content: [{ type: "text", text: "Error: goal budget rejected" }], isError: true });
		const failedRoot = mountForTest(() => goalToolView.view(failed), { width: 80 });
		try {
			const error = failedRoot.text(80).join("\n");
			expect(error).toContain("Goal: set");
			expect(error).toContain("goal budget rejected");
			expect(error).not.toContain("no active goal");
		} finally {
			failedRoot.dispose();
		}

		const absent = createToolCallModel<GoalRenderArgs, GoalToolDetails>({
			id: "goal-absent",
			toolName: "goal",
			label: "goal",
		});
		absent.applyArgsChunk({ op: "get" });
		absent.applyResult({ content: [{ type: "text", text: "" }], details: { op: "get", goal: null } });
		const absentRoot = mountForTest(() => goalToolView.view(absent), { width: 80 });
		try {
			const empty = absentRoot.text(80).join("\n");
			expect(empty).toContain("Goal: check");
			expect(empty).toContain("no active goal");
			expect(goalSummary(absent).status).toBe("warning");
		} finally {
			absentRoot.dispose();
		}

		const cancelled = createToolCallModel<GoalRenderArgs, GoalToolDetails>({
			id: "goal-cancelled",
			toolName: "goal",
			label: "goal",
		});
		cancelled.applyArgsChunk({ op: "drop" });
		cancelled.applyResult({ content: [{ type: "text", text: "" }], status: "cancelled" });
		const cancelledRoot = mountForTest(() => goalToolView.view(cancelled), { width: 24 });
		try {
			const aborted = cancelledRoot.text(24).join("\n");
			expect(aborted).toContain("Goal: drop");
			expect(aborted).not.toContain("no active goal");
			expect(goalSummary(cancelled).status).toBe("aborted");
		} finally {
			cancelledRoot.dispose();
		}
	});
});
