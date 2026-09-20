import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { TranscriptView } from "@oh-my-pi/pi-tui/chat/transcript-store";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { mountForTest } from "@oh-my-pi/pi-tui/testing";
import "@oh-my-pi/pi-tui/host/elements/box";
import "@oh-my-pi/pi-tui/host/elements/diff";
import "@oh-my-pi/pi-tui/host/elements/frame";
import "@oh-my-pi/pi-tui/host/elements/icon";
import "@oh-my-pi/pi-tui/host/elements/meta";
import "@oh-my-pi/pi-tui/host/elements/path";
import "@oh-my-pi/pi-tui/host/elements/preview";
import "@oh-my-pi/pi-tui/host/elements/row";
import "@oh-my-pi/pi-tui/host/elements/scroll";
import "@oh-my-pi/pi-tui/host/elements/span";
import "@oh-my-pi/pi-tui/host/elements/spinner";
import "@oh-my-pi/pi-tui/host/elements/stack";
import "@oh-my-pi/pi-tui/host/elements/status";
import "@oh-my-pi/pi-tui/host/elements/text";
import "@oh-my-pi/pi-tui/host/elements/transcript";
import "@oh-my-pi/pi-tui/host/elements/transcript-block";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

function assistantWithEdit(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "edit-stream-1", name: "edit", arguments: {} }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

describe("EventController streamed edit presentation", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("renders native edit previews before execution and settles the same streamed block", async () => {
		const ctx = createInteractiveModeContext();
		const controller = new EventController(ctx);
		const message = assistantWithEdit();
		const call = message.content[0];
		if (call?.type !== "toolCall") throw new Error("missing edit tool call");
		setStreamingPartialJson(call, '{"path":"src/demo.ts","old_string":"before","new_string":"after');
		const root = mountForTest(() => TranscriptView({ store: ctx.chatContainer }), { width: 100 });
		try {
			const streamStart = {
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
			} satisfies AgentSessionEvent;
			await controller.handleEvent(streamStart);

			const streamed = ctx.pendingTools.get(call.id);
			expect(streamed).toBeDefined();
			expect(streamed?.phase).toBe("receiving");
			root.flush();
			expect(root.text().join("\n")).toContain("after");

			// Message updates are cumulative and malformed prefixes can be replayed;
			// the call identity must retain one receiving transcript block.
			await controller.handleEvent(streamStart);
			expect(ctx.chatContainer.entries().filter(entry => entry.id === `tool:${call.id}`)).toHaveLength(1);

			await controller.handleEvent({
				type: "tool_stream_update",
				toolCallId: call.id,
				toolName: "edit",
				update: {
					generation: 1,
					streaming: true,
					editMode: "replace",
					files: [{ path: "src/demo.ts", diff: "@@ -1,1 +1,1 @@\n-before\n+after", firstChangedLine: 1 }],
				},
			} satisfies AgentSessionEvent);
			root.flush();
			expect(root.text().join("\n")).toContain("before");

			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: call.id,
				toolName: "edit",
				args: { path: "src/demo.ts", old_string: "before", new_string: "after" },
			} satisfies AgentSessionEvent);
			expect(ctx.pendingTools.get(call.id)).toBe(streamed);
			expect(streamed?.phase).toBe("running");

			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: call.id,
				toolName: "edit",
				result: {
					content: [{ type: "text", text: "edited" }],
					details: { path: "src/demo.ts", diff: "@@ -1,1 +1,1 @@\n-before\n+after" },
				},
			} satisfies AgentSessionEvent);
			root.flush();
			expect(ctx.pendingTools.has(call.id)).toBe(false);
			expect(root.text().join("\n")).toContain("after");
		} finally {
			root.dispose();
		}
	});
});
