import { createRenderer } from "solid-js/universal";
import { registerElement } from "../../src/host/registry";
import { Damage, type ElementImpl } from "../../src/host/types";

declare module "solid-js" {
	namespace JSX {
		interface IntrinsicElements {
			"compiler-fixture": { children?: unknown; role?: string; source?: string };
		}
	}
}

const compilerFixtureElement: ElementImpl = {
	tag: "compiler-fixture",
	propDamage() {
		return Damage.Text;
	},
	paint() {},
};

registerElement(compilerFixtureElement);

/** Minimal retained node used to observe universal-renderer identity and mutations in compiler tests. */
export interface MemoryNode {
	readonly type: string;
	readonly props: Record<string, unknown>;
	readonly children: MemoryNode[];
	parent: MemoryNode | null;
	text: string | undefined;
}

/** Mutation recorded by the in-memory renderer test double. */
export type MemoryMutation =
	| { readonly operation: "insertNode"; readonly parent: MemoryNode; readonly node: MemoryNode }
	| { readonly operation: "removeNode"; readonly parent: MemoryNode; readonly node: MemoryNode }
	| { readonly operation: "replaceText"; readonly node: MemoryNode; readonly value: string }
	| { readonly operation: "setProperty"; readonly node: MemoryNode; readonly name: string; readonly value: unknown };

const mutations: MemoryMutation[] = [];

/** Create a detached root for a compiler runtime fixture. */
export function createMemoryRoot(): MemoryNode {
	return { type: "root", props: {}, children: [], parent: null, text: undefined };
}

/** Read the mutations recorded since the module loaded. */
export function getMemoryMutations(): readonly MemoryMutation[] {
	return mutations;
}

/** Clear recorded renderer mutations without replacing node identities. */
export function clearMemoryMutations(): void {
	mutations.length = 0;
}

const renderer = createRenderer<MemoryNode>({
	createElement(type) {
		return { type, props: {}, children: [], parent: null, text: undefined };
	},
	createTextNode(value) {
		return { type: "#text", props: {}, children: [], parent: null, text: String(value) };
	},
	replaceText(node, value) {
		const text = String(value);
		node.text = text;
		mutations.push({ operation: "replaceText", node, value: text });
	},
	isTextNode(node) {
		return node.type === "#text";
	},
	setProperty(node, name, value) {
		if (value === undefined) delete node.props[name];
		else node.props[name] = value;
		mutations.push({ operation: "setProperty", node, name, value });
	},
	insertNode(parent, node, anchor) {
		if (node === anchor) return;
		if (node.parent) {
			const oldIndex = node.parent.children.indexOf(node);
			if (oldIndex >= 0) node.parent.children.splice(oldIndex, 1);
		}
		const anchorIndex = anchor === undefined ? -1 : parent.children.indexOf(anchor);
		if (anchor !== undefined && anchorIndex < 0) throw new Error("insert anchor is not a child of parent");
		parent.children.splice(anchorIndex < 0 ? parent.children.length : anchorIndex, 0, node);
		node.parent = parent;
		mutations.push({ operation: "insertNode", parent, node });
	},
	removeNode(parent, node) {
		const index = parent.children.indexOf(node);
		if (index < 0) throw new Error("remove target is not a child of parent");
		parent.children.splice(index, 1);
		node.parent = null;
		mutations.push({ operation: "removeNode", parent, node });
	},
	getParentNode(node) {
		return node.parent ?? undefined;
	},
	getFirstChild(node) {
		return node.children[0];
	},
	getNextSibling(node) {
		if (!node.parent) return undefined;
		const index = node.parent.children.indexOf(node);
		return index < 0 ? undefined : node.parent.children[index + 1];
	},
});

/** Solid universal-renderer bindings backed by the in-memory compiler test tree. */
export const {
	createComponent,
	createElement,
	createTextNode,
	effect,
	insert,
	insertNode,
	memo,
	mergeProps,
	render: renderMemory,
	setProp,
	spread,
	use,
} = renderer;
