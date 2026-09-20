import { describe, expect, it } from "bun:test";
import {
	CodexResetFireworksController,
	CodexResetFireworksView,
	detectCodexResetFireworks,
} from "../src/overlays/codex-reset-fireworks";
import {
	type Accessor,
	type ClockCadence,
	type ClockSnapshot,
	createClock,
	createSignal,
	type Setter,
} from "../src/reactive";
import { render } from "../src/root";
import { type FakeClock, mountForTest } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";
import { visibleWidth } from "../src/utils";
import { VirtualTerminal } from "./virtual-terminal";

interface ManualCadence {
	readonly read: Accessor<number>;
	readonly write: Setter<number>;
	readonly listeners: Set<(now: number) => void>;
}

function manualCadence(): ManualCadence {
	const [read, write] = createSignal(0, { equals: false });
	return { read, write, listeners: new Set() };
}

class ManualClock implements FakeClock {
	readonly frameMs = 1_000 / 30;
	#now = 0;
	#snapshot: ClockSnapshot = { at: 0, frame: 0, spinner: 0, second: 0 };
	#cadences: Record<ClockCadence, ManualCadence> = {
		frame: manualCadence(),
		spinner: manualCadence(),
		second: manualCadence(),
	};

	readonly now = (): number => this.#now;

	access(cadence: ClockCadence): Accessor<number> {
		return this.#cadences[cadence].read;
	}

	subscribe(cadence: ClockCadence, listener: (now: number) => void): () => void {
		const listeners = this.#cadences[cadence].listeners;
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	freeze(at = this.#now): ClockSnapshot {
		this.#snapshot = {
			at,
			frame: Math.floor(at / this.frameMs),
			spinner: Math.floor(at / 80),
			second: Math.floor(at / 1_000),
		};
		return this.#snapshot;
	}

	frozen(): ClockSnapshot {
		return this.#snapshot;
	}

	advance(ms: number): void {
		this.#now += ms;
		for (const cadence of [this.#cadences.frame, this.#cadences.spinner, this.#cadences.second]) {
			cadence.write(this.#now);
			for (const listener of cadence.listeners) listener(this.#now);
		}
	}

	dispose(): void {
		for (const cadence of [this.#cadences.frame, this.#cadences.spinner, this.#cadences.second]) {
			cadence.listeners.clear();
		}
	}
}

describe("Codex reset fireworks", () => {
	it("detects an early weekly reset while prioritizing newly banked resets", () => {
		const previous = {
			observedAt: 1_000,
			sevenDay: { percent: 42, resetsAt: 10_000 },
			savedResets: 0,
		};
		expect(
			detectCodexResetFireworks(previous, {
				observedAt: 2_000,
				sevenDay: { percent: 2, resetsAt: 20_000 },
				savedResets: 0,
			}),
		).toEqual({ kind: "unscheduled-weekly-reset" });
		expect(
			detectCodexResetFireworks(previous, {
				observedAt: 2_000,
				sevenDay: { percent: 0, resetsAt: 20_000 },
				savedResets: 2,
			}),
		).toEqual({ kind: "saved-reset-banked", added: 2, available: 2 });
	});

	it("draws the historical banner and animates relative to its mount", () => {
		const clock = new ManualClock();
		const root = mountForTest(
			() => <CodexResetFireworksView event={{ kind: "unscheduled-weekly-reset" }} height={7} />,
			{ clock, width: 80 },
		);
		try {
			const initial = root.text().join("\n");
			expect(initial).toContain("O P E N A I   R E S E T");
			expect(initial).toContain("Weekly usage cleared early · ESC to return");
			expect(initial.split("\n").every(row => visibleWidth(row) <= 80)).toBe(true);

			clock.advance(5 * 85);
			root.flush();
			expect(root.text().join("\n")).toContain("@");
		} finally {
			root.dispose();
			clock.dispose();
		}
	});

	it("stops its root-owned frame subscription when the view unmounts", () => {
		const clock = createClock({ now: () => 0, frameMs: 30 });
		const root = mountForTest(
			() => <CodexResetFireworksView event={{ kind: "saved-reset-banked", added: 1, available: 3 }} height={7} />,
			{ clock },
		);
		try {
			expect(root.counters().timers).toBe(1);
		} finally {
			root.dispose();
			clock.dispose();
		}
		expect(root.counters().timers).toBe(0);
	});

	it("stays open until Escape, then permits the next celebration", () => {
		const terminal = new VirtualTerminal(80, 24);
		const clock = new ManualClock();
		const root = render(
			() => (
				<box tabIndex={0}>
					<text>main</text>
				</box>
			),
			{
				terminal,
				theme: loadThemeSync("dark"),
				clock,
			},
		);
		const controller = new CodexResetFireworksController(root.tui);
		try {
			expect(controller.show({ kind: "unscheduled-weekly-reset" })).toBe(true);
			expect(controller.show({ kind: "saved-reset-banked", added: 1, available: 1 })).toBe(false);
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("O P E N A I   R E S E T");

			terminal.sendInput("x");
			expect(root.tui.hasOverlay()).toBe(true);
			terminal.sendInput("\x1b");
			root.tui.renderNow();
			expect(root.tui.hasOverlay()).toBe(false);

			expect(controller.show({ kind: "saved-reset-banked", added: 1, available: 3 })).toBe(true);
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("S A V E D   R E S E T");
		} finally {
			controller.dispose();
			root.dispose();
			clock.dispose();
		}
	});
});
