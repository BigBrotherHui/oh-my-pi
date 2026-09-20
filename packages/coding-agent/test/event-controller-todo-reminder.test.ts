import { describe, expect, it } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

function reminder(attempt: number, content = "pending task"): Extract<AgentSessionEvent, { type: "todo_reminder" }> {
	return {
		type: "todo_reminder",
		todos: [{ content, status: "pending" }],
		attempt,
		maxAttempts: 3,
	};
}

describe("EventController todo reminder", () => {
	it("commits each reminder into durable chat history", async () => {
		const ctx = createInteractiveModeContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(reminder(1, "old task"));
		expect(ctx.chatContainer.entries()).toHaveLength(1);

		// A second reminder is a distinct escalation, committed as its own block —
		// not merged into or replacing the first.
		await controller.handleEvent(reminder(2, "new task"));
		const entries = ctx.chatContainer.entries();
		expect(entries).toHaveLength(2);
		expect(entries[0]!.view).not.toBe(entries[1]!.view);
	});

	it("leaves committed reminders untouched when a todo tool succeeds", async () => {
		const ctx = createInteractiveModeContext();
		const controller = new EventController(ctx);
		const phases = [{ name: "Implementation", tasks: [{ content: "done task", status: "completed" as const }] }];

		await controller.handleEvent(reminder(1));
		expect(ctx.chatContainer.entries()).toHaveLength(1);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-1",
			toolName: "todo",
			isError: false,
			result: { content: [{ type: "text", text: "" }], details: { phases } },
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		// The reminder stays in history (no retroactive removal); only the sticky
		// HUD updates via setTodos.
		expect(ctx.chatContainer.entries()).toHaveLength(1);
		expect(ctx.setTodos).toHaveBeenCalledWith(phases);
	});

	it("does not reveal a dismissed HUD for a read-only todo view", async () => {
		const ctx = createInteractiveModeContext();
		const controller = new EventController(ctx);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-view",
			toolName: "todo",
			isError: false,
			result: {
				content: [{ type: "text", text: "Done" }],
				details: {
					op: "view",
					phases: [{ name: "Done", tasks: [{ content: "ship", status: "completed" }] }],
				},
			},
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		expect(ctx.setTodos).not.toHaveBeenCalled();
		await controller.handleEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "todo",
				toolCallId: "todo-view",
				content: [],
				isError: false,
				timestamp: 1,
				details: { op: "view", phases: [{ name: "Done", tasks: [{ content: "ship", status: "completed" }] }] },
			},
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		expect(ctx.setTodos).not.toHaveBeenCalled();
	});
});
