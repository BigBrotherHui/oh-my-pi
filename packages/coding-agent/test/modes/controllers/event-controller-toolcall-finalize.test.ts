import { beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { TranscriptView } from "@oh-my-pi/pi-tui/chat/transcript-store";
import { mountForTest } from "@oh-my-pi/pi-tui/testing";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "task-replay", name: "task", arguments: { task: "inspect" } }],
	api: "openai-responses",
	provider: "openai",
	model: "test",
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

describe("EventController replayed tool routing", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	for (const incremental of [false, true]) {
		it(`restores paused prose and tool previews after ${incremental ? "incremental" : "synchronous"} replay without duplication`, async () => {
			const partial: AssistantMessage = {
				...assistant,
				content: [
					{ type: "text", text: "Paused response" },
					{ type: "toolCall", id: "read-paused", name: "read", arguments: { path: "paused.txt" } },
				],
			};
			const ctx = createInteractiveModeContext({ session: { isStreaming: true } });
			ctx.viewSession.agent.state.streamMessage = partial;
			const controller = new EventController(ctx);
			ctx.eventController = controller;
			const helpers = new UiHelpers(ctx);
			const mounted = mountForTest(() => TranscriptView({ store: ctx.chatContainer }), { width: 100 });
			try {
				await controller.handleEvent({
					type: "message_update",
					message: partial,
					assistantMessageEvent: { type: "start", partial },
				});
				expect(mounted.text().join("\n")).toContain("Paused response");
				controller.resetTranscriptAnchors();
				ctx.chatContainer.clear();
				ctx.pendingTools.clear();
				const context: SessionContext = { messages: [], models: {}, injectedTtsrRules: [], mode: "none" };
				if (incremental) await helpers.renderSessionContextIncrementally(context);
				else helpers.renderSessionContext(context);
				const restored = mounted.text().join("\n");
				expect(restored).toContain("Paused response");
				expect(restored).toContain("paused.txt");
				ctx.viewSession.agent.state.streamMessage = null;
				await controller.handleEvent({ type: "message_end", message: partial });
				const settled = mounted.text().join("\n");
				expect(settled.split("Paused response").length - 1).toBe(1);
				expect(settled.split("paused.txt").length - 1).toBe(1);
			} finally {
				controller.dispose();
				mounted.dispose();
			}
		});
	}
});
