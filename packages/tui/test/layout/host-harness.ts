import { emitRows } from "../../src/core/emit";
import { RichText } from "../../src/core/richtext";
import { createHostRoot } from "../../src/host/node";
import { createPaintContext, paintNode } from "../../src/host/paint";
import { elementFor } from "../../src/host/registry";
import { Damage, type HostElement, type HostNode, type HostText } from "../../src/host/types";
import { resolveStyle } from "../../src/style/cascade";
import { theme } from "../../src/theme/theme";

let nextId = -1;

/** Create a detached retained text node for element-level tests. */
export function hostText(text: string): HostText {
	return {
		id: nextId--,
		kind: "text",
		parent: null,
		damage: Damage.Layout,
		cache: new RichText(),
		cacheWidth: -1,
		cacheEpoch: -1,
		text,
	};
}

/** Create a retained host element and wire its child parent links. */
export function hostElement(tag: string, props: Record<string, unknown> = {}, children: HostNode[] = []): HostElement {
	const node: HostElement = {
		id: nextId--,
		kind: "element",
		tag,
		parent: null,
		damage: Damage.Layout,
		cache: new RichText(),
		cacheWidth: -1,
		cacheEpoch: -1,
		props,
		children,
		slots: new Map(),
		impl: elementFor(tag),
		state: undefined,
	};
	for (const child of children) child.parent = node;
	return node;
}

/** Paint one retained test element and return its run buffer. */
export function paintElement(node: HostElement, width: number): RichText {
	const root = createHostRoot({ theme });
	root.node.children.push(node);
	node.parent = root.node;
	const context = createPaintContext(root, element => resolveStyle(element, { theme: root.theme }));
	const result = new RichText();
	paintNode(node, result, width, context);
	result.finish();
	return result;
}

/** Serialize a retained test element to ANSI terminal rows. */
export function elementRows(node: HostElement, width: number): string[] {
	return emitRows(paintElement(node, width), { mode: theme.getColorMode() });
}

/** Return visible text rows without serializing styles. */
export function elementText(node: HostElement, width: number): string[] {
	const result = paintElement(node, width);
	return Array.from({ length: result.rows }, (_value, row) => result.rowText(row));
}
