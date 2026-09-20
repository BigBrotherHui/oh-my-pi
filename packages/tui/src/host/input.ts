import { parseKey, type KeyId } from "../keys";
import { INPUT_TARGET, type HostElement, type InputTarget } from "./types";
import { focusInitial, focusNext, focusedElement } from "./focus";
import { registerHostNodeLifecycle, type HostRoot } from "./node";

/** Props shared by host elements that participate in input or focus. */
export interface CommonInputProps {
	readonly onKey?: (event: HostKeyEvent) => void;
	readonly onMouse?: (event: HostMouseEvent) => void;
	/** Clear hover state when the pointer exits this element's painted subtree. */
	readonly onMouseLeave?: (event: HostMouseEvent) => void;
	/** Receive literal clipboard text before native input handling. */
	readonly onPaste?: (text: string) => void;
	/** Preserve a controller's asynchronous clipboard reservation and submission ordering. */
	readonly inputTarget?: InputTarget;
	readonly tabIndex?: number;
}

/** A key event dispatched through the retained host tree. */
export class HostKeyEvent {
	readonly data: string;
	readonly key: KeyId | undefined;
	defaultPrevented = false;
	propagationStopped = false;

	constructor(data: string) {
		this.data = data;
		this.key = parseKey(data) as KeyId | undefined;
	}

	/** Prevent the host runtime's default behavior for this key. */
	preventDefault(): void {
		this.defaultPrevented = true;
	}

	/** Stop this event before it reaches another ancestor. */
	stopPropagation(): void {
		this.propagationStopped = true;
	}
}

/** Mouse actions understood by the host input dispatcher. */
export type HostMouseAction = "down" | "up" | "move" | "wheel";

/** A mouse event dispatched through painted host spans. */
export class HostMouseEvent {
	readonly row: number;
	readonly col: number;
	readonly action: HostMouseAction;
	readonly button: number;
	/** Original SGR button code, including modifier and motion bits. */
	readonly rawButton: number;
	/** Original terminal report, retained for interactive PTY forwarding. */
	readonly data: string;
	readonly wheel: -1 | 0 | 1;

	get shiftKey(): boolean {
		return (this.rawButton & 4) !== 0;
	}
	get altKey(): boolean {
		return (this.rawButton & 8) !== 0;
	}
	get ctrlKey(): boolean {
		return (this.rawButton & 16) !== 0;
	}
	defaultPrevented = false;
	propagationStopped = false;
	#originRow = 0;
	#originCol = 0;

	/** Row within the element whose mouse handler is currently running. */
	get localRow(): number {
		return this.row - this.#originRow;
	}

	/** Column within the element whose mouse handler is currently running. */
	get localCol(): number {
		return this.col - this.#originCol;
	}

	/** Update the current bubbling target's origin before invoking its handler. */
	setCurrentOrigin(row: number, col: number): void {
		this.#originRow = row;
		this.#originCol = col;
	}

	constructor(options: {
		readonly row: number;
		readonly col: number;
		readonly action?: HostMouseAction;
		readonly button?: number;
		readonly rawButton?: number;
		readonly data?: string;
		readonly wheel?: -1 | 0 | 1;
	}) {
		this.row = options.row;
		this.col = options.col;
		this.action = options.action ?? "down";
		this.button = options.button ?? 0;
		this.rawButton = options.rawButton ?? this.button;
		this.data = options.data ?? "";
		this.wheel = options.wheel ?? 0;
	}

	/** Prevent the host runtime's default behavior for this mouse event. */
	preventDefault(): void {
		this.defaultPrevented = true;
	}

	/** Stop this event before it reaches another ancestor. */
	stopPropagation(): void {
		this.propagationStopped = true;
	}
}

/** Root value accepted by host input dispatch. */
export type HostInputRoot = HostRoot | HostElement;

interface PaintedSpan {
	readonly node: HostElement;
	rowStart: number;
	rowCount: number;
	colStart: number;
	colCount: number;
	originRow: number;
	originCol: number;
}

interface KeyHandlingElementImpl {
	handleKey?(node: HostElement, event: HostKeyEvent): void;
}

const spansById = new Map<number, PaintedSpan>();
const hoveredTarget = Symbol("host.hoveredTarget");

declare module "./types" {
	interface HostElement {
		[hoveredTarget]?: HostElement | null;
	}
}
let inputRuntimeUsers = 0;
let stopInputLifecycle: (() => void) | undefined;

function inputProps(node: HostElement): CommonInputProps {
	return node.props as CommonInputProps;
}

function rootElement(root: HostInputRoot): HostElement {
	return "node" in root ? root.node : root;
}

function rootOf(node: HostElement): HostElement {
	let current = node;
	while (current.parent) current = current.parent;
	return current;
}

/** Record the last painted row span for an element. */
export function recordPaintSpan(
	node: HostElement,
	rowStart: number,
	rowCount: number,
	colStart = 0,
	colCount = Number.POSITIVE_INFINITY,
	originRow = rowStart,
	originCol = colStart,
): void {
	if (rowCount <= 0 || colCount <= 0) {
		forgetPaintSpan(node);
		return;
	}
	spansById.delete(node.id);
	spansById.set(node.id, {
		node,
		rowStart: Math.max(0, Math.trunc(rowStart)),
		rowCount: Math.max(0, Math.trunc(rowCount)),
		colStart: Math.max(0, Math.trunc(colStart)),
		colCount: Math.max(0, colCount),
		originRow,
		originCol,
	});
}

