import { describe, expect, it } from "bun:test";
import { createDocument } from "../src/document/document";
import type { TextDocument } from "../src/document/types";
import { createElement, setProp } from "../src/host/renderer";
import type { JSX } from "../src/reactive";
import { mountForTest } from "../src/testing";
import "../src/host/elements/markdown";

function markdown(document: TextDocument): JSX.Element {
	const node = createElement("markdown");
	setProp(node, "document", document);
	return node;
}

describe("markdown element math", () => {
	it("renders inline and display math from a document", () => {
		const document = createDocument("Euler: $x^2$\n\n$$\\frac{1}{2}$$");
		const root = mountForTest(() => markdown(document), { width: 80 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("x²");
			expect(text).toContain("1");
			document.apply({ kind: "append", text: "\n$y_1$" });
			root.flush();
			expect(root.text().join("\n")).toContain("y₁");
		} finally {
			root.dispose();
		}
	});
});
