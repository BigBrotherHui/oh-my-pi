import { createSignal, from, getOwner, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

/** Teardown shapes accepted from callback and observable-style services. */
export type ExternalTeardown = void | (() => void) | { unsubscribe(): void };

/** Callback subscription accepted by `fromEvent`. */
export type EventSubscriber<T> = (listener: (value: T) => void) => ExternalTeardown;

/** Observable-style subscription accepted by `fromEvent`. */
export interface EventSource<T> {
	/** Subscribe to pushed values using an observable-style teardown. */
	subscribe(listener: (value: T) => void): ExternalTeardown;
}

function teardown(subscription: ExternalTeardown): () => void {
	if (!subscription) return () => {};
	if (typeof subscription === "function") return subscription;
	return () => subscription.unsubscribe();
}

/** Adapt a pushed event source into an owner-scoped Solid accessor. */
export function fromEvent<T>(source: EventSubscriber<T> | EventSource<T>, initial: T): Accessor<T> {
	if (!getOwner()) throw new Error("fromEvent must run within a reactive owner");
	return from<T>(setter => {
		const subscription =
			typeof source === "function"
				? source(value => setter(() => value))
				: source.subscribe(value => setter(() => value));
		return teardown(subscription);
	}, initial);
}

/** Adapt a pull snapshot plus invalidation subscription into a Solid accessor. */
export function fromSnapshots<T>(
	get: () => T,
	subscribe: (listener: () => void) => ExternalTeardown,
	equals: (previous: T, next: T) => boolean = Object.is,
): Accessor<T> {
	if (!getOwner()) throw new Error("fromSnapshots must run within a reactive owner");
	const [snapshot, setSnapshot] = createSignal(get(), { equals });
	const unsubscribe = teardown(subscribe(() => setSnapshot(() => get())));
	setSnapshot(() => get());
	onCleanup(unsubscribe);
	return snapshot;
}

/** Monotonic guard that prevents stale asynchronous work from committing. */
export interface GenerationGuard {
	/** Begin work and return its monotonically increasing generation. */
	next(): number;
	/** Report whether a generation may still commit. */
	isCurrent(generation: number): boolean;
	/** Apply current-generation work, returning false for stale work. */
	commit(generation: number, apply: () => void): boolean;
	/** Reject all work captured before this call. */
	invalidate(): void;
}

/** Create an owner-invalidated generation guard for resource-style loaders. */
export function createGenerationGuard(): GenerationGuard {
	let generation = 0;
	let active = true;
	const guard: GenerationGuard = {
		next() {
			active = true;
			generation += 1;
			return generation;
		},
		isCurrent(candidate) {
			return active && candidate === generation;
		},
		commit(candidate, apply) {
			if (!active || candidate !== generation) return false;
			apply();
			return true;
		},
		invalidate() {
			active = false;
			generation += 1;
		},
	};
	if (getOwner()) onCleanup(guard.invalidate);
	return guard;
}
