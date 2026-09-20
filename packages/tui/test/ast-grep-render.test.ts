import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { astGrepToolView, type AstGrepRenderArgs, type AstGrepToolDetails } from "@oh-my-pi/pi-tui/tools/ast-grep";
import { cellGrid } from "./cell-grid";
import { createToolCallModel } from "../src/tools/model";

describe("astGrepToolView reactive mount", () => {
	it("keeps the call header live before rendering its settled matches", () => {
		const model = createToolCallModel<AstGrepRenderArgs, AstGrepToolDetails>({
			id: "call-1",
			toolName: "ast_grep",
			label: "AST Grep",
		});

		model.applyArgsChunk({ pat: "console.log($_)", path: "src" });
		model.markRunning();

		const root = mountForTest(() => astGrepToolView.view(model), { width: 120 });
		const runningText = root.text(120).join("\n");
		expect(runningText).toContain("AST Grep");
		expect(runningText).toContain("console.log($_)");
		expect(runningText).toContain("in src");

		model.applyResult({
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 2,
				fileCount: 1,
				filesSearched: 10,
				limitReached: false,
				displayContent: ["# src/", "## index.ts", "*1│console.log(a);", "*2│console.log(b);"].join("\n"),
			},
		});

		root.flush();
		const settledRows = root.rows(120);
		const grid = cellGrid(settledRows, 120);
		expect(grid.length).toBeGreaterThan(0);

		const settledText = root.text(120).join("\n");
		expect(settledText).toContain("2 matches");
		expect(settledText).toContain("1 file");
		expect(settledText).toContain("searched 10");
		expect(settledText).toContain("console.log(a);");

		root.dispose();
	});

	it("renders partial results while the search is still running", () => {
		const model = createToolCallModel<AstGrepRenderArgs, AstGrepToolDetails>({
			id: "call-partial",
			toolName: "ast_grep",
			label: "AST Grep",
		});

		model.applyArgsChunk({ pat: "needle" });
		model.applyResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					matchCount: 1,
					fileCount: 1,
					filesSearched: 3,
					limitReached: false,
					displayContent: "# src/\n## app.ts\n*4│needle();",
				},
			},
			{ partial: true },
		);

		const root = mountForTest(() => astGrepToolView.view(model), { width: 120 });
		expect(model.phase).toBe("running");
		const text = root.text(120).join("\n");
		expect(text).toContain("1 match");
		expect(text).toContain("needle();");

		root.dispose();
	});

	it("renders parse-error bullets when no match was found", () => {
		const model = createToolCallModel<AstGrepRenderArgs, AstGrepToolDetails>({
			id: "call-2",
			toolName: "ast_grep",
			label: "AST Grep",
		});

		model.applyArgsChunk({ pat: "bad syntax" });
		model.applyResult({
			content: [{ type: "text", text: "No matches found" }],
			details: {
				matchCount: 0,
				fileCount: 0,
				filesSearched: 2,
				limitReached: false,
				parseErrors: ["Syntax error in pattern", "Invalid node type"],
				parseErrorsTotal: 2,
			},
		});

		const root = mountForTest(() => astGrepToolView.view(model), { width: 120 });
		const text = root.text(120).join("\n");
		expect(text).toContain("No matches found");
		expect(text).toContain("Query may be mis-scoped");
		expect(text).toContain("- Syntax error in pattern");
		expect(text).toContain("- Invalid node type");
		expect(text).not.toContain("Parse issues:");

		root.dispose();
	});

	it("keeps complete match groups within the collapsed row budget", () => {
		const model = createToolCallModel<AstGrepRenderArgs, AstGrepToolDetails>({
			id: "call-3",
			toolName: "ast_grep",
			label: "AST Grep",
		});

		model.applyArgsChunk({ pat: "needle" });
		model.setUi({ expanded: false, allocation: 20, showImages: false });
		model.applyResult({
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 4,
				fileCount: 4,
				filesSearched: 20,
				limitReached: false,
				displayContent: [
					"# src/",
					"## a.ts",
					"*1│needle();",
					"",
					"## b.ts",
					"*2│needle();",
					"",
					"## c.ts",
					"*3│needle();",
					"",
					"## d.ts",
					"*4│needle();",
				].join("\n"),
			},
		});

		const root = mountForTest(() => astGrepToolView.view(model), { width: 120 });
		let text = root.text(120).join("\n");
		expect(text).toContain("… 2 more matches");
		expect(text).toContain("b.ts");
		expect(text).not.toContain("c.ts");

		model.setUi({ expanded: true });
		text = root.text(120).join("\n");
		expect(text).toContain("c.ts");
		expect(text).not.toContain("… 2 more matches");

		root.dispose();
	});

	it("keeps the result-limit and parse-issue warnings beside matched output", () => {
		const model = createToolCallModel<AstGrepRenderArgs, AstGrepToolDetails>({
			id: "call-limited",
			toolName: "ast_grep",
			label: "AST Grep",
		});
		const parseErrors = Array.from({ length: 20 }, (_, index) => `Parse error ${index + 1}`);

		model.applyResult({
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 1,
				fileCount: 1,
				filesSearched: 20,
				limitReached: true,
				parseErrors,
				parseErrorsTotal: 21,
				displayContent: "# app.ts\n*1│needle();",
			},
		});

		const root = mountForTest(() => astGrepToolView.view(model), { width: 120 });
		const text = root.text(120).join("\n");
		expect(text).toContain("limit reached; narrow path or increase limit");
		expect(text).toContain("20 / 21 parse issues");
		root.dispose();
	});

	it("keeps failure and cancellation output distinct", () => {
		const failed = createToolCallModel<AstGrepRenderArgs, AstGrepToolDetails>({
			id: "call-failed",
			toolName: "ast_grep",
			label: "AST Grep",
		});
		failed.applyResult({
			content: [{ type: "text", text: "Error: AST pattern parse error" }],
			isError: true,
		});
		const failedRoot = mountForTest(() => astGrepToolView.view(failed), { width: 120 });
		expect(failedRoot.text(120).join("\n")).toContain("Error: AST pattern parse error");
		failedRoot.dispose();

		const cancelled = createToolCallModel<AstGrepRenderArgs, AstGrepToolDetails>({
			id: "call-cancelled",
			toolName: "ast_grep",
			label: "AST Grep",
		});
		cancelled.applyResult({
			content: [{ type: "text", text: "Cancelled while searching" }],
			status: "cancelled",
		});
		const cancelledRoot = mountForTest(() => astGrepToolView.view(cancelled), { width: 120 });
		const cancelledText = cancelledRoot.text(120).join("\n");
		expect(cancelledText).toContain("AST Grep");
		expect(cancelledText).toContain("Cancelled while searching");
		cancelledRoot.dispose();
	});
});
