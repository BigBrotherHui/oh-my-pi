import {
	createComponent,
	createContext,
	createEffect,
	createRoot,
	onCleanup,
	runWithOwner,
	type JSX,
	type Owner,
	untrack,
	useContext,
} from "solid-js";
import { Compositor } from "../compositor/compositor";
import { createClock } from "../reactive/clock";
import { createViewportSignal, withViewport, type ViewportSignal } from "../reactive/viewport";
import { theme } from "../theme/theme";
import { loadThemeSync } from "../theme/loader";
import { createThemeSignal, withThemeSignal } from "../theme/reactive";
import { RichText } from "../core/richtext";
import { parseSgrMouse } from "../mouse";
import type { HostRoot } from "./node";
import { focusInitial, setFocusRootActive } from "./focus";
import { render as renderHost } from "./renderer";
import { dispatchKey, dispatchMouse, dispatchPaste, focusedInputTarget, HostKeyEvent, HostMouseEvent } from "./input";
import { Damage } from "./types";
import type {
	TerminalOverlay,
	OverlayAnchor,
	OverlayHandle,
	OverlayMargin,
	OverlayOptions,
	SizeValue,
	TUI,
} from "../tui";

/** Root services consumed by overlay portals. */
export interface OverlayRuntime {
	readonly tui: TUI;
	readonly compositor: Compositor;
	/** Provider owner whose theme, keymap and shared clock overlays inherit. */
	readonly owner?: Owner | null;
	/** Geometry scope for standalone TUI instances without an existing reactive root. */
	readonly viewport?: ViewportSignal;
}

/** Props accepted by the retained-host overlay portal. */
export interface PortalProps {
	readonly to: "overlay";
	readonly children?: JSX.Element;
	readonly fullscreen?: boolean;
	/** Passive overlays leave keyboard focus on the underlying editor or dialog. */
	readonly modal?: boolean;
	readonly anchor?: OverlayAnchor;
	readonly margin?: OverlayMargin | number;
	readonly width?: SizeValue;
	readonly minWidth?: number;
	readonly maxHeight?: SizeValue;
	readonly offsetX?: number;
	readonly offsetY?: number;
	readonly row?: SizeValue;
	readonly col?: SizeValue;
	readonly visible?: (columns: number, rows: number) => boolean;
	readonly mouseTracking?: boolean;
}

const OverlayContext = createContext<OverlayRuntime>();

/** Access terminal services from a view mounted under the active root or an inherited overlay. */
export function useTui(): TUI {
	const runtime = useContext(OverlayContext);
	if (!runtime) throw new Error("useTui() requires a live TUI root");
	return runtime.tui;
}

const kOverlayRuntime = Symbol.for("@oh-my-pi/pi-tui/overlay-runtime");

interface TuiWithOverlayRuntime extends TUI {
	[kOverlayRuntime]?: OverlayRuntime;
}

/** Retrieve the active overlay runtime registered for a TUI instance. */
export function getOverlayRuntime(tui: TUI): OverlayRuntime | undefined {
	return (tui as TuiWithOverlayRuntime)[kOverlayRuntime];
}

/** Explicitly register an overlay runtime with a TUI instance. */
export function registerOverlayRuntime(tui: TUI, runtime: OverlayRuntime): void {
	(tui as TuiWithOverlayRuntime)[kOverlayRuntime] = runtime;
}

export interface OverlayDisposer {
	(): void;
	hide(): void;
	dispose(): void;
}

export function createOverlayDisposer(dispose: () => void): OverlayDisposer {
	return Object.assign(() => dispose(), {
		hide: dispose,
		dispose,
	});
}

/** Join controller cleanup and portal removal without letting an assigned dispose method replace either one. */
export function bindOverlayController<T extends { dispose(): void }>(
	overlay: OverlayDisposer,
	controller: T,
): OverlayDisposer & T {
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		try {
			controller.dispose();
		} finally {
			overlay();
		}
	};
	return Object.assign(createOverlayDisposer(close), controller, { hide: close, dispose: close });
}

class HostOverlayComponent implements TerminalOverlay {
	#focused = false;
	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		setFocusRootActive(this.#root.node, value);
	}
	readonly wantsKeyRelease = true;
	readonly #runtime: OverlayRuntime;
	readonly #root: HostRoot;
	#inputOrigin = { row: 0, col: 0 };

	constructor(runtime: OverlayRuntime, root: HostRoot) {
		this.#runtime = runtime;
		this.#root = root;
		setFocusRootActive(root.node, false);
	}

	get root() {
		return this.#root.node;
	}

