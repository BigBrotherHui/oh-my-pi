import { describe, expect, it } from "bun:test";
import {
	RichText,
	Style,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import type { RenderScheduler, RenderTimer } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class InputFrameProvider implements TerminalFrameProvider {
	frames = 0;
	inputs = 0;

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		this.frames++;
		const frame = new RichText();
		frame.push(Style.NONE, `input:${this.inputs} frame:${this.frames}`);
		frame.br();
		return { viewport: frame };
	}

	handleInput(_data: string): void {
		this.inputs++;
	}

	acknowledgeHistory(_id: number): void {}
}

class DeferredRenderScheduler implements RenderScheduler {
	nowMs = 0;
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ callback: () => void; canceled: boolean }> = [];

	now(): number {
		return this.nowMs;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, _delayMs: number): RenderTimer {
		const timer = { callback, canceled: false };
		this.timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}
}

function fireNextTimer(scheduler: DeferredRenderScheduler): void {
	const timer = scheduler.timers.shift();
	if (timer && !timer.canceled) timer.callback();
}

describe("TUI input/render scheduling", () => {
	it("can commit a priority frame without waiting for queued immediates", () => {
		const terminal = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const provider = new InputFrameProvider();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		try {
			tui.start();
			tui.renderNow();
			expect(terminal.getViewport().map(row => row.trimEnd())).toContain("input:0 frame:1");

			for (const immediate of scheduler.immediates.splice(0)) immediate();
			expect(terminal.getViewport().map(row => row.trimEnd())).toContain("input:0 frame:1");
		} finally {
			tui.stop();
		}
	});

	it("can process terminal input before a deferred ordinary repaint", () => {
		const terminal = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const provider = new InputFrameProvider();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.setHostInputHandler(data => provider.handleInput(data));

		try {
			tui.start();
			scheduler.immediates.shift()?.();
			fireNextTimer(scheduler);
			scheduler.nowMs = 100;

			tui.requestRender();
			terminal.sendInput("x");
			scheduler.immediates.shift()?.();
			fireNextTimer(scheduler);

			expect(terminal.getViewport().map(row => row.trimEnd())).toContain("input:1 frame:2");
		} finally {
			tui.stop();
		}
	});
});
