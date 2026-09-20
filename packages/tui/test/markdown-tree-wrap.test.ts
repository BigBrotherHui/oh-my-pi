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

describe("markdown tree wrapping", () => {
	it("keeps tree-guide text visible after narrow wrapping", () => {
		const root = mountForTest(() => view(createDocument("├── a long Korean 경로 name that wraps")), { width: 16 });
		try {
			const rows = root.text(16);
			expect(rows.join("\n")).toContain("├──");
			expect(rows.join("\n")).toContain("경로");
		} finally {
			root.dispose();
		}
	});
});
