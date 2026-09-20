import { describe, expect, test } from "bun:test";
import { createSignal, type JSX } from "../../src/reactive";
import { RichText } from "../../src/core/richtext";
import { Style } from "../../src/core/style";
import { markDamage } from "../../src/host/damage";
import { createHostRoot, disposeHostRoot, type HostRoot } from "../../src/host/node";
import { createPaintContext, paintHostTree } from "../../src/host/paint";
import { registerElement } from "../../src/host/registry";
import { createElement, createTextNode, insert, insertNode, setProp } from "../../src/host/renderer";
import { Damage, type ElementImpl, type HostElement, type HostNode } from "../../src/host/types";
import { mountForTest } from "../../src/testing";
import { loadThemeSync } from "../../src/theme/loader";

const testTheme = loadThemeSync("dark");
const paintCalls = new Map<number, number>();

const containerElement: ElementImpl = {
	tag: "host-test-container",
	propDamage(name) {
		if (name === "color") return Damage.Paint;
		if (name === "href") return Damage.Link;
		return Damage.Layout;
	},
	paint(node, out, width, ctx) {
		for (const child of node.children) ctx.paintChild(child, out, width);
	},
};

const lineElement: ElementImpl = {
	tag: "host-test-line",
	propDamage: () => Damage.Layout,
	paint(node, out, _width, ctx) {
		ctx.paintInlineChildren(node, out, Style.NONE);
		out.br();
	},
};

const countingElement: ElementImpl = {
	tag: "host-test-counting",
	propDamage: () => Damage.Paint,
	paint(node, out) {
		paintCalls.set(node.id, (paintCalls.get(node.id) ?? 0) + 1);
		out.push(Style.NONE, String(node.props.label ?? ""));
		out.br();
	},
};

registerElement(containerElement);
registerElement(lineElement);
registerElement(countingElement);

function resetDamage(node: HostNode): void {
	node.damage = Damage.None;
	if (node.kind === "element") {
		for (const child of node.children) resetDamage(child);
	}
}

function paint(root: HostRoot, width = 20): RichText {
	const frame = new RichText();
	const context = createPaintContext(root, () => Style.NONE);
	paintHostTree(root, frame, width, context);
	frame.finish();
	return frame;
}

describe("retained host tree", () => {
	test("moves keyed nodes without replacing their identity", () => {
		const root = createHostRoot({ theme: testTheme });
		const parent = createElement("host-test-container") as HostElement;
		const first = createElement("host-test-counting");
		const second = createElement("host-test-counting");
		const third = createElement("host-test-counting");
		insertNode(root.node, parent);
		insertNode(parent, first);
		insertNode(parent, second);
		insertNode(parent, third);

		insertNode(parent, third, first);

		expect(parent.children).toEqual([third, first, second]);
		expect(parent.children[0]).toBe(third);
		expect(third.parent).toBe(parent);
		disposeHostRoot(root);
	});

	test("bubbles damage by invalidation class", () => {
		const notifications: Damage[] = [];
		const root = createHostRoot({
			theme: testTheme,
			onDamage(_node, damage) {
				notifications.push(damage);
			},
		});
		const parent = createElement("host-test-container") as HostElement;
		const leaf = createElement("host-test-counting");
		const text = createTextNode("text");
		insertNode(root.node, parent);
		insertNode(parent, leaf);
		insertNode(leaf, text);
		resetDamage(root.node);
		notifications.length = 0;

		markDamage(leaf, Damage.Paint);
		expect(leaf.damage).toBe(Damage.Paint);
		expect(parent.damage).toBe(Damage.Paint);
		expect(root.node.damage).toBe(Damage.Paint);

		resetDamage(root.node);
		markDamage(text, Damage.Text);
		expect(text.damage).toBe(Damage.Text);
		expect(leaf.damage).toBe(Damage.Text);
		expect(parent.damage).toBe(Damage.Text);
		expect(root.node.damage).toBe(Damage.Text);

		resetDamage(root.node);
		markDamage(leaf, Damage.Link);
		expect(leaf.damage).toBe(Damage.Link);
		expect(parent.damage).toBe(Damage.Paint);
		expect(root.node.damage).toBe(Damage.Paint);
		expect(notifications).toEqual([Damage.Paint, Damage.Text, Damage.Link]);
		disposeHostRoot(root);
	});

	test("repaints only a dirty branch and replays clean sibling caches", () => {
		paintCalls.clear();
		const root = createHostRoot({ theme: testTheme });
		const parent = createElement("host-test-container") as HostElement;
		const first = createElement("host-test-counting") as HostElement;
		const second = createElement("host-test-counting") as HostElement;
		setProp(first, "label", "first");
		setProp(second, "label", "second");
		insertNode(root.node, parent);
		insertNode(parent, first);
		insertNode(parent, second);

		expect(paint(root).rows).toBe(2);
		expect(paintCalls.get(first.id)).toBe(1);
		expect(paintCalls.get(second.id)).toBe(1);
		paint(root);
		expect(paintCalls.get(first.id)).toBe(1);
		expect(paintCalls.get(second.id)).toBe(1);

		markDamage(first, Damage.Paint);
		const frame = paint(root);
		expect(frame.rowText(0)).toBe("first");
		expect(frame.rowText(1)).toBe("second");
		expect(paintCalls.get(first.id)).toBe(2);
		expect(paintCalls.get(second.id)).toBe(1);
		disposeHostRoot(root);
	});

	test("updates a text node in place without rerunning the view", () => {
		const [value, setValue] = createSignal("first");
		let viewRuns = 0;
		let line: HostElement | undefined;
		const mounted = mountForTest(
			() => {
				viewRuns++;
				line = createElement("host-test-line") as HostElement;
				insert(line, value);
				return line as unknown as JSX.Element;
			},
			{ width: 20, theme: testTheme },
		);
		const textNode = line?.children[0];

		expect(mounted.text()).toEqual(["first"]);
		setValue("second");
		mounted.flush();
		expect(mounted.text()).toEqual(["second"]);
		expect(line?.children[0]).toBe(textNode);
		expect(viewRuns).toBe(1);
		expect(mounted.counters().viewRuns).toBe(1);
		mounted.dispose();
	});
});
