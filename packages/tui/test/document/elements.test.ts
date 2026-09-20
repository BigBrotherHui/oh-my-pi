import { describe, expect, test } from "bun:test";
import { RichText } from "../../src/core/richtext";
import { DEFAULT_COLOR } from "../../src/core/style";
import { emitRows } from "../../src/core/emit";
import { cellGrid } from "../cell-grid";
import { createDocument } from "../../src/document/document";
import { getHighlightTokenizeCount, resetHighlightCounters } from "../../src/document/highlight";
import { counters, resetCounters } from "../../src/instrumentation";
import {
	attachHostSubtree,
	createElementNode,
	createHostRoot,
	disposeHostRoot,
	type HostRoot,
} from "../../src/host/node";
import { createPaintContext } from "../../src/host/paint";
import type { HostElement } from "../../src/host/types";
import { resolveStyle } from "../../src/style/cascade";
import { loadThemeSync } from "../../src/theme/loader";
import type { Theme } from "../../src/theme/theme";
import "../../src/host/elements/code";
import "../../src/host/elements/diff";
import "../../src/host/elements/json";
import "../../src/host/elements/pre";
import "../../src/host/elements/preview";

interface ElementHarness {
	readonly root: HostRoot;
	readonly node: HostElement;
	paint(width: number): RichText;
	dispose(): void;
}

function elementHarness(tag: string, props: object, theme: Theme): ElementHarness {
	const root = createHostRoot({ theme });
	const node = createElementNode(tag);
	node.props = props as Record<string, unknown>;
	node.parent = root.node;
	root.node.children.push(node);
	attachHostSubtree(node, root);
	return {
		root,
		node,
		paint(width) {
			const frame = new RichText();
			const context = createPaintContext(root, element => resolveStyle(element, { theme: root.theme }));
			node.impl.paint(node, frame, width, context);
			frame.finish();
			return frame;
		},
		dispose() {
			disposeHostRoot(root);
		},
	};
}

function rowTexts(frame: RichText): string[] {
	const rows = new Array<string>(frame.rows);
	for (let row = 0; row < rows.length; row++) rows[row] = frame.rowText(row);
	return rows;
}

describe("document elements", () => {
	test("a code tail retains syntax scope established before its visible range", () => {
		const theme = loadThemeSync("dark");
		const document = createDocument("function example() {\n  return 1;\n}");
		const whole = elementHarness("code", { document, language: "typescript" }, theme);
		const tail = elementHarness("code", { document, language: "typescript", startLine: 2 }, theme);
		try {
			const allRows = cellGrid(emitRows(whole.paint(20), { mode: "truecolor" }), 20);
			const tailRows = cellGrid(emitRows(tail.paint(20), { mode: "truecolor" }), 20);
			expect(allRows[2]![0]!.fg).not.toBeNull();
			expect(tailRows[0]).toEqual(allRows[2]);
		} finally {
			whole.dispose();
			tail.dispose();
		}
	});
	test("code preserves rows across chunk partitions", () => {
		const source = "const emoji = '😀';\r\nconsole.log(emoji);";
		const whole = createDocument(source);
		const chunked = createDocument();
		for (const chunk of ["const emoji = '\ud83d", "\ude00';\r", "\nconsole.", "log(emoji);"]) {
			chunked.apply({ kind: "append", text: chunk });
		}
		const theme = loadThemeSync("dark");
		const first = elementHarness("code", { document: whole, language: "typescript" }, theme);
		const second = elementHarness("code", { document: chunked, language: "typescript" }, theme);
		try {
			expect(rowTexts(second.paint(80))).toEqual(rowTexts(first.paint(80)));
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	test("palette repaint resolves cached roles without re-tokenizing", () => {
		const document = createDocument("const answer: number = 42;");
		const harness = elementHarness("code", { document, language: "typescript" }, loadThemeSync("dark"));
		resetCounters();
		resetHighlightCounters();
		try {
			const before = rowTexts(harness.paint(80));
			expect(counters().parses).toBe(1);
			expect(getHighlightTokenizeCount()).toBe(1);
			harness.root.theme = loadThemeSync("light");
			const after = rowTexts(harness.paint(80));
			expect(after).toEqual(before);
			expect(counters().parses).toBe(1);
			expect(getHighlightTokenizeCount()).toBe(1);
		} finally {
			harness.dispose();
		}
	});

	test("pre only interprets ANSI behind the explicit ansi prop", () => {
		const document = createDocument("\x1b[31mred\x1b[0m");
		const theme = loadThemeSync("dark");
		const plain = elementHarness("pre", { document }, theme);
		const ansi = elementHarness("pre", { document, ansi: true }, theme);
		try {
			const plainFrame = plain.paint(20);
			const ansiFrame = ansi.paint(20);
			expect(rowTexts(plainFrame)).toEqual(["red"]);
			expect(rowTexts(ansiFrame)).toEqual(["red"]);
			expect(plainFrame.style[0]?.fg).toBe(DEFAULT_COLOR);
			expect(ansiFrame.style[0]?.fg).not.toBe(DEFAULT_COLOR);
		} finally {
			plain.dispose();
			ansi.dispose();
		}
	});

	test("json projects nested values with semantic scalars and bounded depth", () => {
		const harness = elementHarness(
			"json",
			{ value: { ok: true, nested: { count: 2 } }, maxDepth: 1, maxLines: 10, rootConnectors: "siblings" },
			loadThemeSync("dark"),
		);
		try {
			const rows = rowTexts(harness.paint(80));
			expect(rows.some(row => row.includes("ok: true"))).toBe(true);
			expect(rows.some(row => row.includes("nested {1}"))).toBe(true);
			expect(rows.some(row => row.includes("…"))).toBe(true);
		} finally {
			harness.dispose();
		}
	});

	test("preview counts and labels the declared unit and slices oversized groups", () => {
		const theme = loadThemeSync("dark");
		const items = elementHarness(
			"preview",
			{ groups: [["a", "b", "c", "d", "e"], ["f"]], edge: "head", limit: 3, unit: "items" },
			theme,
		);
		const lines = elementHarness(
			"preview",
			{ document: createDocument("a\nb\nc\nd\ne"), edge: "tail", limit: 3, unit: "lines" },
			theme,
		);
		const rows = elementHarness(
			"preview",
			{ document: createDocument("abcdefghijklmno"), edge: "head", limit: 2, unit: "rows" },
			theme,
		);
		try {
			expect(rowTexts(items.paint(20))).toEqual(["a", "b", "… 4 more items"]);
			expect(rowTexts(lines.paint(20))).toEqual(["… 3 earlier lines", "d", "e"]);
			expect(rowTexts(rows.paint(5))).toEqual(["abcde", "… 2 more rows"]);
		} finally {
			items.dispose();
			lines.dispose();
			rows.dispose();
		}
	});

	test("diff wrapped continuations align under the gutter without a separator", () => {
		const document = createDocument("  1|abcdefghijklmnopqrstuvwxyz");
		const harness = elementHarness("diff", { document, wrap: true }, loadThemeSync("dark"));
		try {
			const rows = rowTexts(harness.paint(10));
			expect(rows.length).toBeGreaterThan(1);
			for (const continuation of rows.slice(1)) {
				expect(continuation.startsWith("    ")).toBe(true);
				expect(continuation.startsWith("    │")).toBe(false);
			}
		} finally {
			harness.dispose();
		}
	});
});
