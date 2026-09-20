import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createToolCallModel, type ToolCallModel } from "../src/tools/model";
import { astEditToolView, type AstEditRenderArgs, type AstEditToolDetails } from "../src/tools/ast-edit";
import { mountForTest, type TestRoot } from "../src/testing";
import * as themeModule from "../src/theme/theme";
import { cellGrid } from "./cell-grid";

let uiTheme: themeModule.Theme;
const roots: TestRoot[] = [];

beforeAll(async () => {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const loaded = await themeModule.getThemeByName("dark");
	if (!loaded) throw new Error("dark test theme is unavailable");
	uiTheme = loaded;
});

afterEach(() => {
	for (const root of roots.splice(0)) root.dispose();
});

interface MountOptions {
	readonly isError?: boolean;
	readonly output?: string;
	readonly partial?: boolean;
	readonly status?: string;
}

function mountAstEdit(
	args: AstEditRenderArgs,
	details?: Partial<AstEditToolDetails>,
	options: MountOptions = {},
): {
	model: ToolCallModel<AstEditRenderArgs, AstEditToolDetails>;
	root: TestRoot;
} {
	const model = createToolCallModel<AstEditRenderArgs, AstEditToolDetails>({
		id: "ast-edit-1",
		toolName: "ast_edit",
		label: "AST Edit",
	});
	model.applyArgsChunk(args);
	if (details || options.isError || options.status) {
		model.applyResult(
			{
				content: options.output ? [{ type: "text", text: options.output }] : [],
				details: {
					totalReplacements: 0,
					filesTouched: 0,
					filesSearched: 0,
					applied: false,
					limitReached: false,
					...details,
				},
				isError: options.isError,
				status: options.status,
			},
			{ partial: options.partial },
		);
	}
	const root = mountForTest(() => astEditToolView.view(model), { width: 120, theme: uiTheme });
	roots.push(root);
	return { model, root };
}

describe("astEditToolView reactive rendering", () => {
	it("renders the pending call with a pattern description and target paths", () => {
		const { root } = mountAstEdit({
			ops: [{ pat: "console.log($$$A)", out: "logger.info($$$A)" }],
			paths: ["src/app.ts", "src/server.ts"],
		});

		const text = root.text().join("\n");
		expect(text).toContain("AST Edit");
		expect(text).toContain("console.log($$$A)");
		expect(text).toContain("in src/app.ts");

		const grid = cellGrid(root.rows(), 120);
		expect(grid.length).toBeGreaterThanOrEqual(1);
	});

	it("renders partial replacement output while the call is still running", () => {
		const { model, root } = mountAstEdit(
			{ ops: [{ pat: "console.log($$$A)", out: "logger.info($$$A)" }] },
			{
				totalReplacements: 1,
				filesTouched: 1,
				filesSearched: 5,
				displayContent: "# src/app.ts\n-1│console.log(1)\n+1│logger.info(1)",
			},
			{ partial: true },
		);

		expect(model.phase).toBe("running");
		const text = root.text().join("\n");
		expect(text).toContain("proposed");
		expect(text).toContain("console.log(1)");
		expect(text).toContain("logger.info(1)");
	});

	it("renders proposed replacements with grouped diff lines", () => {
		const displayContent = "# src/app.ts\n-console.log(1)\n+logger.info(1)";
		const { root } = mountAstEdit(
			{
				ops: [{ pat: "console.log($$$A)", out: "logger.info($$$A)" }],
			},
			{
				totalReplacements: 1,
				filesTouched: 1,
				filesSearched: 5,
				applied: false,
				displayContent,
			},
		);

		const text = root.text().join("\n");
		expect(text).toContain("AST Edit");
		expect(text).toContain("proposed");
		expect(text).toContain("1 replacement");
		expect(text).toContain("1 file");
		expect(text).toContain("console.log(1)");
		expect(text).toContain("logger.info(1)");

		const grid = cellGrid(root.rows(), 120);
		expect(grid.length).toBeGreaterThanOrEqual(4);
	});

	it("keeps an applied edit distinct from a staged proposal", () => {
		const { root } = mountAstEdit(
			{ ops: [{ pat: "foo", out: "bar" }] },
			{
				totalReplacements: 1,
				filesTouched: 1,
				filesSearched: 1,
				applied: true,
				displayContent: "-1│foo\n+1│bar",
			},
		);

		expect(root.text().join("\n")).not.toContain("proposed");
	});

	it("keeps the first complete change group and expands the remaining groups", () => {
		const { model, root } = mountAstEdit(
			{ ops: [{ pat: "foo", out: "bar" }] },
			{
				totalReplacements: 2,
				filesTouched: 2,
				filesSearched: 2,
				displayContent: ["# one.ts", "-1│foo", "+1│bar", "", "# two.ts", "-1│baz", "+1│qux"].join("\n"),
			},
		);

		expect(root.text().join("\n")).toContain("… 1 more change");
		expect(root.text().join("\n")).not.toContain("two.ts");

		model.setUi({ expanded: true });
		expect(root.text().join("\n")).toContain("two.ts");
		expect(root.text().join("\n")).not.toContain("… 1 more change");
	});

	it("renders bounded parse-error bullets when no replacement was found", () => {
		const { root } = mountAstEdit(
			{ ops: [{ pat: "foo", out: "bar" }] },
			{
				totalReplacements: 0,
				filesTouched: 0,
				filesSearched: 2,
				parseErrors: ["Syntax error in src/broken.ts:4"],
			},
		);

		const text = root.text().join("\n");
		expect(text).toContain("0 replacements");
		expect(text).toContain("- Syntax error in src/broken.ts:4");
		expect(text).not.toContain("Parse issues:");
	});

	it("renders error details below the error header", () => {
		const { root } = mountAstEdit(
			{ ops: [{ pat: "bad" }] },
			{},
			{ isError: true, output: "Error: AST pattern parse error" },
		);

		const text = root.text().join("\n");
		expect(text).toContain("AST Edit");
		expect(text).toContain("AST pattern parse error");
		expect(text).not.toContain("Error: AST pattern parse error");
	});

	it("preserves cancellation output with the aborted lifecycle state", () => {
		const { root } = mountAstEdit(
			{ ops: [{ pat: "foo", out: "bar" }] },
			{},
			{ status: "cancelled", output: "Cancelled while awaiting edits" },
		);

		expect(root.text().join("\n")).toContain("Cancelled while awaiting edits");
	});
});
