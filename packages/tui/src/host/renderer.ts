import { createRenderEffect, createRoot } from "solid-js";
import { createRenderer } from "solid-js/universal";
import { instrument } from "../instrumentation";
import { markDamage, markSubtreeDamage } from "./damage";
import {
	adoptHostSlot,
	attachHostSubtree,
	createElementNode,
	createTextNode as createHostTextNode,
	detachHostSubtree,
	hostRootFor,
	hostSlotChildren,
} from "./node";
import { Damage, type HostElement, type HostNode } from "./types";
import "./elements/badge";
import "./elements/box";
import "./elements/br";
import "./elements/choice";
import "./elements/code";
import "./elements/cursor";
import "./elements/diff";
import "./elements/duration";
import "./elements/editor";
import "./elements/frame";
import "./elements/hr";
import "./elements/icon";
import "./elements/image";
import "./elements/input";
import "./elements/json";
import "./elements/link";
import "./elements/markdown";
import "./elements/meta";
import "./elements/path";
import "./elements/pre";
import "./elements/preview";
import "./elements/progress";
import "./elements/qr";
import "./elements/rail";
import "./elements/raw";
import "./elements/row";
import "./elements/scroll";
import "./elements/select";
import "./elements/shimmer";
import "./elements/sized";
import "./elements/span";
import "./elements/spinner";
import "./elements/split";
import "./elements/stack";
import "./elements/status";
import "./elements/table";
import "./elements/tabs";
import "./elements/terminal";
import "./elements/text";
import "./elements/timestamp";
import "./elements/transcript-block";
import "./elements/transcript";
import "./elements/tree";

function elementParent(node: HostNode, operation: string): HostElement {
	if (node.kind === "text") throw new Error(`${operation} requires an element parent`);
	return node;
}

function assertNoCycle(parent: HostElement, node: HostNode): void {
	let ancestor: HostNode | null = parent;
	while (ancestor !== null) {
		if (ancestor === node) throw new Error("Cannot insert a host node into its own subtree");
		ancestor = ancestor.parent;
	}
}

function recordRemovedSubtree(node: HostNode): void {
	if (node.kind === "element") {
		for (const child of node.children) recordRemovedSubtree(child);
		for (const child of hostSlotChildren(node)) recordRemovedSubtree(child);
	}
	instrument.nodeRemoved();
}

function removeHostNode(parentNode: HostNode, node: HostNode): void {
	const parent = elementParent(parentNode, "removeNode");
	const index = parent.children.indexOf(node);
	if (index === -1 || node.parent !== parent) throw new Error("Remove target is not a child of the target parent");
	const root = hostRootFor(parent);
	if (root !== undefined) detachHostSubtree(node, root);
	parent.children.splice(index, 1);
	parent.childrenVersion = (parent.childrenVersion ?? 0) + 1;
	node.parent = null;
	recordRemovedSubtree(node);
	markDamage(parent, Damage.Layout);
}

function resolveSlotValue(value: unknown): unknown {
	while (typeof value === "function") value = value();
	if (!Array.isArray(value)) return value;
	const original = value;
	const resolved = original.map(resolveSlotValue);
	return resolved.every((child, index) => child === original[index]) ? original : resolved;
}

function setHostProperty(node: HostElement, name: string, value: unknown): void {
	if (Object.is(node.props[name], value)) return;
	adoptHostSlot(node, name, value);
	if (value === undefined) delete node.props[name];
	else node.props[name] = value;
	instrument.binding();
	const damage = node.impl.propDamage(name);
	if ((damage & (Damage.Paint | Damage.Link)) !== 0) markSubtreeDamage(node, damage);
	markDamage(node, damage);
}

const renderer = createRenderer<HostNode>({
	createElement: createElementNode,
	createTextNode: createHostTextNode,
	replaceText(node, value) {
		if (node.kind !== "text") throw new Error("replaceText requires a text node");
		if (node.text === value) return;
		node.text = value;
		instrument.binding();
		markDamage(node, Damage.Text);
	},
	isTextNode(node) {
		return node.kind === "text";
	},
	setProperty(node, name, value) {
		if (node.kind !== "element") throw new Error(`Cannot set property ${name} on a text node`);
		if (node.impl.slots?.includes(name)) {
			createRenderEffect(() => setHostProperty(node, name, resolveSlotValue(value)));
		} else {
			setHostProperty(node, name, value);
		}
	},
	insertNode(parentNode, node, anchor) {
		const parent = elementParent(parentNode, "insertNode");
		const actualAnchor = anchor ?? undefined;
		assertNoCycle(parent, node);
		if (actualAnchor === node) return;
		if (actualAnchor !== undefined && actualAnchor.parent !== parent) {
			throw new Error("Insert anchor is not a child of the target parent");
		}

		const oldParent = node.parent;
		const oldRoot = oldParent === null ? undefined : hostRootFor(oldParent);
		const newRoot = hostRootFor(parent);
		if (oldParent === parent) {
			const oldIndex = parent.children.indexOf(node);
			if (oldIndex === -1) throw new Error("Host parent link is inconsistent with its children");
			let targetIndex = actualAnchor === undefined ? parent.children.length : parent.children.indexOf(actualAnchor);
			if (oldIndex < targetIndex) targetIndex--;
			if (oldIndex === targetIndex) return;
			parent.children.splice(oldIndex, 1);
			parent.children.splice(targetIndex, 0, node);
			parent.childrenVersion = (parent.childrenVersion ?? 0) + 1;
			instrument.nodeMoved();
			markDamage(parent, Damage.Layout);
			return;
		}

		if (oldParent !== null) {
			const oldIndex = oldParent.children.indexOf(node);
			if (oldIndex === -1) throw new Error("Host parent link is inconsistent with its children");
			if (oldRoot !== newRoot && oldRoot !== undefined) detachHostSubtree(node, oldRoot);
			oldParent.children.splice(oldIndex, 1);
			oldParent.childrenVersion = (oldParent.childrenVersion ?? 0) + 1;
			markDamage(oldParent, Damage.Layout);
			instrument.nodeMoved();
		}

		const targetIndex = actualAnchor === undefined ? parent.children.length : parent.children.indexOf(actualAnchor);
		parent.children.splice(targetIndex, 0, node);
		parent.childrenVersion = (parent.childrenVersion ?? 0) + 1;
		node.parent = parent;
		if (oldRoot !== newRoot && newRoot !== undefined) attachHostSubtree(node, newRoot);
		markDamage(parent, Damage.Layout);
	},
	removeNode: removeHostNode,
	getParentNode(node) {
		return node.parent ?? undefined;
	},
	getFirstChild(node) {
		return node.kind === "element" ? node.children[0] : undefined;
	},
	getNextSibling(node) {
		const parent = node.parent;
		if (parent === null) return undefined;
		const index = parent.children.indexOf(node);
		return index === -1 ? undefined : parent.children[index + 1];
	},
});

/** Remove a retained child and run its recursive detach lifecycle. */
export const removeNode = removeHostNode;

/** Create a Solid owner for host-runtime mounting and return its disposer through `mount`. */
export function createHostOwner(mount: (dispose: () => void) => void): void {
	createRoot(mount);
}

/** Solid universal-renderer operations bound to retained terminal host nodes. */
export const {
	render,
	effect,
	memo,
	createComponent,
	createElement,
	createTextNode,
	insertNode,
	insert,
	spread,
	setProp,
	mergeProps,
	use,
} = renderer;
