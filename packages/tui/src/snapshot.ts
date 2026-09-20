import { emitRows } from "./core/emit";
import { RichText } from "./core/richtext";
import { createClock, registerClock, type Clock } from "./reactive/clock";
import { createViewportSignal, withViewport } from "./reactive/viewport";
import { getEffectQueue, type EffectQueue } from "./reactive/effects";
import { untrack, type JSX } from "./reactive";
import { resolveStyle } from "./style/cascade";
import { loadThemeSync } from "./theme/loader";
import { createThemeSignal, withThemeSignal } from "./theme/reactive";
import { theme } from "./theme/theme";
import type { Theme } from "./theme/theme";
import { disposeHostRoot, createHostRoot, type HostRoot } from "./host/node";
import { createPaintContext, paintHostTree } from "./host/paint";
import { createComponent, createHostOwner, insert } from "./host/renderer";
import { KeymapProvider, type Keymap } from "./host/keymap";
import { getKeybindings } from "./keybindings";
import { Damage, type HostNode } from "./host/types";
import { disposeFocusRoot, focusInitial, installFocusRuntime } from "./host/focus";
import { installInputRuntime, recordPaintSpan } from "./host/input";
import { getWidthConfigEpoch } from "./utils";

export interface SnapshotOptions {
	readonly columns: number;
	readonly rows?: number;
	readonly theme?: Theme;
	readonly clock?: Clock & { readonly flush?: () => void };
	/** Root key bindings used by standalone command previews. */
	readonly keymap?: Keymap;
}

export interface SnapshotRoot {
	readonly root: HostRoot;
	/** Preserve styled cell runs for production caches without an ANSI round trip. */
	frame(columns?: number): RichText;
	rows(columns?: number): string[];
	text(columns?: number): string[];
	flush(): void;
	dispose(): void;
}

function retainedRows(frame: RichText): string[] {
	const rows: string[] = new Array(frame.rows);
	for (let row = 0; row < frame.rows; row++) rows[row] = frame.rowText(row);
	return rows;
}

/** Mount a retained view in memory for one-shot production rendering. */
export function mountSnapshot(view: () => JSX.Element, options: SnapshotOptions): SnapshotRoot {
	const activeTheme = options.theme ?? (typeof theme === "undefined" ? loadThemeSync("dark") : theme);
	const ownsClock = options.clock === undefined;
	const stopFocus = installFocusRuntime();
	const stopInput = installInputRuntime();
	const clock = options.clock ?? createClock();
	let disposed = false;
	let effects: EffectQueue | undefined;
	const root = createHostRoot({
		theme: activeTheme,
		widthEpoch: getWidthConfigEpoch(),
		onDamage() {},
		subscribeClock(cadence, listener) {
			return clock.subscribe(cadence, listener);
		},
	});
	const themeSignal = createThemeSignal(activeTheme);
	const viewportSignal = createViewportSignal({ columns: options.columns, rows: options.rows ?? 24 });
	let disposeRender = (): void => {};
	createHostOwner(dispose => {
		disposeRender = dispose;
		registerClock(clock);
		effects = getEffectQueue();
		const content = withViewport(viewportSignal, () =>
			withThemeSignal(themeSignal, () =>
				createComponent(KeymapProvider, {
					keymap: options.keymap ?? getKeybindings(),
					get children() {
						return untrack(view);
					},
				}),
			),
		);
		insert(root.node, content as unknown as HostNode);
	});
	focusInitial(root.node);

	const assertMounted = (): void => {
		if (disposed) throw new Error("Snapshot root has been disposed");
	};
	const paint = (columns: number): RichText => {
		assertMounted();
		root.widthEpoch = getWidthConfigEpoch();
		const frame = new RichText();
		const context = createPaintContext(root, node => resolveStyle(node, { theme: root.theme }), {
			now: clock.freeze().at,
			availableHeight: options.rows ?? 24,
			recordSpan: recordPaintSpan,
		});
		paintHostTree(root, frame, columns, context);
		frame.finish();
		return frame;
	};
	const flushAt = (columns = options.columns): RichText => {
		assertMounted();
		options.clock?.flush?.();
		viewportSignal.update({ columns, rows: options.rows ?? 24 });
		let frame = paint(columns);
		effects?.flushLayoutHooks();
		if (root.node.damage !== Damage.None) frame = paint(columns);
		effects?.flushCommitHooks();
		return root.node.damage === Damage.None ? frame : paint(columns);
	};
	return {
		root,
		frame: flushAt,
		rows(columns = options.columns) {
			return emitRows(flushAt(columns), { mode: root.theme.getColorMode() });
		},
		text(columns = options.columns) {
			return retainedRows(flushAt(columns));
		},
		flush() {
			flushAt(options.columns);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			disposeRender();
			themeSignal.dispose();
			disposeHostRoot(root);
			disposeFocusRoot(root.node);
			stopInput();
			stopFocus();
			if (ownsClock) clock.dispose();
		},
	};
}

/** Render a retained view into complete ANSI rows outside test-only helpers. */
export function renderSnapshot(view: () => JSX.Element, options: SnapshotOptions): string[] {
	const snapshot = mountSnapshot(view, options);
	try {
		return snapshot.rows();
	} finally {
		snapshot.dispose();
	}
}
