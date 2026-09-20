import { describe, expect, it } from "bun:test";
import {
	globActivitySummary,
	globToolView,
	type GlobRenderArgs,
	type GlobToolDetails,
} from "@oh-my-pi/pi-tui/tools/glob";
import { ToolBlock } from "../src/chat/tool-block";
import { createComponent } from "../src/host/renderer";
import { createToolCallModel } from "../src/tools/model";
import { mountForTest } from "../src/testing";
import { cellGrid } from "./cell-grid";

describe("globToolView", () => {
	it("replaces the pending call with streamed matches before the terminal result", () => {
		const model = createToolCallModel<GlobRenderArgs, GlobToolDetails>({
			id: "call-glob-live",
			toolName: "glob",
			label: "Glob",
		});
		model.applyArgsChunk({ path: "src/**/*.ts", limit: 20 });
		model.markRunning();

		const root = mountForTest(() => globToolView.view(model), { width: 120 });
		try {
			expect(root.text(120).join("\n")).toContain("Glob");
			expect(root.text(120).join("\n")).toContain("src/**/*.ts");
			expect(root.text(120).join("\n")).toContain("limit:20");

			model.applyResult(
				{
					content: [{ type: "text", text: "src/index.ts\nsrc/view.ts" }],
					details: {
						fileCount: 2,
						files: ["src/index.ts", "src/view.ts"],
					},
				},
				{ partial: true },
			);
			root.flush();

			const streamed = root.text(120).join("\n");
			expect(streamed).toContain("2 files");
			expect(streamed).toContain("src/index.ts");
			expect(streamed).toContain("src/view.ts");

			model.applyResult({
				content: [{ type: "text", text: "" }],
				details: {
					fileCount: 2,
					files: ["src/index.ts", "src/view.ts"],
					scopePath: "src",
				},
			});
			root.flush();

			const settled = root.text(120).join("\n");
			expect(settled).toContain("in src");
			expect(cellGrid(root.rows(120), 120).length).toBeGreaterThan(0);
		} finally {
			root.dispose();
		}
	});

	it("keeps the historical eight-item collapsed budget and expands the complete file list", () => {
		const files = Array.from({ length: 10 }, (_, index) => `src/file-${index + 1}.ts`);
		const model = createToolCallModel<GlobRenderArgs, GlobToolDetails>({
			id: "call-glob-budget",
			toolName: "glob",
			label: "Glob",
		});
		model.applyArgsChunk({ path: "src/**/*.ts" });
		model.applyResult({
			content: [{ type: "text", text: files.join("\n") }],
			details: { fileCount: files.length, files },
		});
		model.setUi({ expanded: false });

		const root = mountForTest(() => globToolView.view(model), { width: 120 });
		try {
			const collapsed = root.text(120).join("\n");
			expect(collapsed).toContain("src/file-8.ts");
			expect(collapsed).not.toContain("src/file-9.ts");
			expect(collapsed).toContain("… 2 more files");

			model.setUi({ expanded: true });
			root.flush();

			const expanded = root.text(120).join("\n");
			expect(expanded).toContain("src/file-10.ts");
			expect(expanded).not.toContain("… 2 more files");
		} finally {
			root.dispose();
		}
	});

	it("keeps timeout scans distinct from verified emptiness and preserves missing-path warnings", () => {
		const model = createToolCallModel<GlobRenderArgs, GlobToolDetails>({
			id: "call-glob-timeout",
			toolName: "glob",
			label: "Glob",
		});
		model.applyArgsChunk({ paths: ["src", "missing"] });
		model.applyResult({
			content: [{ type: "text", text: "Glob timed out after 5s before finding any matches" }],
			details: {
				fileCount: 0,
				files: [],
				truncated: true,
				missingPaths: ["missing"],
			},
		});

		const root = mountForTest(() => globToolView.view(model), { width: 120 });
		try {
			const text = root.text(120).join("\n");
			expect(text).toContain("No matches before timeout (scan incomplete)");
			expect(text).toContain("timed out");
			expect(text).toContain("skipped missing: missing");
			expect(text).not.toContain("No files found");
		} finally {
			root.dispose();
		}
	});

	it("renders standalone errors and reports aborted calls as aborted summaries", () => {
		const failed = createToolCallModel<GlobRenderArgs, GlobToolDetails>({
			id: "call-glob-error",
			toolName: "glob",
			label: "Glob",
		});
		failed.applyArgsChunk({ path: "missing/**/*.ts" });
		failed.applyResult({ content: [{ type: "text", text: "Error: access denied" }], isError: true });

		const root = mountForTest(() => globToolView.view(failed), { width: 120 });
		try {
			const text = root.text(120).join("\n");
			expect(text).toContain("Error: access denied");
			expect(text).not.toContain("Glob");
		} finally {
			root.dispose();
		}

		const aborted = createToolCallModel<GlobRenderArgs, GlobToolDetails>({
			id: "call-glob-aborted",
			toolName: "glob",
			label: "Glob",
		});
		aborted.applyArgsChunk({ path: "src/**/*.ts" });
		aborted.applyResult({ content: [], status: "cancelled" });

		expect(globActivitySummary(aborted).status).toBe("aborted");
	});

	it("keeps ToolBlock glob output transparent after success and failure", () => {
		const width = 80;
		const success = createToolCallModel<GlobRenderArgs, GlobToolDetails>({
			id: "call-glob-transparent-success",
			toolName: "glob",
			label: "Glob",
		});
		success.applyArgsChunk({ path: "src/**/*.ts" });
		success.applyResult({
			content: [{ type: "text", text: "src/index.ts" }],
			details: { fileCount: 1, files: ["src/index.ts"] },
		});
		success.setUi({ allocation: 80 });

		const successRoot = mountForTest(() => createComponent(ToolBlock, { model: success }), { width });
		try {
			for (const row of cellGrid(successRoot.rows(width), width)) {
				for (const cell of row) expect(cell.bg).toBeNull();
			}
		} finally {
			successRoot.dispose();
		}

		const failed = createToolCallModel<GlobRenderArgs, GlobToolDetails>({
			id: "call-glob-transparent-failure",
			toolName: "glob",
			label: "Glob",
		});
		failed.applyArgsChunk({ path: "missing/**/*.ts" });
		failed.applyResult({ content: [{ type: "text", text: "Error: access denied" }], isError: true });
		failed.setUi({ allocation: 80 });

		const failedRoot = mountForTest(() => createComponent(ToolBlock, { model: failed }), { width });
		try {
			for (const row of cellGrid(failedRoot.rows(width), width)) {
				for (const cell of row) expect(cell.bg).toBeNull();
			}
		} finally {
			failedRoot.dispose();
		}
	});
});
