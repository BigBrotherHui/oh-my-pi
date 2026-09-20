/** Observable work counters used by tests and performance budgets. */
export interface Counters {
	/** Application view evaluations. */
	viewRuns: number;
	/** Retained host nodes allocated. */
	nodesCreated: number;
	/** Retained host nodes detached. */
	nodesRemoved: number;
	/** Existing retained host nodes repositioned. */
	nodesMoved: number;
	/** Reactive host property writes. */
	bindings: number;
	/** Host subtree paint operations. */
	paints: number;
	/** Host subtree layout operations. */
	layouts: number;
	/** Document parser operations. */
	parses: number;
	/** Currently live reactive roots. */
	owners: number;
	/** Currently live scheduled timers. */
	timers: number;
}

const values: Counters = {
	viewRuns: 0,
	nodesCreated: 0,
	nodesRemoved: 0,
	nodesMoved: 0,
	bindings: 0,
	paints: 0,
	layouts: 0,
	parses: 0,
	owners: 0,
	timers: 0,
};

/** Return a point-in-time copy of the process-wide counters. */
export function counters(): Counters {
	return { ...values };
}

/** Reset every process-wide counter, including live gauges. */
export function resetCounters(): void {
	values.viewRuns = 0;
	values.nodesCreated = 0;
	values.nodesRemoved = 0;
	values.nodesMoved = 0;
	values.bindings = 0;
	values.paints = 0;
	values.layouts = 0;
	values.parses = 0;
	values.owners = 0;
	values.timers = 0;
}

function decrementGauge(key: "owners" | "timers"): void {
	values[key] = Math.max(0, values[key] - 1);
}

/** Increment helpers for work counters and live ownership gauges. */
export const instrument = Object.freeze({
	viewRun(): void {
		values.viewRuns += 1;
	},
	nodeCreated(): void {
		values.nodesCreated += 1;
	},
	nodeRemoved(): void {
		values.nodesRemoved += 1;
	},
	nodeMoved(): void {
		values.nodesMoved += 1;
	},
	binding(): void {
		values.bindings += 1;
	},
	paint(): void {
		values.paints += 1;
	},
	layout(): void {
		values.layouts += 1;
	},
	parse(): void {
		values.parses += 1;
	},
	ownerCreated(): void {
		values.owners += 1;
	},
	ownerDisposed(): void {
		decrementGauge("owners");
	},
	timerStarted(): void {
		values.timers += 1;
	},
	timerStopped(): void {
		decrementGauge("timers");
	},
});
