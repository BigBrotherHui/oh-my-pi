import { createSignal, getOwner, onCleanup, type Accessor, type Setter } from "solid-js";
import { markDamage } from "./damage";
import { registerHostNodeLifecycle } from "./node";
import { Damage, FROZEN_AT, type HostElement, type HostNode } from "./types";

/** Focus controls owned by one reactive view. */
export interface FocusHandle {
	readonly focused: Accessor<boolean>;
	focus(): void;
	blur(): void;
	readonly tabIndex: number;
}

interface HookBinding {
	readonly token: number;
	readonly setFocused: Setter<boolean>;
	node: HostElement | undefined;
	pendingFocus: boolean;
}

interface FocusRootState {
	focused: HostElement | null;
	active: boolean;
}

const focusRootState = Symbol("host.focusRootState");
const nodeFocusListeners = Symbol("host.focusListeners");

interface FocusRootElement extends HostElement {
	[focusRootState]?: FocusRootState;
}

interface FocusListenerElement extends HostElement {
	[nodeFocusListeners]?: Set<(focused: boolean) => void>;
}

const hookBindings = new Map<number, HookBinding>();
let nextFocusToken = 1;
let lifecycleUsers = 0;
let stopLifecycle: (() => void) | undefined;

function treeRoot(node: HostElement): HostElement {
	let root = node;
	while (root.parent) root = root.parent;
	return root;
}

function stateFor(root: HostElement): FocusRootState {
	const ownedRoot = root as FocusRootElement;
	let state = ownedRoot[focusRootState];
	if (!state) {
		state = { focused: null, active: true };
		ownedRoot[focusRootState] = state;
	}
	return state;
}

