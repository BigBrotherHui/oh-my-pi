import { describe, expect, it } from "bun:test";
import { ToolBlock } from "../src/chat/tool-block";
import { mountForTest } from "../src/testing";
import { type GrepRenderArgs, type GrepToolDetails, grepToolView } from "@oh-my-pi/pi-tui/tools/grep";
import { createToolCallModel } from "../src/tools/model";
import { cellGrid } from "./cell-grid";

describe("grepToolView", () => {
	it("keeps historical grep output transparent through the transcript ToolBlock", () => {
		const model = createToolCallModel<GrepRenderArgs, GrepToolDetails>({
			id: "call-grep-transparent",
			toolName: "grep",
			label: "Grep",
		});
		model.applyArgsChunk({ pattern: "needle", path: "src" });
		model.markRunning();
		model.setUi({ allocation: Number.MAX_SAFE_INTEGER });

		const root = mountForTest(() => ToolBlock({ model }), { width: 120 });
		try {
			const hasBackground = cellGrid(root.rows(120), 120).some(row => row.some(cell => cell.bg !== null));
			expect(hasBackground).toBe(false);
		} finally {
			root.dispose();
		}

		const settled = createToolCallModel<GrepRenderArgs, GrepToolDetails>({
			id: "call-grep-transparent-settled",
			toolName: "grep",
			label: "Grep",
		});
		settled.applyArgsChunk({ pattern: "needle", path: "src" });
		settled.applyResult({
			content: [{ type: "text", text: "" }],
			details: { matchCount: 1, fileCount: 1, displayContent: "# result.ts\n*1│needle" },
		});
		settled.setUi({ allocation: Number.MAX_SAFE_INTEGER });

		const settledRoot = mountForTest(() => ToolBlock({ model: settled }), { width: 120 });
		try {
			const hasBackground = cellGrid(settledRoot.rows(120), 120).some(row => row.some(cell => cell.bg !== null));
			expect(hasBackground).toBe(false);
		} finally {
			settledRoot.dispose();
		}
	});

	it("renders reactive arguments and a settled grouped result", () => {
		const model = createToolCallModel<GrepRenderArgs, GrepToolDetails>({
			id: "call-grep-1",
			toolName: "grep",
			label: "Grep",
		});
		model.applyArgsChunk({ pattern: "initialPattern" });
		model.markRunning();
		const root = mountForTest(() => grepToolView.view(model), { width: 120 });
		try {
			expect(root.text(120).join("\n")).toContain("initialPattern");
			model.applyArgsChunk({ pattern: "updatedPattern" });
			root.flush();
			expect(root.text(120).join("\n")).toContain("updatedPattern");
			model.applyResult({
				content: [{ type: "text", text: "" }],
				details: {
					matchCount: 1,
					fileCount: 1,
					displayContent: ["# src/", "## test.ts", "*1│const found = true;"].join("\n"),
				},
			});
			root.flush();
			const rows = root.rows(120);
			expect(rows.join("\n")).toContain("1 match");
			expect(rows.join("\n")).toContain("test.ts");
			expect(cellGrid(rows, 120).length).toBeGreaterThan(0);
		} finally {
			root.dispose();
		}
	});

	it("keeps match-only compact groups within the historical row budget and restores context on expand", () => {
		const model = createToolCallModel<GrepRenderArgs, GrepToolDetails>({
			id: "call-grep-2",
			toolName: "grep",
			label: "Grep",
		});
		model.applyArgsChunk({ pattern: "needle" });
		const displayContent: string[] = [];
		for (let index = 0; index < 40; index++) {
			if (index > 0) displayContent.push("");
			displayContent.push(
				"# src/",
				`## file-${index}.ts`,
				` ${index * 2 + 1}│context-${index}`,
				`*${index * 2 + 2}│needle-${index}`,
			);
		}
		model.applyResult({
			content: [{ type: "text", text: "" }],
			details: { matchCount: 40, fileCount: 40, displayContent: displayContent.join("\n") },
		});
		const root = mountForTest(() => grepToolView.view(model), { width: 120 });
		try {
			const compact = root.text(120).join("\n");
			expect(compact).toContain("needle-0");
			expect(compact).not.toContain("context-0");
			expect(compact).toContain("more matches");

			model.setUi({ expanded: true });
			root.flush();
			const expanded = root.text(120).join("\n");
			expect(expanded).toContain("context-0");
		} finally {
			root.dispose();
		}
	});

	it("preserves standalone historical errors and distinguishes an aborted search from no matches", () => {
		const failed = createToolCallModel<GrepRenderArgs, GrepToolDetails>({
			id: "call-grep-3",
			toolName: "grep",
			label: "Grep",
		});
		failed.applyArgsChunk({ pattern: "needle" });
		failed.applyResult({ content: [{ type: "text", text: "Error: permission denied" }], isError: true });
		const failedRoot = mountForTest(() => grepToolView.view(failed), { width: 120 });
		try {
			const error = failedRoot.text(120).join("\n");
			expect(error).toContain("Error: permission denied");
			expect(error).not.toContain("Grep");
		} finally {
			failedRoot.dispose();
		}

		const cancelled = createToolCallModel<GrepRenderArgs, GrepToolDetails>({
			id: "call-grep-4",
			toolName: "grep",
			label: "Grep",
		});
		cancelled.applyArgsChunk({ pattern: "needle" });
		cancelled.applyResult({ content: [{ type: "text", text: "" }], status: "cancelled" });
		const cancelledRoot = mountForTest(() => grepToolView.view(cancelled), { width: 120 });
		try {
			const aborted = cancelledRoot.text(120).join("\n");
			expect(aborted).toContain("Grep: needle");
			expect(aborted).not.toContain("No matches found");
		} finally {
			cancelledRoot.dispose();
		}
	});

	it("keeps a successful result without details as an item tree while the empty fallback stays standalone", () => {
		const listed = createToolCallModel<GrepRenderArgs, GrepToolDetails>({
			id: "call-grep-5",
			toolName: "grep",
			label: "Grep",
		});
		listed.applyArgsChunk({ pattern: "needle" });
		listed.applyResult({ content: [{ type: "text", text: "first\nsecond" }] });
		const listedRoot = mountForTest(() => grepToolView.view(listed), { width: 120 });
		try {
			const result = listedRoot.text(120).join("\n");
			expect(result).toContain("2 items");
			expect(result).toContain("first");
			expect(result).toContain("second");
		} finally {
			listedRoot.dispose();
		}

		const empty = createToolCallModel<GrepRenderArgs, GrepToolDetails>({
			id: "call-grep-6",
			toolName: "grep",
			label: "Grep",
		});
		empty.applyResult({ content: [{ type: "text", text: "No matches found" }] });
		const emptyRoot = mountForTest(() => grepToolView.view(empty), { width: 120 });
		try {
			const result = emptyRoot.text(120).join("\n");
			expect(result).toContain("No matches found");
			expect(result).not.toContain("Grep");
		} finally {
			emptyRoot.dispose();
		}
	});
});
