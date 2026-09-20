import { describe, expect, it } from "bun:test";
import { RichText, type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import { parseAnsiRows } from "../src/core/ansi";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";

class CaptureTerminal implements Terminal {
	writes: string[] = [];
	#columns: number;
	#rows: number;

	constructor(columns = 80, rows = 4) {
		this.#columns = columns;
		this.#rows = rows;
	}

	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return this.#rows;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	get kittyEnableSequence(): string | null {
		return null;
	}

	get keyboardEnhancementEnterSequence(): string | null {
		return null;
	}

	get keyboardEnhancementExitSequence(): string | null {
		return null;
	}

	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
}

class RawLinesProvider implements TerminalFrameProvider {
	constructor(private readonly lines: readonly string[]) {}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		const frame = new RichText();
		parseAnsiRows(this.lines, frame);
		return { viewport: frame };
	}

	acknowledgeHistory(_id: number): void {}
}

async function settle(): Promise<void> {
	await Bun.sleep(0);
}

describe("issue #2045: renderer bounds oversized rows", () => {
	it("preserves visible text after pathological zero-width ANSI prefixes", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		const line = `${"\x1b[31m".repeat(20_000)}payload`;

		tui.setFrameProvider(new RawLinesProvider([line]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain("payload");
		expect(rendered.length).toBeLessThan(12_000);
	});

	it("preserves visible suffix text after long zero-width combining prefixes", async () => {
		const term = new CaptureTerminal(3, 4);
		const tui = new TUI(term);
		const line = `a${"\u0301".repeat(4096)}bc`;

		tui.setFrameProvider(new RawLinesProvider([line]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain("bc");
	});

	it("preserves visible text after oversized OSC hyperlink prefixes", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		const line = `\x1b]8;;https://example.com/${"a".repeat(70_000)}\x07link-label\x1b]8;;\x07`;

		tui.setFrameProvider(new RawLinesProvider([line]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain("link-label");
		expect(rendered.length).toBeLessThan(12_000);
	});

	it("preserves OSC 66 text-sizing payloads at the start of long rows", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		const visibleText = "H".repeat(70);
		const line = `\x1b]66;s=1;${visibleText}\x1b\\${"\x1b[31m".repeat(20_000)}`;

		tui.setFrameProvider(new RawLinesProvider([line]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain(visibleText);
	});
});
