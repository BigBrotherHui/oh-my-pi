import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import { taskToolView, type TaskParams, type TaskToolDetails } from "../src/tools/task";

describe("task isolation artifacts", () => {
	it("keeps patch, nested patch, and branch labels distinct", () => {
		const model = createToolCallModel<TaskParams, TaskToolDetails>({
			id: "task-artifacts",
			toolName: "task",
			label: "Task",
		});
		model.applyResult({
			content: [],
			details: {
				projectAgentsDir: null,
				totalDurationMs: 250,
				results: [
					{
						index: 0,
						id: "Worker",
						agent: "task",
						agentSource: "bundled",
						task: "Repair",
						exitCode: 0,
						output: "done",
						stderr: "",
						truncated: false,
						durationMs: 250,
						tokens: 0,
						requests: 0,
						patchPath: "/tmp/Worker.patch",
						nestedPatchPaths: ["/tmp/Worker.nested.patch"],
						branchName: "omp/task/Worker",
					},
				],
			},
		});
		const root = mountForTest(() => taskToolView.view(model), { width: 120 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("Patch:");
			expect(text).toContain("Nested patch:");
			expect(text).toContain("Branch:");
		} finally {
			root.dispose();
		}
	});
});
