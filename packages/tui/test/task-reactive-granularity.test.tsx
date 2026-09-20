import { afterEach, describe, expect, it } from "bun:test";
import { mountForTest, type TestRoot } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import { taskToolView, type TaskParams, type TaskToolDetails } from "../src/tools/task";
import { getThemeByName, setThemeInstance } from "../src/theme/theme";

const mountedRoots: TestRoot[] = [];
afterEach(() => {
	for (const root of mountedRoots.splice(0)) {
		root.dispose();
	}
});

describe("task reactive granularity and keyed entities", () => {
	it("token-count patch updates in place without recreating agent rows", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);

		const model = createToolCallModel<TaskParams, TaskToolDetails>({
			id: "call-1",
			toolName: "task",
			label: "task",
		});

		model.applyResult(
			{
				content: [],
				details: {
					projectAgentsDir: null,
					totalDurationMs: 100,
					results: [
						{
							index: 0,
							id: "Worker-Alpha",
							agent: "task",
							agentSource: "bundled",
							task: "Process chunk 1",
							exitCode: 0,
							output: "done",
							stderr: "",
							truncated: false,
							durationMs: 100,
							tokens: 500,
							requests: 1,
						},
					],
				},
			},
			{ partial: true },
		);

		const root = mountForTest(() => taskToolView.view(model), { width: 120, theme });
		mountedRoots.push(root);
		root.flush();

		const initialText = root.text().join("\n");
		expect(initialText).toContain("Worker-Alpha");
		expect(initialText).toContain("Process chunk 1");

		const initialNodesCreated = root.counters().nodesCreated;

		// Patch token count and cost without changing agent identity
		model.applyResult(
			{
				content: [],
				details: {
					projectAgentsDir: null,
					totalDurationMs: 150,
					results: [
						{
							index: 0,
							id: "Worker-Alpha",
							agent: "task",
							agentSource: "bundled",
							task: "Process chunk 1",
							exitCode: 0,
							output: "done",
							stderr: "",
							truncated: false,
							durationMs: 150,
							tokens: 9500,
							requests: 2,
						},
					],
				},
			},
			{ partial: true },
		);

		root.flush();

		// Nodes must NOT be recreated for the existing agent row
		expect(root.counters().nodesCreated).toBe(initialNodesCreated);
		const updatedText = root.text().join("\n");
		expect(updatedText).toContain("Worker-Alpha");
		expect(updatedText).toContain("Process chunk 1");
	});

	it("renders nested tasks in tree structure and freezes elapsed at settle", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);

		const model = createToolCallModel<TaskParams, TaskToolDetails>({
			id: "call-2",
			toolName: "task",
			label: "task",
		});

		model.applyResult(
			{
				content: [],
				details: {
					projectAgentsDir: null,
					totalDurationMs: 500,
					results: [
						{
							index: 0,
							id: "ParentAgent",
							agent: "task",
							agentSource: "bundled",
							task: "Parent task",
							exitCode: 0,
							output: "done",
							stderr: "",
							truncated: false,
							durationMs: 500,
							tokens: 1000,
							requests: 1,
							extractedToolData: {
								task: [
									{
										projectAgentsDir: null,
										totalDurationMs: 250,
										results: [
											{
												index: 0,
												id: "ChildAgent",
												agent: "task",
												agentSource: "bundled",
												task: "Child subtask",
												exitCode: 0,
												output: "child done",
												stderr: "",
												truncated: false,
												durationMs: 250,
												tokens: 500,
												requests: 1,
											},
										],
									},
								],
							},
						},
					],
				},
			},
			{ partial: false },
		);

		// Freeze at settle
		model.freeze(1000);

		const root = mountForTest(() => taskToolView.view(model), { width: 120, theme });
		mountedRoots.push(root);
		root.flush();

		const text = root.text().join("\n");
		expect(text).toContain("ParentAgent");
		expect(text).toContain("ChildAgent");
		expect(text).toContain("Parent task");
		expect(text).toContain("Child subtask");
	});
});
