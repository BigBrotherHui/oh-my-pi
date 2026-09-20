import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import { writeToolView, type WriteRenderArgs, type WriteToolDetails } from "../src/tools/write";

describe("write tool view", () => {
	it("renders the target path, line count, and settled preview", () => {
		const model = createToolCallModel<WriteRenderArgs, WriteToolDetails>({
			id: "write-1",
			toolName: "write",
			label: "Write",
		});
		model.applyArgsChunk({ path: "src/example.ts", content: "export const answer = 42;\n" });
		model.applyResult({ content: [], details: { madeExecutable: true, resolvedPath: "/work/src/example.ts" } });

		const root = mountForTest(() => writeToolView.view(model), { width: 80 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("src/example.ts");
			expect(text).toContain("2 lines");
			expect(text).toContain("made executable!");
			expect(text).toContain("export const answer = 42;");
		} finally {
			root.dispose();
		}
	});

	it("shows a normalized error message for a failed write", () => {
		const model = createToolCallModel<WriteRenderArgs, WriteToolDetails>({
			id: "write-2",
			toolName: "write",
			label: "Write",
		});
		model.applyArgsChunk({ path: "readonly.txt" });
		model.applyResult({ content: [{ type: "text", text: "Error: permission denied" }], isError: true });

		const root = mountForTest(() => writeToolView.view(model), { width: 80 });
		try {
			expect(root.text().join("\n")).toContain("permission denied");
		} finally {
			root.dispose();
		}
	});

	it("reanchors a partial result at the file head and keeps completion output out of the preview", () => {
		const model = createToolCallModel<WriteRenderArgs, WriteToolDetails>({
			id: "write-3",
			toolName: "write",
			label: "Write",
		});
		const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		model.applyArgsChunk({ path: "src/stream.ts", content });
		model.applyResult(
			{
				content: [{ type: "text", text: "Writing 151 bytes to src/stream.ts..." }],
				details: { resolvedPath: "/work/src/stream.ts" },
			},
			{ partial: true },
		);

		const root = mountForTest(() => writeToolView.view(model), { width: 100 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("Writing 151 bytes to src/stream.ts...");
			expect(text).toContain("line 1");
			expect(text).toContain("… 14 more lines");

			model.applyResult({ content: [{ type: "text", text: "Successfully wrote 151 bytes" }] });
			root.flush();

			const settled = root.text().join("\n");
			expect(settled).not.toContain("Successfully wrote 151 bytes");
			expect(settled).toContain("line 1");
			expect(settled).toContain("… 14 more lines");
		} finally {
			root.dispose();
		}
	});

	it("keeps a provisional device path hidden but falls back to Write when the caller declines delegation", () => {
		const model = createToolCallModel<WriteRenderArgs, WriteToolDetails>({
			id: "write-4",
			toolName: "write",
			label: "Write",
		});
		model.applyArgsChunk({ path: "xd://unmounted" });

		const root = mountForTest(() => writeToolView.view(model), { width: 80 });
		try {
			expect(root.text()).toEqual([]);

			model.applyArgsChunk({ content: '{"action":"references"}' });
			root.flush();

			const text = root.text().join("\n");
			expect(text).toContain("Write");
			expect(text).toContain("xd://unmounted");
		} finally {
			root.dispose();
		}
	});

	it("keeps five diagnostics in the compact card and reveals the remaining item on expand", () => {
		const model = createToolCallModel<WriteRenderArgs, WriteToolDetails>({
			id: "write-5",
			toolName: "write",
			label: "Write",
		});
		model.applyArgsChunk({ path: "src/example.ts", content: "const answer = 42;" });
		model.applyResult({
			content: [],
			details: {
				diagnostics: {
					summary: "6 warnings",
					errored: false,
					messages: Array.from(
						{ length: 6 },
						(_, index) => `src/example.ts:${index + 1}:1 [warning] issue ${index + 1}`,
					),
				},
			},
		});

		const root = mountForTest(() => writeToolView.view(model), { width: 100 });
		try {
			expect(root.text().join("\n")).toContain("… 1 more");
			expect(root.text().join("\n")).not.toContain("issue 6");

			model.setUi({ expanded: true });
			root.flush();

			expect(root.text().join("\n")).toContain("issue 6");
		} finally {
			root.dispose();
		}
	});

	it("groups multiline diagnostics and keeps nested details aligned under their message", () => {
		const model = createToolCallModel<WriteRenderArgs, WriteToolDetails>({
			id: "write-overload",
			toolName: "write",
			label: "Write",
		});
		model.applyArgsChunk({ path: "src/edited.ts", content: "export const changed = true;" });
		model.applyResult({
			content: [],
			details: {
				diagnostics: {
					summary: "3 errors",
					errored: true,
					messages: [
						"src/consumer.ts:50:43 [error] Argument mismatch. (2345)",
						"src/consumer.ts:64:9 [error] No overload matches this call.\n  The last overload rejected the argument.\n    Type 'undefined' is not assignable to 'string'. (2769)",
						"src/consumer.ts:71:9 [error] Another overload mismatch.\r\n\tA required argument is missing. (2554)",
					],
				},
			},
		});

		const root = mountForTest(() => writeToolView.view(model), { width: 100 });
		try {
			const rows = root.text();
			const text = rows.join("\n");
			expect(text.match(/src\/consumer\.ts/g)).toHaveLength(1);
			const first = rows.findIndex(row => row.includes("Argument mismatch."));
			const overload = rows.findIndex(row => row.includes("No overload matches"));
			expect(first).toBeGreaterThanOrEqual(0);
			expect(overload).toBe(first + 1);
			const messageColumn = rows[overload]!.indexOf("No overload");
			const continuation = rows.find(row => row.includes("The last overload"));
			expect(continuation?.indexOf("The last overload")).toBe(messageColumn + 2);
			expect(continuation?.slice(0, messageColumn)).toContain(root.root.theme.tree.vertical);
			expect(text).toContain("(2769)");
			expect(text).not.toMatch(/[\r\t]/);

			const narrow = root.text(40);
			expect(narrow.every(row => Bun.stringWidth(row) <= 40)).toBe(true);
			expect(narrow.join("\n")).toContain("undefined");
			expect(narrow.find(row => row.includes("rejected"))?.indexOf("rejected")).toBe(messageColumn + 2);
			expect(narrow.join("\n")).not.toContain("[error]");
		} finally {
			root.dispose();
		}
	});

	it("reports aborted writes in the compact activity summary", () => {
		const model = createToolCallModel<WriteRenderArgs, WriteToolDetails>({
			id: "write-5",
			toolName: "write",
			label: "Write",
		});
		model.applyArgsChunk({ path: "cancelled.txt", content: "draft" });
		model.applyResult({ content: [], status: "cancelled" });

		expect(writeToolView.summary?.(model)?.status).toBe("aborted");
	});
});
