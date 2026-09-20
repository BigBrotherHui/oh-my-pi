import type { ElementImpl } from "./types";

const elements = new Map<string, ElementImpl>();

/** Register one intrinsic element implementation by its unique tag. */
export function registerElement(impl: ElementImpl): void {
	const current = elements.get(impl.tag);
	if (current === impl) return;
	if (current !== undefined) throw new Error(`Host element <${impl.tag}> is already registered`);
	elements.set(impl.tag, impl);
}

/** Resolve an intrinsic element implementation or throw an error naming its tag. */
export function elementFor(tag: string): ElementImpl {
	const impl = elements.get(tag);
	if (impl === undefined) throw new Error(`Unknown host element <${tag}>`);
	return impl;
}
