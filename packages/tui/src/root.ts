import { Compositor } from "./compositor/compositor";
import { createComponent, render as renderHost } from "./host/renderer";
import { disposeFocusRoot, focusInitial, installFocusRuntime, setFocusRootActive } from "./host/focus";
import { installInputRuntime } from "./host/input";
import { KeymapProvider, type Keymap } from "./host/keymap";
import { dispatchHostInput, withOverlayRuntime } from "./host/overlay";
import { getKeybindings } from "./keybindings";
import { createEffect, getOwner, isTightLayout, type JSX } from "./reactive";
import { Damage } from "./host/types";
import { createClock, registerClock, type Clock } from "./reactive/clock";
import { createViewportSignal, withViewport } from "./reactive/viewport";
import type { Terminal } from "./terminal";
import type { TerminalInfo } from "./terminal-capabilities";
import { createThemeSignal, withThemeSignal } from "./theme/reactive";
import type { Theme } from "./theme/theme";
import { TUI } from "./tui";

/** Immutable terminal capabilities supplied to a reactive root. */
export type TerminalCapabilities = Readonly<TerminalInfo>;

/** Services and root-scoped dependencies used by `render`. */
export interface RootOptions {
	readonly terminal: Terminal;
	readonly theme: Theme;
	readonly keymap?: Keymap;
	readonly clock?: Clock;
	readonly capabilities?: TerminalCapabilities;
	/** Clear native terminal scrollback before the root's first frame. */
	readonly clearScrollback?: boolean;
	/** Keep cooked input buffered until the application installs its editor handlers. */
	readonly deferInput?: boolean;
}

/** Lifetime handle for one mounted reactive terminal tree. */
export interface RootHandle {
	readonly tui: TUI;
	dispose(): void;
}

/** Mount a Solid view into a retained host tree and start its terminal engine. */
export function render(view: () => JSX.Element, options: RootOptions): RootHandle {
	const tui = new TUI(options.terminal);
	const clock = options.clock ?? createClock();
	const themeSignal = createThemeSignal(options.theme, {
		capabilities: options.capabilities,
		invalidate(damage) {
			compositor?.invalidate(damage);
		},
	});
	const viewportSignal = createViewportSignal({ columns: options.terminal.columns, rows: options.terminal.rows });
	const compositor = new Compositor({ tui, theme: themeSignal.theme, clock, onViewport: viewportSignal.update });
	const activeCompositor = compositor;
	const stopFocusRuntime = installFocusRuntime();
	const stopInputRuntime = installInputRuntime();
	let unbindClock: (() => void) | undefined;
	const disposeSolid = renderHost(() => {
		const owner = getOwner();
		if (owner === null) throw new Error("Reactive TUI render requires a Solid owner");
		activeCompositor.setOwner(owner);
		unbindClock = registerClock(clock, owner);
		createEffect(() => {
			isTightLayout();
			activeCompositor.invalidate(Damage.Layout);
		});
		return withViewport(viewportSignal, () =>
			withThemeSignal(themeSignal, () =>
				createComponent(KeymapProvider, {
					keymap: options.keymap ?? getKeybindings(),
					get children() {
						return withOverlayRuntime({ tui, compositor: activeCompositor, owner: getOwner() }, view);
					},
				}),
			),
		);
	}, activeCompositor.root.node);

	focusInitial(activeCompositor.root.node);
	tui.setHostFocusHandler(active => setFocusRootActive(activeCompositor.root.node, active));
	tui.setHostInputHandler(data => {
		const viewport = tui.getMutableViewport();
		dispatchHostInput(activeCompositor.root, data, viewport.top);
	});
	tui.setFrameProvider(activeCompositor.provider);
	tui.start({ clearScrollback: options.clearScrollback, deferInput: options.deferInput });

	let disposed = false;
	return {
		tui,
		dispose(): void {
			if (disposed) return;
			disposed = true;
			try {
				tui.renderNow();
			} finally {
				try {
					// Shutdown flushes pending history through the still-mounted view and compositor.
					tui.stop();
				} finally {
					disposeSolid();
					unbindClock?.();
					disposeFocusRoot(activeCompositor.root.node);
					stopInputRuntime();
					stopFocusRuntime();
					themeSignal.dispose();
					clock.dispose();
					activeCompositor.dispose();
					tui.setHostInputHandler(undefined);
					tui.setHostFocusHandler(undefined);
					tui.setFrameProvider(undefined, false);
				}
			}
		},
	};
}