function tabIndexOf(node: HostElement): number | undefined {
	if (node[FROZEN_AT] !== undefined) return undefined;
	const value = node.props.tabIndex ?? (node.tag === "editor" || node.tag === "input" ? 0 : undefined);
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function bindingFor(node: HostElement): HookBinding | undefined {
	const tabIndex = node.props.tabIndex;
	return typeof tabIndex === "number" ? hookBindings.get(tabIndex) : undefined;
}

function notifyFocused(node: HostElement, focused: boolean): void {
	bindingFor(node)?.setFocused(focused);
	const listeners = (node as FocusListenerElement)[nodeFocusListeners];
	if (listeners) for (const listener of listeners) listener(focused);
}

function setFocusedNode(root: HostElement, node: HostElement | null): void {
	const state = stateFor(root);
	if (state.focused === node) return;
	const previous = state.focused;
	state.focused = node;
	if (previous) {
		notifyFocused(previous, false);
		markDamage(previous, Damage.Interaction | Damage.Paint);
	}
	if (node) {
		notifyFocused(node, state.active);
		markDamage(node, Damage.Interaction | Damage.Paint);
	}
}

function contains(ancestor: HostElement, node: HostElement): boolean {
	let current: HostElement | null = node;
	while (current) {
		if (current === ancestor) return true;
		current = current.parent;
	}
	return false;
}

function firstFocusable(node: HostNode, excluded: HostElement): HostElement | null {
	if (node.kind === "text" || contains(excluded, node)) return null;
	if (tabIndexOf(node) !== undefined) return node;
	for (const child of node.children) {
		const candidate = firstFocusable(child, excluded);
		if (candidate) return candidate;
	}
	return null;
}

function fallbackFor(detached: HostElement, focused: HostElement): HostElement | null {
	let branch: HostElement = detached;
	let parent = detached.parent;
	while (parent) {
		if (tabIndexOf(parent) !== undefined) return parent;
		const index = parent.children.indexOf(branch);
		for (let distance = 1; distance < parent.children.length; distance++) {
			const before = index - distance;
			if (before >= 0) {
				const candidate = firstFocusable(parent.children[before]!, detached);
				if (candidate) return candidate;
			}
			const after = index + distance;
			if (after < parent.children.length) {
				const candidate = firstFocusable(parent.children[after]!, detached);
				if (candidate) return candidate;
			}
		}
		branch = parent;
		parent = parent.parent;
	}
	return contains(detached, focused) ? null : focused;
}

/** Register a listener for an element's focus transitions. */
export function subscribeFocus(node: HostElement, listener: (focused: boolean) => void): () => void {
	const ownedNode = node as FocusListenerElement;
	let listeners = ownedNode[nodeFocusListeners];
	if (!listeners) {
		listeners = new Set();
		ownedNode[nodeFocusListeners] = listeners;
	}
	listeners.add(listener);
	const root = treeRoot(node);
	listener(stateFor(root).active && focusedElement(root) === node);
	return () => {
		listeners?.delete(listener);
		if (listeners?.size === 0) delete ownedNode[nodeFocusListeners];
	};
}

/** Suspend a root's visible focus while another overlay owns terminal input, retaining its return target. */
export function setFocusRootActive(root: HostElement, active: boolean): void {
	const state = stateFor(root);
	if (state.active === active) return;
	state.active = active;
	if (state.focused) {
		notifyFocused(state.focused, active);
		markDamage(state.focused, Damage.Interaction | Damage.Paint);
	}
}

/** Focus `node` only when its root has no focused element yet (initial focus for primary inputs). */
export function focusElementIfUnfocused(node: HostElement): boolean {
	if (focusedElement(treeRoot(node)) !== null) return false;
	return focusElement(node);
}

/** Focus a retained element when it is focusable. */
export function focusElement(node: HostElement): boolean {
	if (tabIndexOf(node) === undefined) return false;
	setFocusedNode(treeRoot(node), node);
	return true;
}

/** Blur a retained element if it currently owns focus. */
export function blurElement(node: HostElement): void {
	const root = treeRoot(node);
	if (stateFor(root).focused === node) setFocusedNode(root, null);
}

/** Return the focused element for a host root. */
export function focusedElement(root: HostElement): HostElement | null {
	return (root as FocusRootElement)[focusRootState]?.focused ?? null;
}

function collectFocusable(node: HostNode, output: HostElement[]): void {
	if (node.kind === "text") return;
	if (tabIndexOf(node) !== undefined) output.push(node);
	for (const child of node.children) collectFocusable(child, output);
}

function firstLeafFocusable(node: HostNode): HostElement | null {
	if (node.kind === "text") return null;
	for (const child of node.children) {
		const leaf = firstLeafFocusable(child);
		if (leaf) return leaf;
	}
	return tabIndexOf(node) !== undefined ? node : null;
}

/**
 * Establish initial focus for a root that has focusable content but no focus:
 * the innermost focusable in document order, so key events start at the leaf
 * (an input inside a focusable panel) and bubble outward.
 */
export function focusInitial(root: HostElement): boolean {
	if (focusedElement(root) !== null) return false;
	const leaf = firstLeafFocusable(root);
	if (!leaf) return false;
	setFocusedNode(root, leaf);
	return true;
}

/** Move focus through the root's current focus order. */
export function focusNext(root: HostElement, direction: 1 | -1 = 1): boolean {
	const nodes: HostElement[] = [];
	collectFocusable(root, nodes);
	if (nodes.length === 0) return false;
	const order = new Map<HostElement, number>();
	for (let index = 0; index < nodes.length; index++) order.set(nodes[index]!, index);
	nodes.sort((left, right) => {
		const tabDelta = (tabIndexOf(left) ?? 0) - (tabIndexOf(right) ?? 0);
		return tabDelta !== 0 ? tabDelta : (order.get(left) ?? 0) - (order.get(right) ?? 0);
	});
	const current = focusedElement(root);
	const index = current ? nodes.indexOf(current) : -1;
	const next = index < 0 ? (direction > 0 ? 0 : nodes.length - 1) : (index + direction + nodes.length) % nodes.length;
	setFocusedNode(root, nodes[next]!);
	return true;
}

/** Bind a newly attached host node to any matching `useFocus` handle. */
export function handleHostNodeAttached(node: HostElement): void {
	const binding = bindingFor(node);
	if (!binding) return;
	binding.node = node;
	if (binding.pendingFocus) {
		binding.pendingFocus = false;
		focusElement(node);
	}
}

/** Apply focus fallback before an element subtree is detached. */
export function handleHostNodeDetached(node: HostElement): void {
	const root = treeRoot(node);
	const focused = focusedElement(root);
	if (focused && contains(node, focused)) setFocusedNode(root, fallbackFor(node, focused));
	const binding = bindingFor(node);
	if (binding?.node === node) {
		binding.node = undefined;
		binding.setFocused(false);
	}
	delete (node as FocusListenerElement)[nodeFocusListeners];
}

/** Install host lifecycle observation used by `useFocus`; releases by reference count. */
export function installFocusRuntime(): () => void {
	lifecycleUsers++;
	if (!stopLifecycle) {
		stopLifecycle = registerHostNodeLifecycle({
			attached(node) {
				handleHostNodeAttached(node);
			},
			detached(node) {
				handleHostNodeDetached(node);
			},
		});
	}
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		lifecycleUsers--;
		if (lifecycleUsers === 0) {
			stopLifecycle?.();
			stopLifecycle = undefined;
		}
	};
}

/** Release focus state after a host root has detached its children. */
export function disposeFocusRoot(root: HostElement): void {
	const ownedRoot = root as FocusRootElement;
	const focused = ownedRoot[focusRootState]?.focused;
	if (focused) notifyFocused(focused, false);
	delete ownedRoot[focusRootState];
}

/** Create focus controls whose token is assigned to an element's `tabIndex`. */
export function useFocus(): FocusHandle {
	if (getOwner() === null) throw new Error("useFocus requires a reactive owner");
	const [focused, setFocused] = createSignal(false);
	const binding: HookBinding = {
		token: nextFocusToken++,
		setFocused,
		node: undefined,
		pendingFocus: false,
	};
	hookBindings.set(binding.token, binding);
	onCleanup(() => {
		hookBindings.delete(binding.token);
		binding.node = undefined;
		binding.pendingFocus = false;
	});
	return {
		focused,
		focus() {
			if (binding.node) focusElement(binding.node);
			else binding.pendingFocus = true;
		},
		blur() {
			binding.pendingFocus = false;
			if (binding.node) blurElement(binding.node);
		},
		tabIndex: binding.token,
	};
}
