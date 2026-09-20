import { describe, expect, it } from "bun:test";
import { createComponent } from "../src/host/renderer";
import { mountOverlay, Portal, type OverlayDisposer } from "../src/host/overlay";
import { render, type RootHandle } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";

const TRACKING_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

class MinimalTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;
	#onInput: ((data: string) => void) | undefined;
	#onResize: (() => void) | undefined;
	output = "";

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#onInput = onInput;
		this.#onResize = onResize;
	}

	stop(): void {
		this.#onInput = undefined;
		this.#onResize = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	sendInput(data: string): void {
		this.#onInput?.(data);
	}

	emitResize(): void {
		this.#onResize?.();
	}

	write(data: string): void {
		this.output += data;
	}

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

function makeInlineRoot(enabled: { current: boolean }): { terminal: MinimalTerminal; root: RootHandle } {
	const terminal = new MinimalTerminal();
	const root = render(() => "line", {
		terminal,
		theme: loadThemeSync("dark"),
	});
	root.tui.setInlineMouseTrackingProvider(() => enabled.current);
	return { terminal, root };
}

function showOverlay(
	root: RootHandle,
	options: { fullscreen?: boolean; mouseTracking?: boolean } = {},
): OverlayDisposer {
	return mountOverlay(root.tui, () =>
		createComponent(Portal, {
			to: "overlay",
			fullscreen: options.fullscreen,
			mouseTracking: options.mouseTracking,
			children: "overlay",
		}),
	);
}

describe("inline mouse tracking", () => {
	it("enables capture on the normal buffer and releases it on stop", () => {
		const enabled = { current: true };
		const { terminal, root } = makeInlineRoot(enabled);
		try {
			root.tui.renderNow();
			expect(terminal.output.includes(TRACKING_ON)).toBe(true);

			root.dispose();
			const offAt = terminal.output.lastIndexOf(TRACKING_OFF);
			expect(offAt).toBeGreaterThan(-1);
			expect(offAt).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));
		} finally {
			root.dispose();
		}
	});

	it("yields to any visible overlay and restores after it closes", () => {
		const enabled = { current: true };
		const { terminal, root } = makeInlineRoot(enabled);
		let overlay: OverlayDisposer | undefined;
		try {
			root.tui.renderNow();
			expect(terminal.output.includes(TRACKING_ON)).toBe(true);

			overlay = showOverlay(root);
			root.tui.renderNow();
			const offAt = terminal.output.lastIndexOf(TRACKING_OFF);
			expect(offAt).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));

			overlay.dispose();
			overlay = undefined;
			root.tui.renderNow();
			expect(terminal.output.lastIndexOf(TRACKING_ON)).toBeGreaterThan(offAt);
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});

	it("restores inline capture after a mouse-disabled fullscreen overlay closes", () => {
		const enabled = { current: true };
		const { terminal, root } = makeInlineRoot(enabled);
		let overlay: OverlayDisposer | undefined;
		try {
			root.tui.renderNow();
			expect(terminal.output.includes(TRACKING_ON)).toBe(true);

			overlay = showOverlay(root, { fullscreen: true, mouseTracking: false });
			root.tui.renderNow();
			const offAt = terminal.output.lastIndexOf(TRACKING_OFF);
			expect(offAt).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));

			overlay.dispose();
			overlay = undefined;
			root.tui.renderNow();
			expect(terminal.output.lastIndexOf(TRACKING_ON)).toBeGreaterThan(offAt);
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});

	it("releases capture on stop even with a pending alt exit", () => {
		const enabled = { current: true };
		const { terminal, root } = makeInlineRoot(enabled);
		let overlay: OverlayDisposer | undefined;
		try {
			overlay = showOverlay(root, { fullscreen: true });
			root.tui.renderNow();

			root.tui.requestRender(true, { clearScrollback: true });
			overlay.dispose();
			overlay = undefined;
			root.tui.renderNow();
			root.dispose();

			expect(terminal.output.includes(TRACKING_OFF)).toBe(true);
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});

	it("leaves tracking off when stopping after a fused restore exit", () => {
		const enabled = { current: true };
		const { terminal, root } = makeInlineRoot(enabled);
		let overlay: OverlayDisposer | undefined;
		try {
			overlay = showOverlay(root, { fullscreen: true, mouseTracking: false });
			root.tui.renderNow();

			root.tui.requestRender(true, { clearScrollback: true });
			overlay.dispose();
			overlay = undefined;
			root.tui.renderNow();
			root.dispose();

			expect(terminal.output.includes(TRACKING_OFF)).toBe(true);
			expect(terminal.output.lastIndexOf(TRACKING_OFF)).toBeGreaterThan(terminal.output.lastIndexOf(TRACKING_ON));
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});

	it("stays off by default", () => {
		const enabled = { current: false };
		const { terminal, root } = makeInlineRoot(enabled);
		try {
			root.tui.renderNow();
			expect(terminal.output.includes(TRACKING_ON)).toBe(false);
		} finally {
			root.dispose();
		}
	});
});

describe("mutable viewport geometry", () => {
	it("exposes the painted window and hides it behind the alt screen", () => {
		const enabled = { current: true };
		const { root } = makeInlineRoot(enabled);
		let overlay: OverlayDisposer | undefined;
		try {
			root.tui.renderNow();
			expect(root.tui.getMutableViewport().length).toBe(1);

			overlay = showOverlay(root, { fullscreen: true });
			root.tui.renderNow();
			expect(root.tui.getMutableViewport()).toEqual({ top: 0, length: 0 });
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});
});
