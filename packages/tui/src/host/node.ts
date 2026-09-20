import { getOwner } from "solid-js";
import { RichText } from "../core/richtext";
import { instrument } from "../instrumentation";
import type { Theme } from "../theme/theme";
import { getWidthConfigEpoch } from "../utils";
import { markDamage } from "./damage";
import { elementFor } from "./registry";
import {
	Damage,
	FROZEN_AT,
	HOST_OWNER,
	PAINT_PLACEMENTS,
	type ClockCadence,
	type ElementImpl,
	type HostContext,
	type HostElement,
	type HostNode,
	type HostText,
} from "./types";

/** Callback invoked when a retained node dirties its rooted subtree. */
export type HostDamageHandler = (node: HostNode, damage: Damage) => void;

/** Options used to construct the synthetic retained-tree root. */
export interface CreateHostRootOptions {
	readonly theme: Theme;
	readonly widthEpoch?: number;
	readonly onDamage?: HostDamageHandler;
	readonly subscribeClock?: (cadence: ClockCadence, listener: (now: number) => void) => () => void;
}

/** Root-owned state shared by retained nodes, paint, focus, and scheduling. */
export interface HostRoot {
	readonly node: HostElement;
	readonly frameDependencies: Set<HostElement>;
	/** Allocate history IDs across transcript controller replacement within this root. */
	nextHistoryBatchId(): number;
	widthEpoch: number;
	theme: Theme;
	onDamage: HostDamageHandler;
}

/** Lifecycle listener used by focus and input runtimes without coupling the renderer to them. */
export interface HostNodeLifecycle {
	attached?(node: HostElement, root: HostRoot): void;
	detached?(node: HostElement, root: HostRoot): void;
}

const HOST_ROOT = Symbol("host.root");
const HOST_CONTEXT = Symbol("host.context");

interface RootElementState extends HostElement {
	[HOST_ROOT]?: HostRoot;
}

interface HostRootState extends HostRoot {
	[HOST_CONTEXT]?: HostContext;
}

let nextNodeId = 1;
const lifecycleListeners = new Set<HostNodeLifecycle>();

const rootElement: ElementImpl = {
	tag: "#root",
	propDamage: () => Damage.Layout,
	paint(node, out, width, ctx) {
		for (const child of node.children) ctx.paintChild(child, out, width);
	},
};

function baseNode(kind: "element" | "text") {
	instrument.nodeCreated();
	return {
		id: nextNodeId++,
		kind,
		parent: null,
		damage: Damage.Layout,
		cache: new RichText(),
		cacheWidth: -1,
		cacheEpoch: -1,
	};
}

/** Create an element node and resolve its registered implementation immediately. */
export function createElementNode(tag: string): HostElement {
	return {
		...baseNode("element"),
		[HOST_OWNER]: getOwner(),
		kind: "element",
		tag,
		props: {},
		children: [],
		childrenVersion: 0,
		slots: new Map(),
		impl: elementFor(tag),
		state: undefined,
	};
}

/** Create a retained text node with a stable identity. */
export function createTextNode(text: string): HostText {
	return {
		...baseNode("text"),
		kind: "text",
		text,
	};
}

/** Create the synthetic container element used as a renderer mount target. */
export function createHostRoot(options: CreateHostRootOptions): HostRoot {
	const node: HostElement = {
		...baseNode("element"),
		kind: "element",
		tag: "#root",
		props: {},
		children: [],
		childrenVersion: 0,
		slots: new Map(),
		impl: rootElement,
		state: undefined,
	};
	let historyBatchId = 0;
	const root: HostRootState = {
		node,
		nextHistoryBatchId: () => ++historyBatchId,
		frameDependencies: new Set(),
		widthEpoch: options.widthEpoch ?? getWidthConfigEpoch(),
		theme: options.theme,
		onDamage: options.onDamage ?? (() => {}),
	};
	(node as RootElementState)[HOST_ROOT] = root;
	const subscribeClock = options.subscribeClock ?? (() => () => {});
	root[HOST_CONTEXT] = {
		get theme() {
			return root.theme;
		},
		invalidate: markDamage,
		subscribeClock,
		trackFrameDependency(node) {
			if (node[FROZEN_AT] === undefined) root.frameDependencies.add(node);
			return () => {
				root.frameDependencies.delete(node);
			};
		},
	};
	return root;
}

/** Resolve the owning root for an attached node, or `undefined` while detached. */
export function hostRootFor(node: HostNode): HostRoot | undefined {
	let current: HostNode = node;
	while (current.parent !== null) current = current.parent;
	return current.kind === "element" ? (current as RootElementState)[HOST_ROOT] : undefined;
}

/** Resolve the stable host services supplied to element attach hooks. */
export function hostContextFor(root: HostRoot): HostContext {
	const context = (root as HostRootState)[HOST_CONTEXT];
	if (context === undefined) throw new Error("Host root has been disposed");
	return context;
}

