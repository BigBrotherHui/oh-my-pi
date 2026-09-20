import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import {
	RichText,
	Style,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import type { RenderScheduler } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class InterruptFrameProvider implements TerminalFrameProvider {
	interruptsHandled = 0;
	exitRequests = 0;
	#firstInterruptAt = 0;
	#blockNextRenderMs = 0;
	secondInterruptSeen = false;
	slowRenderBeforeSecond = false;

	armSlowRender(blockMs: number): void {
		this.#blockNextRenderMs = blockMs;
	}

	handleInput(data: string): void {
		if (data !== "\x03") return;
		this.interruptsHandled++;
		if (this.interruptsHandled === 1) {
			this.#firstInterruptAt = Date.now();
			return;
		}
		this.secondInterruptSeen = true;
		if (!this.slowRenderBeforeSecond && this.#firstInterruptAt !== 0 && Date.now() - this.#firstInterruptAt < 500) {
			this.exitRequests++;
		}
		this.#firstInterruptAt = 0;
	}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		const blockMs = this.#blockNextRenderMs;
		this.#blockNextRenderMs = 0;
		if (blockMs > 0) {
			if (!this.secondInterruptSeen) this.slowRenderBeforeSecond = true;
			setSystemTime(new Date(Date.now() + blockMs));
		}
		const frame = new RichText();
		frame.push(Style.NONE, `interrupts:${this.interruptsHandled} exits:${this.exitRequests}`);
		frame.br();
		return { viewport: frame };
	}

	acknowledgeHistory(_id: number): void {}
}

class NavigationFrameProvider implements TerminalFrameProvider {
	selected = 0;

	handleInput(data: string): void {
		if (data === "\x1b[B") this.selected++;
	}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		const frame = new RichText();
		frame.push(Style.NONE, `selected:${this.selected}`);
		frame.br();
		return { viewport: frame };
	}

	acknowledgeHistory(_id: number): void {}
}

async function drainNextTick(): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
}

function fakeTimerScheduler(): RenderScheduler {
	return {
		now: () => Date.now(),
		scheduleImmediate: callback => {
			process.nextTick(callback);
		},
		scheduleRender: (callback, delayMs) => {
			if (delayMs <= 0) {
				let cancelled = false;
				process.nextTick(() => {
					if (!cancelled) callback();
				});
				return {
					cancel: () => {
						cancelled = true;
					},
				};
			}
			const handle = setTimeout(callback, delayMs);
			return { cancel: () => clearTimeout(handle) };
		},
	};
}

describe("TUI input priority", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("handles a queued second Ctrl+C before a slow repaint can consume the double-interrupt window", async () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { renderScheduler: fakeTimerScheduler() });
		const provider = new InterruptFrameProvider();
		tui.setFrameProvider(provider);
		tui.setHostInputHandler(data => provider.handleInput(data));
		try {
			tui.start();
			await drainNextTick();
			provider.armSlowRender(650);
			vi.advanceTimersByTime(40);

			terminal.sendInput("\x03");
			setTimeout(() => terminal.sendInput("\x03"), 10);
			await drainNextTick();
			vi.advanceTimersByTime(0);
			vi.advanceTimersByTime(10);
			vi.advanceTimersByTime(40);

			expect(provider.slowRenderBeforeSecond).toBe(false);
			expect(terminal.getViewport().map(row => row.trimEnd())).toContain("interrupts:2 exits:1");
		} finally {
			tui.stop();
		}
	});

	it("renders ordinary navigation without an interrupt-grace delay", async () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { renderScheduler: fakeTimerScheduler() });
		const provider = new NavigationFrameProvider();
		tui.setFrameProvider(provider);
		tui.setHostInputHandler(data => provider.handleInput(data));

		try {
			tui.start();
			await drainNextTick();
			vi.advanceTimersByTime(40);

			terminal.sendInput("\x1b[B");
			await drainNextTick();
			await drainNextTick();

			expect(terminal.getViewport().map(row => row.trimEnd())).toContain("selected:1");
		} finally {
			tui.stop();
		}
	});
});
