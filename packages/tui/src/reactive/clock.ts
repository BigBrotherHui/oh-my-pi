import { createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";
import type { Accessor, Owner, Setter } from "solid-js";
import { instrument } from "../instrumentation";

/** Shared animation cadences supported by the root clock. */
export type ClockCadence = "frame" | "spinner" | "second";

/** Immutable clock values used by one committed frame. */
export interface ClockSnapshot {
	/** Wall-clock instant represented by this snapshot. */
	readonly at: number;
	/** Frame-cadence tick index at `at`. */
	readonly frame: number;
	/** Spinner-cadence tick index at `at`. */
	readonly spinner: number;
	/** Second-cadence tick index at `at`. */
	readonly second: number;
}

/** Options for constructing a root clock. */
export interface ClockOptions {
	/** Wall-clock source, injectable for deterministic roots. */
	readonly now?: () => number;
	/** Frame interval in milliseconds; defaults to 30fps. */
	readonly frameMs?: number;
}

/** A lazily scheduled clock shared by one reactive root. */
export interface Clock {
	/** Configured frame interval in milliseconds. */
	readonly frameMs: number;
	/** Read the clock's current wall time. */
	readonly now: () => number;
	/** Create a lazy, owner-scoped cadence accessor. */
	access(cadence: ClockCadence, owner?: Owner | null): Accessor<number>;
	/** Subscribe directly to cadence samples for host elements. */
	subscribe(cadence: ClockCadence, listener: (now: number) => void): () => void;
	/** Replace and return the immutable committed-time snapshot. */
	freeze(at?: number): ClockSnapshot;
	/** Return the last committed-time snapshot. */
	frozen(): ClockSnapshot;
	/** Stop every live cadence timer. */
	dispose(): void;
}

interface CadenceState {
	readonly read: Accessor<number>;
	readonly write: Setter<number>;
	readonly listeners: Set<(now: number) => void>;
	subscribers: number;
	timer: NodeJS.Timeout | undefined;
}

const SPINNER_MS = 80;
const SECOND_MS = 1_000;
const DEFAULT_FRAME_MS = 1_000 / 30;
const CLOCK = Symbol("pi-tui.clock");
const FROZEN_CLOCK = Symbol("pi-tui.frozenClock");
const CLOCK_SUBSCRIPTIONS = Symbol("pi-tui.clockSubscriptions");

interface ClockOwner extends Owner {
	[CLOCK]?: Clock;
	[FROZEN_CLOCK]?: number;
	[CLOCK_SUBSCRIPTIONS]?: Set<(at: number) => void>;
}

function frozenTime(owner: Owner | null): number | undefined {
	let current: ClockOwner | null = owner;
	while (current) {
		if (current[FROZEN_CLOCK] !== undefined) return current[FROZEN_CLOCK];
		current = current.owner;
	}
	return undefined;
}

/** Release a retired view's clock subscriptions while retaining its non-time display bindings. */
export function freezeOwnerClock(owner: Owner, at: number): void {
	const scope: ClockOwner = owner;
	if (scope[FROZEN_CLOCK] !== undefined) return;
	scope[FROZEN_CLOCK] = at;
	const subscriptions = scope[CLOCK_SUBSCRIPTIONS];
	if (subscriptions) {
		for (const freeze of subscriptions) freeze(at);
		subscriptions.clear();
		delete scope[CLOCK_SUBSCRIPTIONS];
	}
	for (const child of owner.owned ?? []) freezeOwnerClock(child, at);
}

function rootOf(owner: Owner): Owner {
	let root = owner;
	while (root.owner) root = root.owner;
	return root;
}

function cadenceMs(cadence: ClockCadence, frameMs: number): number {
	switch (cadence) {
		case "frame":
			return frameMs;
		case "spinner":
			return SPINNER_MS;
		case "second":
			return SECOND_MS;
	}
}

function tickAt(at: number, cadence: ClockCadence, frameMs: number): number {
	return Math.floor(at / cadenceMs(cadence, frameMs));
}

function snapshotAt(at: number, frameMs: number): ClockSnapshot {
	return Object.freeze({
		at,
		frame: tickAt(at, "frame", frameMs),
		spinner: tickAt(at, "spinner", frameMs),
		second: tickAt(at, "second", frameMs),
	});
}

/** Create a root clock whose cadence timers exist only while observed. */
export function createClock(options: ClockOptions = {}): Clock {
	const now = options.now ?? Date.now;
	const frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
	if (!(frameMs > 0) || !Number.isFinite(frameMs)) throw new RangeError("frameMs must be a positive finite number");

	const initialAt = now();
	const cadences: Record<ClockCadence, CadenceState> = {
		frame: makeState(initialAt),
		spinner: makeState(initialAt),
		second: makeState(initialAt),
	};
	let frozenSnapshot = snapshotAt(initialAt, frameMs);
	let disposed = false;

	function makeState(initial: number): CadenceState {
		const [read, write] = createSignal(initial, { equals: false });
		return { read, write, listeners: new Set(), subscribers: 0, timer: undefined };
	}

	function stop(state: CadenceState): void {
		if (!state.timer) return;
		clearInterval(state.timer);
		state.timer = undefined;
		instrument.timerStopped();
	}

	function subscribe(cadence: ClockCadence, listener?: (now: number) => void): () => void {
		if (disposed) return () => {};
		const state = cadences[cadence];
		if (listener) state.listeners.add(listener);
		state.subscribers += 1;
		if (state.subscribers === 1) {
			const at = now();
			state.write(at);
			const publish = (): void => {
				const next = now();
				state.write(next);
				for (const notify of state.listeners) notify(next);
			};
			state.timer = setInterval(publish, cadenceMs(cadence, frameMs));
			state.timer.unref?.();
			instrument.timerStarted();
		}
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			if (listener) state.listeners.delete(listener);
			if (state.subscribers === 0) return;
			state.subscribers -= 1;
			if (state.subscribers === 0) stop(state);
		};
	}

	const clock: Clock = {
		frameMs,
		now,
		access(cadence, owner = getOwner()) {
			const state = cadences[cadence];
			let unsubscribe: (() => void) | undefined;
			let latest: number | undefined;
			let frozen: number | undefined;
			let released = false;
			const freeze = (at: number): void => {
				frozen = latest ?? at;
				unsubscribe?.();
				unsubscribe = undefined;
			};
			return () => {
				if (frozen !== undefined) return frozen;
				const stoppedAt = frozenTime(owner);
				if (stoppedAt !== undefined) {
					freeze(stoppedAt);
					return frozen ?? stoppedAt;
				}
				if (!unsubscribe && owner && !disposed && !released) {
					unsubscribe = subscribe(cadence);
					const scope: ClockOwner = owner;
					const subscriptions = (scope[CLOCK_SUBSCRIPTIONS] ??= new Set());
					subscriptions.add(freeze);
					runWithOwner(owner, () =>
						onCleanup(() => {
							unsubscribe?.();
							unsubscribe = undefined;
							released = true;
							subscriptions.delete(freeze);
							if (subscriptions.size === 0) delete scope[CLOCK_SUBSCRIPTIONS];
						}),
					);
				}
				latest = state.read();
				return latest;
			};
		},
		subscribe(cadence, listener) {
			return subscribe(cadence, listener);
		},
		freeze(at = now()) {
			frozenSnapshot = snapshotAt(at, frameMs);
			return frozenSnapshot;
		},
		frozen() {
			return frozenSnapshot;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const cadence of ["frame", "spinner", "second"] as const) {
				const state = cadences[cadence];
				state.subscribers = 0;
				state.listeners.clear();
				stop(state);
			}
		},
	};
	return clock;
}

