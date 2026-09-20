import { describe, expect, it } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import { openShowImagesSelector } from "../src/overlays/show-images-selector";

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

function openSelector(currentValue = true): {
	readonly terminal: TestTerminal;
	readonly tui: TUI;
	readonly selected: boolean[];
	readonly cancelled: () => number;
	readonly dispose: () => void;
} {
	const terminal = new TestTerminal();
	const tui = new TUI(terminal);
	const selected: boolean[] = [];
	let cancellations = 0;
	const selector = openShowImagesSelector(
		tui,
		currentValue,
		value => selected.push(value),
		() => {
			cancellations += 1;
		},
	);
	tui.renderNow();
	return { terminal, tui, selected, cancelled: () => cancellations, dispose: selector.dispose };
}

describe("show images selector", () => {
	it("keeps descriptions out of the narrow selector while retaining both choices", () => {
		const selector = openSelector();
		try {
			// The frame uses two border and two horizontal padding cells, leaving
			// the SelectList's historical 40-cell narrow-width boundary at 44.
			selector.terminal.columns = 44;
			selector.tui.renderNow();
			const narrow = selector.tui.getDebugPaint()?.lines.join("\n") ?? "";
			expect(narrow).toContain("Yes");
			expect(narrow).toContain("No");
			expect(narrow).not.toContain("Show images inline in terminal");

			selector.terminal.columns = 45;
			selector.tui.renderNow();
			expect(selector.tui.getDebugPaint()?.lines.join("\n")).toContain("Show images inline in terminal");
		} finally {
			selector.dispose();
		}
	});

	it("preserves selected value, keyboard selection, cancellation, and border-relative clicks", () => {
		const selector = openSelector();
		try {
			// The bottom-centered frame is four rows high at 24 rows: its top edge
			// is screen row 21 and its first selectable row is screen row 22.
			// Its content starts at screen column 3 after the border and padding.
			selector.tui.injectDebugInput("\x1b[<0;3;21M");
			expect(selector.selected).toEqual([]);

			selector.tui.injectDebugInput("\x1b[<0;3;22M");
			expect(selector.selected).toEqual([true]);

			selector.tui.injectDebugInput("\x1b[B");
			selector.tui.injectDebugInput("\n");
			expect(selector.selected).toEqual([true, false]);

			selector.tui.injectDebugInput("\x1b");
			expect(selector.cancelled()).toBe(1);
		} finally {
			selector.dispose();
		}
	});
});