/** Remove an element's stale painted span when it leaves the host tree. */
export function forgetPaintSpan(node: HostElement): void {
	spansById.delete(node.id);
	const root = rootOf(node);
	const previous = root[hoveredTarget];
	if (previous === node || (previous && isAncestor(node, previous))) root[hoveredTarget] = null;
}

/** Install painted-span cleanup for attached host roots; releases by reference count. */
export function installInputRuntime(): () => void {
	inputRuntimeUsers++;
	if (!stopInputLifecycle) {
		stopInputLifecycle = registerHostNodeLifecycle({
			detached(node) {
				forgetPaintSpan(node);
			},
		});
	}
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		inputRuntimeUsers--;
		if (inputRuntimeUsers === 0) {
			stopInputLifecycle?.();
			stopInputLifecycle = undefined;
		}
	};
}

/** Dispatch a key to the focused element and then its ancestors. */
export function dispatchKey(root: HostInputRoot, event: HostKeyEvent): boolean {
	const element = rootElement(root);
	// A root that has focusable content but no focus yet (a freshly shown
	// overlay) adopts its first focusable element, so the first key is not lost.
	const focused = focusedElement(element) ?? (focusInitial(element) ? focusedElement(element) : null);
	if (!focused) return false;

	let current: HostElement | null = focused;
	let handled = false;
	while (current) {
		const handler = inputProps(current).onKey;
		if (handler) {
			handled = true;
			handler(event);
		}
		const implementation = current.impl as KeyHandlingElementImpl;
		if (!event.defaultPrevented && implementation.handleKey) {
			handled = true;
			implementation.handleKey(current, event);
		}
		if (event.propagationStopped || current === element) break;
		current = current.parent;
	}

	if (!event.defaultPrevented && !event.propagationStopped) {
		if (event.key === "tab") handled = focusNext(element, 1) || handled;
		else if (event.key === "shift+tab") handled = focusNext(element, -1) || handled;
	}
	return handled;
}

/** Capture the focused input's stable identity without retaining a detached destination. */
export function focusedInputTarget(root: HostInputRoot): InputTarget | null {
	const element = rootElement(root);
	const node = focusedElement(element);
	if (!node) return null;
	const explicit = inputProps(node).inputTarget ?? node.impl.inputTarget?.(node);
	if (explicit) return explicit;
	return (node[INPUT_TARGET] ??= {
		pasteText(text) {
			if (focusedElement(element) === node) dispatchPaste(root, text);
		},
	});
}

/** Deliver literal clipboard text to the focused retained input or editor. */
export function dispatchPaste(root: HostInputRoot, text: string): boolean {
	const element = rootElement(root);
	focusInitial(element);
	let node = focusedElement(element);
	while (node) {
		const handler = inputProps(node).onPaste;
		if (handler) {
			handler(text);
			return true;
		}
		if (node.impl.pasteText) {
			node.impl.pasteText(node, text);
			return true;
		}
		node = node.parent;
	}
	return false;
}

function spanContains(span: PaintedSpan, row: number, col: number): boolean {
	return (
		row >= span.rowStart &&
		row < span.rowStart + span.rowCount &&
		col >= span.colStart &&
		col < span.colStart + span.colCount
	);
}

function isAncestor(ancestor: HostElement, node: HostElement): boolean {
	let current = node.parent;
	while (current) {
		if (current === ancestor) return true;
		current = current.parent;
	}
	return false;
}

function deepestPaintedTarget(root: HostElement, row: number, col: number): HostElement | null {
	let target: HostElement | null = null;
	for (const span of spansById.values()) {
		if (rootOf(span.node) !== root || !spanContains(span, row, col)) continue;
		let candidate = span.node;
		const local = candidate.impl.hitTest?.(candidate, row - span.originRow, col - span.originCol);
		if (local) candidate = local;
		if (!target) {
			target = candidate;
			continue;
		}
		if (isAncestor(target, candidate)) target = candidate;
		else if (!isAncestor(candidate, target)) target = candidate;
	}
	return target;
}

function dispatchMouseLeave(root: HostElement, target: HostElement | null, source: HostMouseEvent): boolean {
	let previous = root[hoveredTarget] ?? null;
	root[hoveredTarget] = target;
	let event: HostMouseEvent | undefined;
	while (previous && previous !== target && !(target && isAncestor(previous, target))) {
		const handler = inputProps(previous).onMouseLeave;
		if (handler) {
			event ??= new HostMouseEvent({
				row: source.row,
				col: source.col,
				action: source.action,
				button: source.button,
				rawButton: source.rawButton,
				data: source.data,
				wheel: source.wheel,
			});
			const span = spansById.get(previous.id);
			event.setCurrentOrigin(span?.originRow ?? 0, span?.originCol ?? 0);
			handler(event);
			if (event.propagationStopped) break;
		}
		previous = previous.parent;
	}
	return event !== undefined;
}

/** Dispatch a mouse event from the deepest painted hit to its ancestors. */
export function dispatchMouse(root: HostInputRoot, event: HostMouseEvent): boolean {
	const element = rootElement(root);
	let current = deepestPaintedTarget(element, event.row, event.col);
	let handled = event.action === "move" && dispatchMouseLeave(element, current, event);
	if (!current) return handled;
	while (current) {
		const handler = inputProps(current).onMouse;
		if (handler) {
			const span = spansById.get(current.id);
			event.setCurrentOrigin(span?.originRow ?? 0, span?.originCol ?? 0);
			handled = true;
			handler(event);
		}
		if (event.propagationStopped || current === element) break;
		current = current.parent;
	}
	return handled;
}
