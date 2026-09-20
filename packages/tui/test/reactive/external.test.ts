import { describe, expect, it } from "bun:test";
import {
	createEffect,
	createGenerationGuard,
	createRoot,
	fromEvent,
	fromSnapshots,
	type GenerationGuard,
} from "../../src/reactive";

describe("external reactive adapters", () => {
	it("tracks pushed events and releases the subscription with its owner", () => {
		let listener: ((value: number) => void) | undefined;
		let subscriptions = 0;
		let unsubscriptions = 0;
		const observed: number[] = [];
		const dispose = createRoot(rootDispose => {
			const value = fromEvent<number>(notify => {
				listener = notify;
				subscriptions += 1;
				return () => {
					listener = undefined;
					unsubscriptions += 1;
				};
			}, 1);
			createEffect(() => observed.push(value()));
			return rootDispose;
		});

		expect(subscriptions).toBe(1);
		listener?.(2);
		expect(observed).toEqual([1, 2]);
		dispose();
		expect(unsubscriptions).toBe(1);
		expect(listener).toBeUndefined();
	});

	it("accepts observable-style unsubscribe objects", () => {
		let listener: ((value: string) => void) | undefined;
		let unsubscribed = false;
		const values: string[] = [];
		const dispose = createRoot(rootDispose => {
			const value = fromEvent(
				{
					subscribe(notify) {
						listener = notify;
						return {
							unsubscribe() {
								unsubscribed = true;
								listener = undefined;
							},
						};
					},
				},
				"initial",
			);
			createEffect(() => values.push(value()));
			return rootDispose;
		});

		listener?.("updated");
		expect(values).toEqual(["initial", "updated"]);
		dispose();
		expect(unsubscribed).toBeTrue();
	});

	it("pulls snapshots and respects the supplied equality", () => {
		let snapshot = { version: 1, transient: "a" };
		let notify: (() => void) | undefined;
		let runs = 0;
		const dispose = createRoot(rootDispose => {
			const value = fromSnapshots(
				() => snapshot,
				listener => {
					notify = listener;
					return () => {
						notify = undefined;
					};
				},
				(previous, next) => previous.version === next.version,
			);
			createEffect(() => {
				value();
				runs += 1;
			});
			return rootDispose;
		});

		snapshot = { version: 1, transient: "b" };
		notify?.();
		expect(runs).toBe(1);
		snapshot = { version: 2, transient: "c" };
		notify?.();
		expect(runs).toBe(2);
		dispose();
		expect(notify).toBeUndefined();
	});

	it("invalidates pending generations when their owner is disposed", () => {
		let guard!: GenerationGuard;
		const dispose = createRoot(rootDispose => {
			guard = createGenerationGuard();
			return rootDispose;
		});
		const generation = guard.next();

		dispose();

		expect(
			guard.commit(generation, () => {
				throw new Error("stale generation committed");
			}),
		).toBeFalse();
	});

	it("rejects a stale async completion after a newer generation commits", async () => {
		const first = Promise.withResolvers<string>();
		const second = Promise.withResolvers<string>();
		let committed = "initial";
		const accepted: boolean[] = [];
		const dispose = createRoot(rootDispose => {
			const guard = createGenerationGuard();
			const load = async (promise: Promise<string>): Promise<void> => {
				const generation = guard.next();
				const value = await promise;
				accepted.push(
					guard.commit(generation, () => {
						committed = value;
					}),
				);
			};
			void load(first.promise);
			void load(second.promise);
			return rootDispose;
		});

		second.resolve("newest");
		await second.promise;
		await Promise.resolve();
		first.resolve("stale");
		await first.promise;
		await Promise.resolve();

		expect(committed).toBe("newest");
		expect(accepted).toEqual([true, false]);
		dispose();
	});
});
