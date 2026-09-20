import { describe, expect, it } from "bun:test";
import { batch, createEffect, createRoot, createSignal, onCleanup } from "../../src/reactive";

describe("reactive semantics", () => {
	it("drops obsolete dependencies after a conditional read changes branches", () => {
		const values: number[] = [];
		let setUseLeft!: (value: boolean) => boolean;
		let setLeft!: (value: number) => number;
		let setRight!: (value: number) => number;
		const dispose = createRoot(rootDispose => {
			const [useLeft, writeUseLeft] = createSignal(true);
			const [left, writeLeft] = createSignal(1);
			const [right, writeRight] = createSignal(10);
			setUseLeft = writeUseLeft;
			setLeft = writeLeft;
			setRight = writeRight;
			createEffect(() => values.push(useLeft() ? left() : right()));
			return rootDispose;
		});

		expect(values).toEqual([1]);
		setLeft(2);
		expect(values).toEqual([1, 2]);
		setUseLeft(false);
		expect(values).toEqual([1, 2, 10]);
		setLeft(3);
		expect(values).toEqual([1, 2, 10]);
		setRight(11);
		expect(values).toEqual([1, 2, 10, 11]);
		dispose();
	});

	it("publishes a batch without intermediate observable state", () => {
		const observed: string[] = [];
		let setFirst!: (value: number) => number;
		let setSecond!: (value: number) => number;
		const dispose = createRoot(rootDispose => {
			const [first, writeFirst] = createSignal(0);
			const [second, writeSecond] = createSignal(0);
			setFirst = writeFirst;
			setSecond = writeSecond;
			createEffect(() => observed.push(`${first()}:${second()}`));
			return rootDispose;
		});

		batch(() => {
			setFirst(1);
			setSecond(2);
		});
		expect(observed).toEqual(["0:0", "1:2"]);
		dispose();
	});

	it("flattens nested batches into one transaction", () => {
		const observed: string[] = [];
		let setFirst!: (value: number) => number;
		let setSecond!: (value: number) => number;
		const dispose = createRoot(rootDispose => {
			const [first, writeFirst] = createSignal(0);
			const [second, writeSecond] = createSignal(0);
			setFirst = writeFirst;
			setSecond = writeSecond;
			createEffect(() => observed.push(`${first()}:${second()}`));
			return rootDispose;
		});

		batch(() => {
			setFirst(1);
			batch(() => {
				setSecond(2);
				setFirst(3);
			});
			setSecond(4);
		});
		expect(observed).toEqual(["0:0", "3:4"]);
		dispose();
	});

	it("runs replaceable effect cleanup before the replacement and once on dispose", () => {
		const order: string[] = [];
		let setVersion!: (value: number) => number;
		const dispose = createRoot(rootDispose => {
			const [version, writeVersion] = createSignal(0);
			setVersion = writeVersion;
			createEffect(() => {
				const current = version();
				order.push(`run:${current}`);
				onCleanup(() => order.push(`cleanup:${current}`));
			});
			return rootDispose;
		});

		setVersion(1);
		dispose();
		expect(order).toEqual(["run:0", "cleanup:0", "run:1", "cleanup:1"]);
	});
});
