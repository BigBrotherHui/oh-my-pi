import { expect, test } from "bun:test";
import { RichText } from "../../src/core/richtext";
import { DEFAULT_COLOR } from "../../src/core/style";
import { createDocument } from "../../src/document/document";
import { attachHostSubtree, createElementNode, createHostRoot, disposeHostRoot } from "../../src/host/node";
import { createPaintContext } from "../../src/host/paint";
import { resolveStyle } from "../../src/style/cascade";
import { loadThemeSync } from "../../src/theme/loader";
import { setThemeInstance } from "../../src/theme/theme";
import "../../src/host/elements/markdown";

function rowTexts(frame: RichText): string[] {
	return Array.from({ length: frame.rows }, (_, row) => frame.rowText(row));
}

test("semantic reflow wraps to its physical allocation without adding padded blank rows", () => {
	const theme = loadThemeSync("dark");
	const root = createHostRoot({ theme });
	const node = createElementNode("markdown");
	node.props = { document: createDocument("alpha bravo c"), wrapAllowance: 1 };
	node.parent = root.node;
	root.node.children.push(node);
	attachHostSubtree(node, root);
	try {
		const frame = new RichText();
		const context = createPaintContext(root, element => resolveStyle(element, { theme }));
		node.impl.paint(node, frame, 10, context);
		frame.finish();
		expect(rowTexts(frame)).toEqual(["alpha", "bravo", "c"]);
	} finally {
		disposeHostRoot(root);
	}
});

test("closing a streamed fence invalidates the open block before painting following prose", () => {
	const theme = loadThemeSync("dark");
	setThemeInstance(theme);
	const document = createDocument("```ts\nconst x = 1;\n");
	const root = createHostRoot({ theme });
	const node = createElementNode("markdown");
	node.props = { document };
	node.parent = root.node;
	root.node.children.push(node);
	attachHostSubtree(node, root);
	const paint = (): RichText => {
		const frame = new RichText();
		const context = createPaintContext(root, element => resolveStyle(element, { theme: root.theme }));
		node.impl.paint(node, frame, 60, context);
		frame.finish();
		return frame;
	};
	try {
		expect(rowTexts(paint()).join("\n")).not.toContain("After");
		document.apply({ kind: "append", text: "```\nAfter" });
		const closed = paint();
		const rows = rowTexts(closed);
		expect(rows.some(row => row.trimEnd() === "After")).toBe(true);
		const afterRun = closed.text.findIndex(text => text.includes("After"));
		expect(afterRun).toBeGreaterThanOrEqual(0);
		expect(closed.style[afterRun]?.fg).toBe(DEFAULT_COLOR);
	} finally {
		disposeHostRoot(root);
	}
});