/** Bind a clock to the current Solid root and return an idempotent unbinder. */
export function registerClock(clock: Clock, owner: Owner | null = getOwner()): () => void {
	if (!owner) throw new Error("registerClock must run within a reactive owner or receive one");
	const root = rootOf(owner) as ClockOwner;
	const previous = root[CLOCK];
	root[CLOCK] = clock;
	let active = true;
	const unregister = (): void => {
		if (!active) return;
		active = false;
		if (root[CLOCK] !== clock) return;
		if (previous) root[CLOCK] = previous;
		else delete root[CLOCK];
	};
	runWithOwner(root, () => onCleanup(unregister));
	return unregister;
}

/** Read a shared cadence, subscribing lazily until the calling owner is disposed. */
export function useClock(cadence: ClockCadence): Accessor<number> {
	const owner = getOwner();
	if (!owner) throw new Error("useClock must run within a reactive owner");
	const root = rootOf(owner) as ClockOwner;
	let clock = root[CLOCK];
	if (!clock) {
		clock = createClock();
		root[CLOCK] = clock;
		const ownedClock = clock;
		runWithOwner(root, () =>
			onCleanup(() => {
				if (root[CLOCK] === ownedClock) delete root[CLOCK];
				ownedClock.dispose();
			}),
		);
	}
	return clock.access(cadence, owner);
}
