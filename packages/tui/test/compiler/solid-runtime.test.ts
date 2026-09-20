import { expect, test } from "bun:test";
import { createEffect, createRoot, createSignal } from "solid-js";

test("preload selects one reactive Solid engine for plain TypeScript", () => {
	let runs = 0;
	let update: (() => void) | undefined;
	let disposeRoot: (() => void) | undefined;
	createRoot(dispose => {
		disposeRoot = dispose;
		const [value, setValue] = createSignal(0);
		update = () => setValue(current => current + 1);
		createEffect(() => {
			value();
			runs++;
		});
	});
	if (!update || !disposeRoot) throw new Error("Solid root did not expose its lifecycle controls");
	expect(runs).toBe(1);
	update();
	expect(runs).toBe(2);
	disposeRoot();
});
