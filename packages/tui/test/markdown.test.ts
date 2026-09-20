import { describe, expect, it } from "bun:test";
import { createDocument } from "../src/document/document";
import type { TextDocument } from "../src/document/types";
import { createElement, setProp } from "../src/host/renderer";
import type { JSX } from "../src/reactive";
import { mountForTest } from "../src/testing";
import "../src/host/elements/markdown";

function view(
	document: TextDocument,
	onLayout?: (layout: { readonly width: number; readonly rows: readonly string[] }) => void,
): JSX.Element {
	const node = createElement("markdown");
	setProp(node, "document", document);
	if (onLayout) setProp(node, "onLayout", onLayout);
	return node;
}

describe("markdown element", () => {
	it("renders links, emphasis, code, and document replacements", () => {
		const document = createDocument("[link](https://example.com) with **bold** and `code`");
		const root = mountForTest(() => view(document), { width: 80 });
		try {
			expect(root.text().join("\n")).toContain("link");
			expect(root.text().join("\n")).toContain("bold");
			document.apply({ kind: "reset", text: "replacement" });
			root.flush();
			expect(root.text().join("\n")).toContain("replacement");
		} finally {
			root.dispose();
		}
	});

	it("reports the MarkdownEngine's actual wrapped rows", () => {
		const layouts: Array<{ readonly width: number; readonly rows: readonly string[] }> = [];
		const document = createDocument("one two three");
		const root = mountForTest(() => view(document, layout => layouts.push(layout)), { width: 7 });
		try {
			const text = root.text();
			const initial = layouts.at(-1);
			expect(initial).toBeDefined();
			expect(initial?.width).toBe(7);
			expect(initial?.rows).toEqual(text);
			root.rows(11);
			expect(layouts.at(-1)?.width).toBe(11);
			expect(layouts.at(-1)?.rows.map(row => row.trimEnd())).toEqual(["one two", "three"]);
		} finally {
			root.dispose();
		}
	});
});
