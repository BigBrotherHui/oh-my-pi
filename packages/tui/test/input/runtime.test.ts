import { describe, expect, it } from "bun:test";
import { createRoot } from "solid-js";
import { Style } from "../../src/core/style";
import {
	disposeFocusRoot,
	focusElement,
	focusedElement,
	installFocusRuntime,
	type FocusHandle,
	useFocus,
} from "../../src/host/focus";
import {
	dispatchKey,
	dispatchMouse,
	HostKeyEvent,
	HostMouseEvent,
	installInputRuntime,
	recordPaintSpan,
} from "../../src/host/input";
import {
	attachHostSubtree,
	createElementNode,
	createHostRoot,
	detachHostSubtree,
	disposeHostRoot,
	type HostRoot,
} from "../../src/host/node";
import { registerElement } from "../../src/host/registry";
import { Damage, type ElementImpl, type HostElement } from "../../src/host/types";
import { loadThemeSync } from "../../src/theme/loader";

const focusTestElement: ElementImpl = {
	tag: "focus-test",
	propDamage: () => Damage.Layout,
	paint(_node, out) {
		out.push(Style.NONE, "focus");
		out.br();
	},
};
registerElement(focusTestElement);

function append(root: HostRoot, node: HostElement): void {
	root.node.children.push(node);
	node.parent = root.node;
	attachHostSubtree(node, root);
}

function remove(root: HostRoot, node: HostElement): void {
	detachHostSubtree(node, root);
	const index = root.node.children.indexOf(node);
	if (index >= 0) root.node.children.splice(index, 1);
	node.parent = null;
}

function createFocusHandle(): { readonly handle: FocusHandle; readonly dispose: () => void } {
	let handle: FocusHandle | undefined;
	const dispose = createRoot(ownerDispose => {
		handle = useFocus();
		return ownerDispose;
	});
	if (!handle) throw new Error("Focus owner did not create its handle");
	return { handle, dispose };
}

function rootForTest(): HostRoot {
	return createHostRoot({ theme: loadThemeSync("dark") });
}

describe("host focus", () => {
	it("falls back to the nearest focusable ancestor when the focused node is disposed", () => {
		const stopFocus = installFocusRuntime();
		const root = rootForTest();
		const parent = createElementNode("focus-test");
		const child = createElementNode("focus-test");
		const owned = createFocusHandle();
		parent.props.tabIndex = 0;
		child.props.tabIndex = owned.handle.tabIndex;
		parent.children.push(child);
		child.parent = parent;
		append(root, parent);

		owned.handle.focus();
		expect(owned.handle.focused()).toBe(true);
		expect(focusedElement(root.node)).toBe(child);

		detachHostSubtree(child, root);
		parent.children.length = 0;
		child.parent = null;
		expect(owned.handle.focused()).toBe(false);
		expect(focusedElement(root.node)).toBe(parent);

		disposeHostRoot(root);
		disposeFocusRoot(root.node);
		owned.dispose();
		stopFocus();
	});

	it("preserves focused identity when a keyed node moves within the same root", () => {
		const stopFocus = installFocusRuntime();
		const root = rootForTest();
		const first = createElementNode("focus-test");
		const second = createElementNode("focus-test");
		first.props.tabIndex = 0;
		second.props.tabIndex = 1;
		append(root, first);
		append(root, second);
		focusElement(first);

		root.node.children.splice(0, 1);
		root.node.children.push(first);
		expect(root.node.children).toEqual([second, first]);
		expect(focusedElement(root.node)).toBe(first);

		disposeHostRoot(root);
		disposeFocusRoot(root.node);
		stopFocus();
	});
});

describe("host key dispatch", () => {
	it("reads the current handler and its latest state at dispatch time", () => {
		const stopFocus = installFocusRuntime();
		const root = rootForTest();
		const node = createElementNode("focus-test");
		node.props.tabIndex = 0;
		append(root, node);
		focusElement(node);

		let state = "old";
		const seen: string[] = [];
		node.props.onKey = () => seen.push(`first:${state}`);
		state = "new";
		dispatchKey(root, new HostKeyEvent("x"));
		node.props.onKey = () => seen.push(`replacement:${state}`);
		dispatchKey(root, new HostKeyEvent("y"));
		expect(seen).toEqual(["first:new", "replacement:new"]);

		remove(root, node);
		disposeHostRoot(root);
		disposeFocusRoot(root.node);
		stopFocus();
	});

	it("stops ancestor propagation when requested", () => {
		const stopFocus = installFocusRuntime();
		const root = rootForTest();
		const parent = createElementNode("focus-test");
		const child = createElementNode("focus-test");
		const seen: string[] = [];
		parent.props.onKey = () => seen.push("parent");
		child.props.onKey = (event: HostKeyEvent) => {
			seen.push("child");
			event.stopPropagation();
		};
		child.props.tabIndex = 0;
		parent.children.push(child);
		child.parent = parent;
		append(root, parent);
		focusElement(child);

		dispatchKey(root.node, new HostKeyEvent("z"));
		expect(seen).toEqual(["child"]);

		disposeHostRoot(root);
		disposeFocusRoot(root.node);
		stopFocus();
	});
});

describe("host mouse dispatch", () => {
	it("hit-tests painted spans and bubbles through current handlers", () => {
		const stopInput = installInputRuntime();
		const root = rootForTest();
		const parent = createElementNode("focus-test");
		const child = createElementNode("focus-test");
		const seen: string[] = [];
		parent.props.onMouse = () => seen.push("parent");
		child.props.onMouse = () => seen.push("old");
		parent.children.push(child);
		child.parent = parent;
		append(root, parent);
		recordPaintSpan(parent, 2, 2, 0, 20);
		recordPaintSpan(child, 2, 1, 0, 10);
		child.props.onMouse = () => seen.push("child");

		const handled = dispatchMouse(root.node, new HostMouseEvent({ row: 2, col: 3 }));
		expect(handled).toBe(true);
		expect(seen).toEqual(["child", "parent"]);

		remove(root, parent);
		disposeHostRoot(root);
		disposeFocusRoot(root.node);
		stopInput();
	});
});
