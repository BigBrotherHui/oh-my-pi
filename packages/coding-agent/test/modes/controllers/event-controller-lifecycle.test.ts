import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BusyView } from "@oh-my-pi/pi-coding-agent/modes/components/reactive-controller-views";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { createReactionTarget } from "@oh-my-pi/pi-tui/chat/reaction";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

function userMessage(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		attribution: "user" as const,
		timestamp: Date.now(),
	};
}

describe("EventController turn lifecycle", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("renders a submitted user message once across optimistic, start, and end events", async () => {
		const clearOptimisticUserMessage = vi.fn();
		const addMessageToChat = vi.fn();
		const message = userMessage("hi");
		const ctx = createInteractiveModeContext({ clearOptimisticUserMessage, addMessageToChat });
		const controller = new EventController(ctx);
		const signature = "hi\u00000";
		ctx.optimisticUserMessageSignature = signature;
		ctx.locallySubmittedUserSignatures.add(signature);

		await controller.handleEvent({ type: "message_start", message } as AgentSessionEvent);
		await controller.handleEvent({ type: "message_end", message } as AgentSessionEvent);

		expect(clearOptimisticUserMessage).toHaveBeenCalledTimes(1);
		expect(addMessageToChat).not.toHaveBeenCalled();
		expect(ctx.locallySubmittedUserSignatures.has(signature)).toBe(false);
	});

	it("does not append a non-optimistic user message again at message_end", async () => {
		const addMessageToChat = vi.fn();
		const ctx = createInteractiveModeContext({ addMessageToChat });
		const controller = new EventController(ctx);
		const message = userMessage("hello");

		await controller.handleEvent({ type: "message_start", message } as AgentSessionEvent);
		await controller.handleEvent({ type: "message_end", message } as AgentSessionEvent);

		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(addMessageToChat).toHaveBeenCalledWith(message);
	});

	it("removes the retained working row for normal, failed, and aborted terminal turns", async () => {
		for (const stopReason of ["stop", "error", "aborted"] as const) {
			const markActivityEnd = vi.fn();
			const ctx = createInteractiveModeContext({ statusLine: { markActivityEnd } });
			const working = ctx.statusContainer.append(BusyView({ message: "Working…" }));
			ctx.loadingAnimation = working;
			const controller = new EventController(ctx);

			await controller.handleEvent({
				type: "agent_end",
				messages: [{ role: "assistant", content: [], stopReason }],
			} as unknown as AgentSessionEvent);

			expect(ctx.loadingAnimation).toBeUndefined();
			expect(ctx.statusContainer.entries()).toHaveLength(0);
			expect(markActivityEnd).toHaveBeenCalledTimes(1);
		}
	});

	it("replaces working with compaction and restores it when streaming resumes", async () => {
		const streaming = { value: true };
		const ctx = createInteractiveModeContext({
			session: {
				get isStreaming() {
					return streaming.value;
				},
			},
		});
		ctx.ensureLoadingAnimation = vi.fn(() => {
			if (ctx.loadingAnimation) return;
			ctx.loadingAnimation = ctx.statusContainer.append(BusyView({ message: "Working…" }));
		});
		ctx.ensureLoadingAnimation();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "auto_compaction_start",
			reason: "threshold",
			action: "context-full",
		} as AgentSessionEvent);
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(ctx.autoCompactionLoader).toBeDefined();
		expect(ctx.statusContainer.entries()).toHaveLength(1);

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		} as AgentSessionEvent);
		expect(ctx.autoCompactionLoader).toBeUndefined();
		expect(ctx.loadingAnimation).toBeDefined();
		expect(ctx.statusContainer.entries()).toHaveLength(1);
	});

	it("keeps one user reaction target across streamed and settled assistant snapshots", async () => {
		const target = createReactionTarget();
		const takeReactionTargetForAssistant = vi.fn(() => target);
		const ctx = createInteractiveModeContext({
			session: { isStreaming: true },
			takeReactionTargetForAssistant,
		});
		const controller = new EventController(ctx);
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "✅ Done" }],
			stopReason: "stop",
			timestamp: Date.now(),
		};

		await controller.handleEvent({ type: "message_update", message } as unknown as AgentSessionEvent);
		await controller.handleEvent({ type: "message_end", message } as unknown as AgentSessionEvent);

		expect(takeReactionTargetForAssistant).toHaveBeenCalledTimes(1);
	});
});
