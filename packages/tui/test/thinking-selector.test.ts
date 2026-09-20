import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { TUI } from "@oh-my-pi/pi-tui";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import { openThinkingSelector } from "../src/overlays/thinking-selector";

class TestTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}
}

function openSelector(currentLevel = Effort.High): {
	readonly terminal: TestTerminal;
	readonly tui: TUI;
	readonly selected: Effort[];
	readonly cancelled: () => number;
	readonly dispose: () => void;
} {
	const terminal = new TestTerminal();
	const tui = new TUI(terminal);
	const selected: Effort[] = [];
	let cancellations = 0;
	const selector = openThinkingSelector(
		tui,
		currentLevel,
		[Effort.Low, Effort.High],
		level => selected.push(level),
		() => {
			cancellations += 1;
		},
	);
	tui.renderNow();
	return { terminal, tui, selected, cancelled: () => cancellations, dispose: selector.dispose };
}

describe("thinking selector", () => {
	it("preserves historical reasoning rows and their narrow-width boundary", () => {
		const selector = openSelector();
		try {
			const wide = selector.tui.getDebugPaint()?.lines.join("\n") ?? "";
			expect(wide).toContain("Thinking Level");
			expect(wide).toContain("Light reasoning (~2k tokens)");
			expect(wide).toContain("Deep reasoning (~16k tokens)");

			selector.terminal.columns = 50;
			selector.tui.renderNow();
			expect(selector.tui.getDebugPaint()?.lines.join("\n")).not.toContain("Light");

			selector.terminal.columns = 51;
			selector.tui.renderNow();
			expect(selector.tui.getDebugPaint()?.lines.join("\n")).toContain("Light");
		} finally {
			selector.dispose();
		}
	});

	it("selects the preselected effort with keys and border-relative mouse input", () => {
		const selector = openSelector();
		try {
			selector.tui.injectDebugInput("\n");
			expect(selector.selected).toEqual([Effort.High]);

			// A two-row, bottom-anchored frame starts on row 21 in a 24-row terminal.
			selector.tui.injectDebugInput("\x1b[<0;1;21M");
			expect(selector.selected).toEqual([Effort.High]);

			selector.tui.injectDebugInput("\x1b[<0;1;22M");
			expect(selector.selected).toEqual([Effort.High, Effort.Low]);

			selector.tui.injectDebugInput("\x1b[B");
			selector.tui.injectDebugInput("\n");
			expect(selector.selected).toEqual([Effort.High, Effort.Low, Effort.High]);

			selector.tui.injectDebugInput("\x03");
			expect(selector.cancelled()).toBe(1);
		} finally {
			selector.dispose();
		}
	});
});
