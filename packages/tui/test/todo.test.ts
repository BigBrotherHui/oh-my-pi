import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import {
	todoToolView,
	todoSummary,
	phaseRomanNumeral,
	formatPhaseDisplayName,
	isClosedTodo,
	strikeRevealCount,
	TODO_STRIKE_HOLD_FRAMES,
	TODO_STRIKE_REVEAL_FRAMES,
	type TodoRenderArgs,
	type TodoToolDetails,
} from "../src/tools/todo";

describe("todo tool view and domain logic", () => {
	it("formats roman numerals correctly", () => {
		expect(phaseRomanNumeral(1)).toBe("I");
		expect(phaseRomanNumeral(2)).toBe("II");
		expect(phaseRomanNumeral(3)).toBe("III");
		expect(phaseRomanNumeral(4)).toBe("IV");
		expect(phaseRomanNumeral(5)).toBe("V");
		expect(phaseRomanNumeral(9)).toBe("IX");
		expect(phaseRomanNumeral(10)).toBe("X");
	});

	it("formats phase display names", () => {
		expect(formatPhaseDisplayName("Foundation", 1)).toBe("I. Foundation");
		expect(formatPhaseDisplayName("Architecture", 2)).toBe("II. Architecture");
	});

	it("identifies closed todos", () => {
		expect(isClosedTodo({ status: "completed" })).toBe(true);
		expect(isClosedTodo({ status: "abandoned" })).toBe(true);
		expect(isClosedTodo({ status: "in_progress" })).toBe(false);
		expect(isClosedTodo({ status: "pending" })).toBe(false);
		expect(isClosedTodo({ status: "blocked" })).toBe(false);
	});

	it("computes strike reveal counts based on animation frame", () => {
		const text = "Complete the task";
		expect(strikeRevealCount(text, undefined)).toBeUndefined();
		expect(strikeRevealCount(text, 0)).toBe(0);
		expect(strikeRevealCount(text, TODO_STRIKE_HOLD_FRAMES)).toBe(0);
		const midFrame = TODO_STRIKE_HOLD_FRAMES + Math.floor(TODO_STRIKE_REVEAL_FRAMES / 2);
		const midCount = strikeRevealCount(text, midFrame);
		expect(midCount).toBeDefined();
		expect(midCount!).toBeGreaterThan(0);
		expect(midCount!).toBeLessThan(text.length);
	});

	it("renders todo view via mountForTest", () => {
		const model = createToolCallModel<TodoRenderArgs, TodoToolDetails>({
			id: "todo-init",
			toolName: "todo",
			label: "Todo",
		});
		model.applyArgsChunk({ op: "init" });
		model.setUi({ expanded: true });
		model.applyResult({
			content: [{ type: "text", text: "Todo list initialized" }],
			details: {
				op: "init",
				storage: "session",
				phases: [
					{
						name: "Phase 1",
						tasks: [
							{ content: "Setup environment", status: "completed" },
							{ content: "Implement feature", status: "in_progress" },
							{ content: "Write tests", status: "pending" },
						],
					},
				],
			},
		});

		const root = mountForTest(() => todoToolView.view(model), { width: 80 });
		const rows = root.text(80);
		expect(rows.some(r => r.includes("Todo"))).toBe(true);
		expect(rows.some(r => r.includes("3 tasks"))).toBe(true);
		expect(rows.some(r => r.includes("I. Phase 1"))).toBe(false);
		expect(rows.some(r => r.includes("Setup environment"))).toBe(true);
		expect(rows.some(r => r.includes("Implement feature"))).toBe(true);
		expect(rows.some(r => r.includes("Write tests"))).toBe(true);
		root.dispose();
	});

	it("produces compact semantic summary", () => {
		const model = createToolCallModel<TodoRenderArgs, TodoToolDetails>({
			id: "todo-summary",
			toolName: "todo",
			label: "Todo",
		});
		model.applyArgsChunk({ op: "done", task: "Task 1" });
		model.applyResult({
			content: [{ type: "text", text: "Done" }],
			details: {
				op: "done",
				storage: "session",
				phases: [
					{
						name: "Build",
						tasks: [
							{ content: "Task 1", status: "completed" },
							{ content: "Task 2", status: "pending" },
						],
					},
				],
			},
		});

		const summary = todoSummary(model);
		expect(summary.label).toBe("todo");
		expect(summary.detail).toBe("done: 1/2 tasks");
		expect(summary.status).toBe("success");
	});
});
