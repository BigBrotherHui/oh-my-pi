import { describe, expect, it } from "bun:test";
import { createDocument } from "../src/document/document";
import type { TextDocument } from "../src/document/types";
import { createElement, setProp } from "../src/host/renderer";
import type { JSX } from "../src/reactive";
import { mountForTest } from "../src/testing";
import "../src/host/elements/markdown";

function view(document: TextDocument): JSX.Element {
	const node = createElement("markdown");
	setProp(node, "document", document);
	return node;
}

describe("markdown incremental document rendering", () => {
	it("publishes only parser-frozen prefixes from explicit transient documents", () => {
		const document = createDocument("finished paragraph\n\nlive tail");
		const stable: string[] = [];
		const node = createElement("markdown");
		setProp(node, "document", document);
		setProp(node, "transient", true);
		setProp(node, "onStableText", (text: string) => stable.push(text));
		const root = mountForTest(() => node, { width: 60 });
		try {
			root.flush();
			expect(stable.at(-1)).toBe("finished paragraph\n\n");
			setProp(node, "transient", false);
			root.flush();
			expect(stable.at(-1)).toBe("");
		} finally {
			root.dispose();
		}
	});

	it("repaints appended fenced content without losing settled prose", () => {
		const document = createDocument("before\n\n```ts\nconst value = 1;");
		const root = mountForTest(() => view(document), { width: 60 });
		try {
			document.apply({ kind: "append", text: "\n```\n\nafter" });
			root.flush();
			const text = root.text().join("\n");
			expect(text).toContain("before");
			expect(text).toContain("const value = 1;");
			expect(text).toContain("after");
		} finally {
			root.dispose();
		}
	});
});
