import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { counters, instrument, resetCounters } from "../../src/instrumentation";
import {
	createClock,
	createCommitEffect,
	createEffect,
	createLayoutEffect,
	createRoot,
	registerClock,
	useClock,
} from "../../src/reactive";
import { getEffectQueue } from "../../src/reactive/effects";
import type { EffectQueue } from "../../src/reactive/effects";

describe("root clock", () => {
	afterEach(() => {
		vi.useRealTimers();
		resetCounters();
	});

	it("starts one shared cadence timer on first read and returns to idle on cleanup", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		resetCounters();
		const clock = createClock();
		const firstValues: number[] = [];
		const secondValues: number[] = [];
		const dispose = createRoot(rootDispose => {
			registerClock(clock);
			const first = useClock("spinner");
			const second = useClock("spinner");
			expect(counters().timers).toBe(0);
			createEffect(() => firstValues.push(first()));
			createEffect(() => secondValues.push(second()));
			return rootDispose;
		});

		expect(counters().timers).toBe(1);
		expect(firstValues).toEqual([1_000]);
		expect(secondValues).toEqual([1_000]);
		vi.advanceTimersByTime(80);
		expect(firstValues.at(-1)).toBe(1_080);
		expect(secondValues.at(-1)).toBe(1_080);
		dispose();
		expect(counters().timers).toBe(0);
		clock.dispose();
	});

	it("shares the direct host subscription timer and tears it down at zero listeners", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(2_000));
		resetCounters();
		const clock = createClock();
		const values: number[] = [];
		const unsubscribeFirst = clock.subscribe("frame", value => values.push(value));
		const unsubscribeSecond = clock.subscribe("frame", value => values.push(value));

		expect(counters().timers).toBe(1);
		unsubscribeFirst();
		expect(counters().timers).toBe(1);
		unsubscribeSecond();
		expect(counters().timers).toBe(0);
		clock.dispose();
	});

	it("freezes an immutable cadence snapshot at the requested instant", () => {
		const clock = createClock({ now: () => 0, frameMs: 40 });
		const snapshot = clock.freeze(1_234);

		expect(snapshot).toEqual({ at: 1_234, frame: 30, spinner: 15, second: 1 });
		expect(clock.frozen()).toBe(snapshot);
		expect(Object.isFrozen(snapshot)).toBeTrue();
		clock.dispose();
	});
});

describe("root effect queues", () => {
	it("keeps independently mounted roots in separate queues", () => {
		let firstQueue!: EffectQueue;
		let secondQueue!: EffectQueue;
		let firstRuns = 0;
		let secondRuns = 0;
		const disposeFirst = createRoot(rootDispose => {
			firstQueue = getEffectQueue();
			createCommitEffect(() => {
				firstRuns += 1;
			});
			return rootDispose;
		});
		const disposeSecond = createRoot(rootDispose => {
			secondQueue = getEffectQueue();
			createCommitEffect(() => {
				secondRuns += 1;
			});
			return rootDispose;
		});

		firstQueue.flushCommitHooks();
		expect({ firstRuns, secondRuns }).toEqual({ firstRuns: 1, secondRuns: 0 });
		secondQueue.flushCommitHooks();
		expect({ firstRuns, secondRuns }).toEqual({ firstRuns: 1, secondRuns: 1 });
		disposeFirst();
		disposeSecond();
	});

	it("removes layout and commit hooks when their owner is disposed", () => {
		let queue!: EffectQueue;
		let layouts = 0;
		let commits = 0;
		const dispose = createRoot(rootDispose => {
			queue = getEffectQueue();
			createLayoutEffect(() => {
				layouts += 1;
			});
			createCommitEffect(() => {
				commits += 1;
			});
			return rootDispose;
		});

		queue.flushLayoutHooks();
		queue.flushCommitHooks();
		expect({ layouts, commits }).toEqual({ layouts: 1, commits: 1 });
		dispose();
		queue.flushLayoutHooks();
		queue.flushCommitHooks();
		expect({ layouts, commits }).toEqual({ layouts: 1, commits: 1 });
	});
});

describe("instrumentation", () => {
	it("returns snapshots while owner and timer counters remain live gauges", () => {
		resetCounters();
		instrument.viewRun();
		instrument.ownerCreated();
		instrument.timerStarted();
		const beforeRelease = counters();
		instrument.ownerDisposed();
		instrument.timerStopped();

		expect(beforeRelease).toMatchObject({ viewRuns: 1, owners: 1, timers: 1 });
		expect(counters()).toMatchObject({ viewRuns: 1, owners: 0, timers: 0 });
	});
});
