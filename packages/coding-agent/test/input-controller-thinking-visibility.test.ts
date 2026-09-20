import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function context(overrides: Partial<InteractiveModeContext> = {}): InteractiveModeContext {
	return {
		hideThinkingBlock: false,
		hasDisplayableThinkingContent: false,
		session: { thinkingLevel: "off" },
		settings: { set: vi.fn() },
		showStatus: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
		ui: { resetDisplay: vi.fn() },
		...overrides,
	} as unknown as InteractiveModeContext;
}

describe("InputController thinking visibility", () => {
	it("refuses to toggle before an off-level session produces reasoning", () => {
		const ctx = context();

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(false);
		expect(ctx.settings.set).not.toHaveBeenCalled();
		expect(ctx.rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(ctx.ui.resetDisplay).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("Thinking is off — enable thinking to show blocks");
	});

	it("rebuilds the transcript when observed reasoning unlocks the toggle", () => {
		const ctx = context({ hasDisplayableThinkingContent: true });

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(true);
		expect(ctx.settings.set).toHaveBeenCalledWith("hideThinkingBlock", true);
		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(ctx.ui.resetDisplay).toHaveBeenCalledTimes(1);
		expect(ctx.showStatus).toHaveBeenCalledWith("Thinking blocks: hidden");
	});
});
