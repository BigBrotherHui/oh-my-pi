import { createComponent, createContext, createSignal, type Accessor, type JSX, untrack, useContext } from "solid-js";
import type { ViewportSize } from "../tui";

/** Root-owned terminal geometry shared by views and detached overlay portals. */
export interface ViewportSignal {
	readonly size: Accessor<ViewportSize>;
	update(size: ViewportSize): void;
}

const ViewportContext = createContext<Accessor<ViewportSize>>();

/** Create a geometry signal that publishes only actual terminal-size changes. */
export function createViewportSignal(initial: ViewportSize): ViewportSignal {
	const [size, setSize] = createSignal(initial);
	return {
		size,
		update(next) {
			const previous = size();
			if (previous.columns !== next.columns || previous.rows !== next.rows) setSize(next);
		},
	};
}

/** Supply terminal dimensions to a root's views and inherited overlay owners. */
export function withViewport(signal: ViewportSignal, view: () => JSX.Element): JSX.Element {
	return createComponent(ViewportContext.Provider, {
		value: signal.size,
		get children() {
			return untrack(view);
		},
	});
}

/** Read live physical terminal dimensions without a per-view resize listener or timer. */
export function useViewport(): Accessor<ViewportSize> {
	const size = useContext(ViewportContext);
	if (!size) throw new Error("useViewport() requires a reactive TUI root");
	return size;
}
