/** Test helpers for retained reactive views at the cell-native frame boundary. */
import { counters as readCounters, instrument, resetCounters, type Counters } from "./instrumentation";
import { createClock, type Clock } from "./reactive/clock";
import type { JSX } from "./reactive";
import { mountSnapshot, type SnapshotRoot } from "./snapshot";
import type { Theme } from "./theme/theme";

export type { Counters } from "./instrumentation";

/** Deterministic clock accepted by retained-tree tests. */
export interface FakeClock extends Clock {
	advance(ms: number): void;
	flush?(): void;
}

/** Options for mounting a retained reactive view in memory. */
export interface MountForTestOptions {
	readonly width?: number;
	readonly height?: number;
	readonly theme?: Theme;
	readonly clock?: Clock & { readonly flush?: () => void };
}

/** Handle for inspecting and driving an in-memory retained host root. */
export interface TestRoot {
	readonly root: SnapshotRoot["root"];
	rows(width?: number): string[];
	text(width?: number): string[];
	flush(): void;
	dispose(): void;
	counters(): Counters;
}

/** Mount a reactive view into an in-memory retained host tree. */
export function mountForTest(view: () => JSX.Element, options: MountForTestOptions = {}): TestRoot {
	resetCounters();
	const ownsClock = options.clock === undefined;
	const clock = options.clock ?? createClock();
	const snapshot = mountSnapshot(view, {
		columns: options.width ?? 80,
		rows: options.height ?? 24,
		theme: options.theme,
		clock,
	});
	instrument.ownerCreated();
	instrument.viewRun();
	let disposed = false;
	return {
		root: snapshot.root,
		rows(width) {
			return snapshot.rows(width);
		},
		text(width) {
			return snapshot.text(width);
		},
		flush() {
			snapshot.flush();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			snapshot.dispose();
			if (ownsClock) clock.dispose();
			instrument.ownerDisposed();
		},
		counters: readCounters,
	};
}

/** Paint a retained view at `width` and return ANSI rows. */
export function renderToRows(view: () => JSX.Element, width: number): string[] {
	const mounted = mountForTest(view, { width });
	try {
		return mounted.rows();
	} finally {
		mounted.dispose();
	}
}

/** Paint a retained view at `width` and return plain visible text rows. */
export function renderToText(view: () => JSX.Element, width: number): string[] {
	const mounted = mountForTest(view, { width });
	try {
		return mounted.text();
	} finally {
		mounted.dispose();
	}
}
