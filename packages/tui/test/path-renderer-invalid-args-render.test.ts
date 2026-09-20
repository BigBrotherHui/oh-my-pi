import { describe, expect, it } from "bun:test";
import { createToolCallModel } from "../src/tools/model";
import { editToolView, type EditRenderArgs, type EditToolDetails } from "../src/tools/edit";
import { readToolView, type ReadRenderArgs, type ReadToolDetails } from "../src/tools/read";
import { writeToolView, type WriteRenderArgs, type WriteToolDetails } from "../src/tools/write";
import { mountForTest } from "../src/testing";

describe("tool output with malformed provider paths", () => {
	it("keeps read content visible when the requested path is not a string", () => {
		const model = createToolCallModel<ReadRenderArgs, ReadToolDetails>({
			id: "invalid-read",
			toolName: "read",
			label: "Read",
		});
		model.applyArgsChunk(JSON.stringify({ path: { value: "src/example.ts" } }));
		const root = mountForTest(() => readToolView.view(model));
		try {
			model.applyResult({
				content: [{ type: "text", text: "read output sentinel" }],
				details: { contentType: "text/plain" },
			});
			expect(root.text().join("\n")).toContain("read output sentinel");
			expect(root.text().join("\n")).not.toContain("[object Object]");
		} finally {
			root.dispose();
		}
	});

	it("preserves a streamed write body and then its failure despite a malformed path", () => {
		const model = createToolCallModel<WriteRenderArgs, WriteToolDetails>({
			id: "invalid-write",
			toolName: "write",
			label: "Write",
		});
		model.applyArgsChunk(JSON.stringify({ path: ["src/example.ts"], content: "first line\nwrite output sentinel" }));
		const root = mountForTest(() => writeToolView.view(model));
		try {
			expect(root.text().join("\n")).toContain("write output sentinel");
			model.applyResult({ content: [{ type: "text", text: "Path must be a string" }], isError: true });
			expect(root.text().join("\n")).toContain("Path must be a string");
		} finally {
			root.dispose();
		}
	});

	it("preserves edit diff content when the provider supplied an object path", () => {
		const model = createToolCallModel<EditRenderArgs, EditToolDetails>({
			id: "invalid-edit",
			toolName: "edit",
			label: "Edit",
		});
		model.applyArgsChunk(
			JSON.stringify({ path: { value: "src/example.ts" }, oldText: "before", newText: "edit output sentinel" }),
		);
		const root = mountForTest(() => editToolView.view(model));
		try {
			model.applyResult({
				content: [{ type: "text", text: "updated" }],
				details: { diff: "-before\n+edit output sentinel" },
			});
			expect(root.text().join("\n")).toContain("edit output sentinel");
			expect(root.text().join("\n")).not.toContain("[object Object]");
		} finally {
			root.dispose();
		}
	});
});
