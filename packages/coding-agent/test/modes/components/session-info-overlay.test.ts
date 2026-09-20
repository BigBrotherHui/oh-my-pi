import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../../src/config/settings";
import { setKeybindings, visibleWidth } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { openSessionInfoOverlay, SessionInfoOverlayView } from "@oh-my-pi/pi-tui/overlays/session-info-overlay";
import type { OverlayDisposer } from "@oh-my-pi/pi-tui/host/overlay";
import { renderToRows } from "@oh-my-pi/pi-tui/testing";
import { render } from "@oh-my-pi/pi-tui/root";
import { Editor, EditorView } from "@oh-my-pi/pi-tui/components/editor";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";

class MinimalTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;
	#onInput: ((data: string) => void) | undefined;

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.#onInput = onInput;
	}

	stop(): void {
		this.#onInput = undefined;
	}

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

	sendInput(data: string): void {
		this.#onInput?.(data);
	}
}

let uiTheme: Theme;

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	uiTheme = loaded;
	setThemeInstance(uiTheme);
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
});

describe("SessionInfoOverlayView", () => {
	it("renders session details and footer help", () => {
		const lines = renderToRows(
			() =>
				SessionInfoOverlayView({
					info: "File: /tmp/session.jsonl\nProvider: openai\nTokens: 42",
					maxHeight: 12,
				}),
			48,
		);
		const plain = lines.map(line => Bun.stripANSI(line));
		const text = plain.join("\n");

		expect(text).toContain("Session Info");
		expect(text).toContain("File: /tmp/session.jsonl");
		expect(lines.map(visibleWidth)).toEqual(Array(lines.length).fill(48));
		expect(plain[0]).toContain(uiTheme.boxRound.topLeft);
		expect(plain.at(-1)).toContain(uiTheme.boxRound.bottomLeft);
	});

	it("preserves exact-width details", () => {
		const detail = `${"A".repeat(43)}Z`;
		const text = renderToRows(
			() =>
				SessionInfoOverlayView({
					info: [detail, "line 2", "line 3", "line 4", "line 5"].join("\n"),
					maxHeight: 8,
				}),
			48,
		)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(text).toContain("Z");
	});

	it("caps long panels at the supplied height", () => {
		const lines = renderToRows(
			() =>
				SessionInfoOverlayView({
					info: Array.from({ length: 20 }, (_, index) => `Detail ${index}`).join("\n"),
					maxHeight: 8,
				}),
			12,
		);
		const plain = lines.map(line => Bun.stripANSI(line));

		expect(lines).toHaveLength(8);
		expect(plain.join("\n")).toContain("█");
		expect(plain.join("\n")).toContain("│");
		expect(lines.map(visibleWidth)).toEqual(Array(lines.length).fill(12));
		expect(plain[0]).toContain(uiTheme.boxRound.topLeft);
		expect(plain.at(-1)).toContain(uiTheme.boxRound.bottomLeft);
	});

	it("shows the requested wrapped-content offset", () => {
		const text = renderToRows(
			() =>
				SessionInfoOverlayView({
					info: Array.from({ length: 20 }, (_, index) => `Detail ${index}`).join("\n"),
					offset: 3,
					maxHeight: 8,
				}),
			40,
		)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(text).toContain("Detail 3");
		expect(text).not.toContain("Detail 0");
	});
});

describe("openSessionInfoOverlay", () => {
	it("owns scroll and cancel keys, then restores editor input", () => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
		const terminal = new MinimalTerminal();
		const editor = new Editor(getEditorTheme());
		const root = render(() => EditorView({ editor }), { terminal, theme: uiTheme });
		const tui = root.tui;
		const onClose = vi.fn();
		let overlay: OverlayDisposer | undefined;
		const close = (): void => {
			onClose();
			overlay?.dispose();
		};

		try {
			overlay = openSessionInfoOverlay(
				tui,
				Array.from({ length: 20 }, (_, index) => `Detail ${index}`).join("\n"),
				close,
				{ host: { terminal }, maxHeight: 8 },
			);
			tui.renderNow();
			const initial = tui.getDebugPaint()?.lines.join("\n") ?? "";

			terminal.sendInput("\x1b[B");
			tui.renderNow();
			const scrolled = tui.getDebugPaint()?.lines.join("\n") ?? "";
			terminal.sendInput("\x07");

			expect(initial).toContain("Detail 0");
			expect(scrolled).toContain("Detail 1");
			expect(scrolled).not.toContain("Detail 0");
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(tui.hasOverlay()).toBe(false);
			expect(editor.getText()).toBe("");
			terminal.sendInput("restored");
			expect(editor.getText()).toBe("restored");

			overlay = openSessionInfoOverlay(tui, "File: in-memory", close, {
				host: { terminal },
				maxHeight: 8,
			});
			terminal.sendInput("\x1b");

			expect(onClose).toHaveBeenCalledTimes(2);
			expect(tui.hasOverlay()).toBe(false);
			terminal.sendInput(" again");
			expect(editor.getText()).toBe("restored again");
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});
});
