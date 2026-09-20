import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import { taskToolView, type TaskParams, type TaskToolDetails } from "../src/tools/task";

describe("task progress view", () => {
	it("shows a live agent's description and request statistics", () => {
		const model = createToolCallModel<TaskParams, TaskToolDetails>({
			id: "task-progress",
			toolName: "task",
			label: "Task",
		});
		model.markRunning();
		model.applyResult(
			{
				content: [],
				details: {
					projectAgentsDir: null,
					totalDurationMs: 100,
					results: [],
					progress: [
						{
							index: 0,
							id: "Scout",
							agent: "scout",
							agentSource: "bundled",
							status: "running",
							task: "Inspect",
							description: "Inspect the renderer",
							recentTools: [],
							recentOutput: [],
							toolCount: 2,
							requests: 3,
							tokens: 100,
							cost: 0.25,
							durationMs: 100,
						},
					],
				},
			},
			{ partial: true },
		);
		const root = mountForTest(() => taskToolView.view(model), { width: 120 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("Scout");
			expect(text).toContain("Inspect the renderer");
			expect(text).toContain("3 req");
		} finally {
			root.dispose();
		}
	});
});
