import { createSignal, type Accessor } from "solid-js";

const [tight, setTight] = createSignal(false);

/** Read the shared tight-layout preference from legacy layout helpers or retained views. */
export function isTightLayout(): boolean {
	return tight();
}

/** Publish a tight-layout change to mounted presentation owners. */
export function setTightLayout(value: boolean): void {
	setTight(value);
}

/** Observe tight layout when deriving responsive padding in a retained view. */
export function useTightLayout(): Accessor<boolean> {
	return tight;
}