	inputTarget() {
		return focusedInputTarget(this.#root);
	}

	invalidate(): void {
		this.#runtime.compositor.invalidate(Damage.Layout);
	}

	renderFrame(width: number, height: number): RichText {
		const frame = new RichText();
		this.#runtime.compositor.paintDetachedRoot(this.#root, frame, width, height);
		frame.finish();
		return frame;
	}

	setInputOrigin(origin: { row: number; col: number }): void {
		this.#inputOrigin = origin;
	}

	handleInput(data: string): void {
		dispatchHostInput(this.#root, data, this.#inputOrigin.row, this.#inputOrigin.col);
	}

	pasteText(text: string): void {
		dispatchPaste(this.#root, text);
	}
}

function overlayOptions(props: PortalProps): OverlayOptions {
	return {
		get width() {
			return props.width;
		},
		get minWidth() {
			return props.minWidth;
		},
		get maxHeight() {
			return props.maxHeight;
		},
		get anchor() {
			return props.anchor;
		},
		get offsetX() {
			return props.offsetX;
		},
		get offsetY() {
			return props.offsetY;
		},
		get row() {
			return props.row;
		},
		get col() {
			return props.col;
		},
		get margin() {
			return props.margin;
		},
		get visible() {
			return props.visible;
		},
		get fullscreen() {
			return props.fullscreen;
		},
		get modal() {
			return props.modal;
		},
		get mouseTracking() {
			return props.mouseTracking;
		},
	};
}

/** Install root overlay services around a view without requiring TSX in root.ts. */
export function withOverlayRuntime(runtime: OverlayRuntime, view: () => JSX.Element): JSX.Element {
	(runtime.tui as TuiWithOverlayRuntime)[kOverlayRuntime] = runtime;
	return createComponent(OverlayContext.Provider, {
		value: runtime,
		get children() {
			return untrack(view);
		},
	});
}

/** Mount a Solid view into the TUI overlay stack, returning a disposer matching OverlayHandle. */
export function mountOverlay(tui: TUI, view: () => JSX.Element): OverlayDisposer {
	let runtime = (tui as TuiWithOverlayRuntime)[kOverlayRuntime];
	if (!runtime) {
		const clock = createClock();
		const viewport = createViewportSignal({ columns: tui.terminal.columns, rows: tui.terminal.rows });
		const initialTheme = theme ?? loadThemeSync("dark");
		const compositor = new Compositor({
			tui,
			theme: () => theme ?? initialTheme,
			clock,
			onViewport: viewport.update,
		});
		runtime = { tui, compositor, viewport };
		(tui as TuiWithOverlayRuntime)[kOverlayRuntime] = runtime;
	}
	const activeRuntime = runtime;
	let disposeRoot!: () => void;
	let disposePalette: (() => void) | undefined;
	runWithOwner(activeRuntime.owner ?? null, () => {
		createRoot(dispose => {
			disposeRoot = dispose;
			if (activeRuntime.owner) {
				withOverlayRuntime(activeRuntime, view);
			} else {
				const palette = createThemeSignal(activeRuntime.compositor.root.theme, {
					invalidate: damage => activeRuntime.compositor.invalidate(damage),
				});
				disposePalette = () => palette.dispose();
				onCleanup(() => {
					palette.dispose();
					disposePalette = undefined;
				});
				const viewport =
					activeRuntime.viewport ??
					createViewportSignal({ columns: tui.terminal.columns, rows: tui.terminal.rows });
				withViewport(viewport, () => withThemeSignal(palette, () => withOverlayRuntime(activeRuntime, view)));
			}
		});
		if (activeRuntime.owner) onCleanup(disposeRoot);
	});
	return createOverlayDisposer(() => {
		try {
			disposeRoot();
		} finally {
			disposePalette?.();
			disposePalette = undefined;
		}
	});
}

/** Mount children into a detached retained tree registered on the TUI overlay stack. */
export function Portal(props: PortalProps): JSX.Element {
	if (props.to !== "overlay") throw new Error(`Unsupported portal target: ${props.to}`);
	const runtime = useContext(OverlayContext);
	if (runtime === undefined) throw new Error("<Portal> requires a reactive TUI root");
	const root = runtime.compositor.createDetachedRoot();
	const disposeView = renderHost(() => props.children, root.node);
	focusInitial(root.node);
	const component = new HostOverlayComponent(runtime, root);
	const handle: OverlayHandle = runtime.tui.showOverlay(component, overlayOptions(props));

	createEffect(() => {
		void props.fullscreen;
		void props.modal;
		void props.anchor;
		void props.margin;
		void props.width;
		void props.minWidth;
		void props.maxHeight;
		void props.offsetX;
		void props.offsetY;
		void props.row;
		void props.col;
		void props.visible;
		void props.mouseTracking;
		runtime.tui.requestRender?.();
	});
	onCleanup(() => {
		try {
			handle.hide();
		} finally {
			try {
				disposeView();
			} finally {
				runtime.compositor.disposeDetachedRoot(root);
			}
		}
	});
	return undefined;
}

/** Dispatch raw terminal input through one retained host root. */
export function dispatchHostInput(root: HostRoot, data: string, rowOffset = 0, colOffset = 0): boolean {
	const mouse = data.startsWith("\x1b[<") ? parseSgrMouse(data) : null;
	if (mouse === null) return dispatchKey(root.node, new HostKeyEvent(data));
	const action = mouse.wheel !== null ? "wheel" : mouse.release ? "up" : mouse.motion ? "move" : "down";
	return dispatchMouse(
		root.node,
		new HostMouseEvent({
			row: mouse.row - rowOffset,
			col: mouse.col - colOffset,
			action,
			button: mouse.button & 3,
			rawButton: mouse.button,
			data,
			wheel: mouse.wheel ?? 0,
		}),
	);
}
