import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import { taskToolView, type TaskParams, type TaskToolDetails } from "../src/tools/task";

describe("nested task view", () => {
	it("renders parent and nested agent tasks", () => {
		const model = createToolCallModel<TaskParams, TaskToolDetails>({
			id: "task-nested",
			toolName: "task",
			label: "Task",
		});
		model.applyResult({
			content: [],
			details: {
				projectAgentsDir: null,
				totalDurationMs: 10,
				results: [
					{
						index: 0,
						id: "Parent",
						agent: "task",
						agentSource: "bundled",
						task: "Parent work",
						exitCode: 0,
						output: "done",
						stderr: "",
						truncated: false,
						durationMs: 10,
						tokens: 1,
						requests: 1,
						extractedToolData: {
							task: [
								{
									projectAgentsDir: null,
									totalDurationMs: 5,
									results: [
										{
											index: 0,
											id: "Child",
											agent: "task",
											agentSource: "bundled",
											task: "Child work",
											exitCode: 0,
											output: "done",
											stderr: "",
											truncated: false,
											durationMs: 5,
											tokens: 1,
											requests: 1,
										},
									],
								},
							],
						},
					},
				],
			},
		});
		const root = mountForTest(() => taskToolView.view(model), { width: 120 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("Parent");
			expect(text).toContain("Child");
			expect(text).toContain("Child work");
		} finally {
			root.dispose();
		}
	});
});
