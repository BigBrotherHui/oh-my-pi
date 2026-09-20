import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import { taskToolView, type TaskParams, type TaskToolDetails } from "../src/tools/task";

describe("task tool call view", () => {
	it("renders streamed context and every assigned agent", () => {
		const model = createToolCallModel<TaskParams, TaskToolDetails>({
			id: "task-call",
			toolName: "task",
			label: "Task",
		});
		model.applyArgsChunk({
			context: "Inspect the reactive renderer.",
			tasks: [
				{ name: "Scanner", agent: "scout", task: "Map the tree" },
				{ name: "Worker", task: "Repair the test" },
			],
		});
		const root = mountForTest(() => taskToolView.view(model), { width: 100 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("Inspect the reactive renderer.");
			expect(text).toContain("Scanner");
			expect(text).toContain("Worker");
		} finally {
			root.dispose();
		}
	});
});
