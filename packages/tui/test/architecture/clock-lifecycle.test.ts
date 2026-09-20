import { describe, expect, test } from "bun:test";
import { counters, resetCounters } from "../../src/instrumentation";
import { createClock, createEffect, createRoot, createSignal, registerClock, useClock } from "../../src/reactive";

describe.serial("reactive clock architecture", () => {
	test("idle roots allocate no cadence timers", () => {
		resetCounters();
		const clock = createClock({ now: () => 1_000 });
		createRoot(dispose => {
			registerClock(clock);
			expect(counters().timers).toBe(0);
			dispose();
		});
		clock.dispose();
		expect(counters().timers).toBe(0);
	});

	test("hiding a clock-owning branch drops its subscription", () => {
		resetCounters();
		const clock = createClock({ now: () => 1_000 });
		const control = createRoot(dispose => {
			registerClock(clock);
			const [visible, setVisible] = createSignal(true);
			createEffect(() => {
				if (!visible()) return;
				useClock("spinner")();
			});
			return { dispose, setVisible };
		});
		expect(counters().timers).toBe(1);
		control.setVisible(false);
		expect(counters().timers).toBe(0);
		control.setVisible(true);
		expect(counters().timers).toBe(1);
		control.setVisible(false);
		expect(counters().timers).toBe(0);
		control.dispose();
		clock.dispose();
		expect(counters().timers).toBe(0);
	});

	test("repeated reactive root disposal returns timers to baseline", () => {
		resetCounters();
		const baseline = counters();
		for (let iteration = 0; iteration < 50; iteration++) {
			const clock = createClock({ now: () => iteration * 100 });
			createRoot(dispose => {
				registerClock(clock);
				useClock("frame")();
				expect(counters().timers).toBe(baseline.timers + 1);
				dispose();
			});
			clock.dispose();
			expect(counters().timers).toBe(baseline.timers);
			expect(counters().owners).toBe(baseline.owners);
		}
	});
});
