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

describe("markdown append rendering", () => {
	it("shows every append in the mutable document tail", () => {
		const document = createDocument("A paragraph");
		const root = mountForTest(() => view(document), { width: 30 });
		try {
			document.apply({ kind: "append", text: " grows one word" });
			root.flush();
			expect(root.text().join("\n")).toContain("grows one word");
		} finally {
			root.dispose();
		}
	});
});