/** Subscribe to element attach/detach notifications; returns an unsubscribe function. */
export function registerHostNodeLifecycle(listener: HostNodeLifecycle): () => void {
	lifecycleListeners.add(listener);
	return () => {
		lifecycleListeners.delete(listener);
	};
}

/** Return true when an unknown value is a retained host node. */
export function isHostNode(value: unknown): value is HostNode {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as { kind?: unknown; id?: unknown };
	return (candidate.kind === "element" || candidate.kind === "text") && typeof candidate.id === "number";
}

function collectSlotNodes(value: unknown, into: HostNode[], seen: Set<HostNode>): void {
	if (isHostNode(value)) {
		if (!seen.has(value)) {
			seen.add(value);
			into.push(value);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const child of value) collectSlotNodes(child, into, seen);
	}
}

/** Extract retained host nodes from a JSX-valued element prop. */
export function hostNodesForSlot(value: unknown): readonly HostNode[] {
	const nodes: HostNode[] = [];
	collectSlotNodes(value, nodes, new Set());
	return nodes;
}

/** Return the detached JSX prop nodes retained by an element. */
export function hostSlotChildren(owner: HostElement): readonly HostNode[] {
	const children: HostNode[] = [];
	const seen = new Set<HostNode>();
	for (const nodes of owner.slots.values()) {
		for (const node of nodes) {
			if (seen.has(node)) continue;
			seen.add(node);
			children.push(node);
		}
	}
	return children;
}

function referencedByAnotherSlot(owner: HostElement, name: string, node: HostNode): boolean {
	for (const [slotName, nodes] of owner.slots) {
		if (slotName !== name && nodes.includes(node)) return true;
	}
	return false;
}

/** Adopt or replace the detached JSX prop nodes stored under `name`. */
export function adoptHostSlot(owner: HostElement, name: string, value: unknown): void {
	const previous = owner.slots.get(name) ?? [];
	const next = [...hostNodesForSlot(value)];
	for (const node of next) {
		if (node.parent !== null && node.parent !== owner) {
			throw new Error(`Cannot adopt host slot ${name}; its node belongs to another element`);
		}
		if (owner.children.includes(node)) {
			throw new Error(`Cannot adopt ordinary child as host slot ${name}`);
		}
	}
	if (next.length === 0) owner.slots.delete(name);
	else owner.slots.set(name, next);

	const root = hostRootFor(owner);
	for (const node of previous) {
		if (next.includes(node) || referencedByAnotherSlot(owner, name, node)) continue;
		if (root !== undefined) detachHostSubtree(node, root);
		node.parent = null;
		countRemoved(node);
	}
	for (const node of next) {
		if (previous.includes(node) || node.parent === owner) continue;
		node.parent = owner;
		if (root !== undefined) attachHostSubtree(node, root);
	}
}

/** Release every detached JSX prop node stored under `name`. */
export function releaseHostSlot(owner: HostElement, name: string): void {
	adoptHostSlot(owner, name, undefined);
}

/** Attach an element subtree to root-owned services after insertion. */
export function attachHostSubtree(node: HostNode, root: HostRoot): void {
	if (node.kind === "text") return;
	if (node.parent?.[FROZEN_AT] !== undefined) node[FROZEN_AT] = node.parent[FROZEN_AT];
	node.impl.onAttach?.(node, hostContextFor(root));
	for (const listener of lifecycleListeners) listener.attached?.(node, root);
	for (const child of node.children) attachHostSubtree(child, root);
	for (const child of hostSlotChildren(node)) attachHostSubtree(child, root);
}

/** Detach an element subtree from root-owned services before removal. */
export function detachHostSubtree(node: HostNode, root: HostRoot): void {
	if (node.kind === "text") return;
	const slots = hostSlotChildren(node);
	for (let index = slots.length - 1; index >= 0; index--) {
		detachHostSubtree(slots[index]!, root);
	}
	for (let index = node.children.length - 1; index >= 0; index--) {
		detachHostSubtree(node.children[index]!, root);
	}
	for (const listener of lifecycleListeners) listener.detached?.(node, root);
	node.impl.onDetach?.(node);
}

function countRemoved(node: HostNode): void {
	if (node.kind === "element") {
		for (const child of node.children) countRemoved(child);
		for (const child of hostSlotChildren(node)) countRemoved(child);
	}
	instrument.nodeRemoved();
}

/** Detach and release every descendant retained by a host root. */
export function disposeHostRoot(root: HostRoot): void {
	const state = root as HostRootState;
	if (state[HOST_CONTEXT] === undefined) return;
	detachHostSubtree(root.node, root);
	for (let index = root.node.children.length - 1; index >= 0; index--) {
		const child = root.node.children[index]!;
		countRemoved(child);
		child.parent = null;
	}
	root.node.children.length = 0;
	root.node.slots.clear();
	root.node[PAINT_PLACEMENTS]?.clear();
	root.frameDependencies.clear();
	root.node.cache.clear();
	root.node.damage = Damage.None;
	instrument.nodeRemoved();
	delete state[HOST_CONTEXT];
	delete (root.node as RootElementState)[HOST_ROOT];
}
