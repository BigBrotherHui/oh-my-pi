import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createToolCallModel, type ToolCallModel } from "../src/tools/model";
import { editToolView, type EditRenderArgs, type EditToolDetails } from "../src/tools/edit";
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

function mountEdit(
	args: EditRenderArgs,
	details?: Partial<EditToolDetails>,
	isError = false,
): {
	model: ToolCallModel<EditRenderArgs, EditToolDetails>;
	root: TestRoot;
} {
	const model = createToolCallModel<EditRenderArgs, EditToolDetails>({
		id: "edit-test-1",
		toolName: "edit",
		label: "Edit",
	});
	model.applyArgsChunk(args);
	if (details || isError) {
		model.applyResult({
			content: isError ? [{ type: "text", text: "Patch conflict at line 42" }] : [],
			details: {
				diff: "",
				...details,
			},
			isError,
		});
	}
	const root = mountForTest(() => editToolView.view(model), { width: 120, theme: uiTheme });
	roots.push(root);
	return { model, root };
}

describe("editToolView reactive rendering", () => {
	it("keeps standalone additions green and removals red through preview and completion", () => {
		const diff = "+1|\tlet added_value = 42;\n 2|keep();\n-3|\tlet removed_value = 7;";
		const { model, root } = mountEdit({ path: "src/example.rs", previewDiff: diff });
		const expectColors = (): void => {
			const text = root.text();
			const cells = cellGrid(root.rows(), 120);
			for (const [word, color] of [
				["added_value", "toolDiffAdded"],
				["removed_value", "toolDiffRemoved"],
			] satisfies readonly (readonly [string, themeModule.ThemeColor])[]) {
				const row = text.findIndex(line => line.includes(word));
				expect(row).toBeGreaterThanOrEqual(0);
				const column = Bun.stringWidth(text[row]!.slice(0, text[row]!.indexOf(word)));
				const expected = cellGrid([uiTheme.fg(color, "x")], 1)[0]![0]!.fg;
				expect(cells[row]![column]!.fg).toEqual(expected);
			}
		};
		expectColors();
		model.applyResult({ content: [], details: { path: "src/example.rs", diff } });
		expectColors();
	});

	it("renders a single-file edit with compact bracketed diff stats", () => {
		const diff = "@@ -1,3 +1,3 @@\n-const oldVal = 1;\n+const newVal = 2;\n const keep = true;";
		const { root } = mountEdit(
			{ path: "src/config.ts" },
			{
				path: "src/config.ts",
				diff,
			},
		);

		const text = root.text().join("\n");
		expect(text).toContain("Edit");
		expect(text).toContain("src/config.ts");
		expect(text).toContain(`${uiTheme.format.bracketLeft}+1/-1${uiTheme.format.bracketRight}`);
		expect(text).toContain("newVal");
	});

	it("renders file rename/move with sourcePath → destPath", () => {
		const diff = "@@ -1,1 +1,1 @@\n-old\n+new";
		const { root } = mountEdit(
			{ path: "src/renamed.ts" },
			{
				path: "src/renamed.ts",
				sourcePath: "src/original.ts",
				diff,
			},
		);

		const text = root.text().join("\n");
		expect(text).toContain("src/original.ts");
		expect(text).toContain("src/renamed.ts");
		expect(text).toContain("→");
	});

	it("keeps the requested relative path when the result has a resolved link target", () => {
		const { root } = mountEdit(
			{ path: "src/requested.ts" },
			{
				path: "/workspace/src/requested.ts",
				firstChangedLine: 8,
				diff: "@@ -8,1 +8,1 @@\n-old\n+new",
			},
		);

		const title = root.text()[0] ?? "";
		expect(title).toContain("src/requested.ts");
		expect(title).not.toContain("/workspace/src/requested.ts");
	});

	it("reserves compact bracketed stats beside a middle-truncated long path", () => {
		const model = createToolCallModel<EditRenderArgs, EditToolDetails>({
			id: "edit-long-title-1",
			toolName: "edit",
			label: "Edit",
		});
		model.applyArgsChunk({ path: "/very/long/project/packages/coding-agent/src/tools/deeply/nested/demo-file.ts" });
		model.applyResult({
			content: [],
			details: {
				path: "/very/long/project/packages/coding-agent/src/tools/deeply/nested/demo-file.ts",
				diff: "@@ -1,2 +1,2 @@\n-old\n+new",
			},
		});

		const root = mountForTest(() => editToolView.view(model), { width: 42, theme: uiTheme });
		roots.push(root);

		const title = root.text()[0] ?? "";
		expect(title).toContain(`${uiTheme.format.bracketLeft}+1/-1${uiTheme.format.bracketRight}`);
		expect((title.match(/…/gu) ?? []).length).toBeLessThanOrEqual(1);
	});

	it("renders multi-file results with per-file cards", () => {
		const { root } = mountEdit(
			{},
			{
				perFileResults: [
					{
						path: "src/first.ts",
						diff: "@@ -1,1 +1,1 @@\n-first old\n+first new",
						firstChangedLine: 1,
					},
					{
						path: "src/second.ts",
						diff: "@@ -1,1 +1,1 @@\n-second old\n+second new",
						firstChangedLine: 1,
					},
				],
			},
		);

		const text = root.text().join("\n");
		expect(text).toContain("src/first.ts");
		expect(text).toContain("first new");
		expect(text).toContain("src/second.ts");
		expect(text).toContain("second new");
	});

	it("renders error state when outcome is failed", () => {
		const { root } = mountEdit({ path: "src/broken.ts" }, {}, true);

		const text = root.text().join("\n");
		expect(text).toContain("Edit");
		expect(text).toContain("src/broken.ts");
		expect(text).toContain("Patch conflict at line 42");
	});

	it("preserves DOM nodes on subsequent property updates (granularity test)", () => {
		const model = createToolCallModel<EditRenderArgs, EditToolDetails>({
			id: "edit-gran-1",
			toolName: "edit",
			label: "Edit",
		});
		model.applyArgsChunk({ path: "src/live.ts", diff: "@@ -1,1 +1,1 @@\n-a\n+b" });
		model.markRunning();

		const root = mountForTest(() => editToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		model.applyResult({
			content: [],
			details: {
				path: "src/live.ts",
				diff: "@@ -1,1 +1,1 @@\n-a\n+b",
			},
		});
		root.flush();

		const before = root.counters();
		expect(before.nodesCreated).toBeGreaterThan(0);

		// Updating allocation/ui state does NOT recreate nodes
		model.setUi({ allocation: 120 });
		root.flush();

		const after = root.counters();
		expect(after.nodesCreated).toBe(before.nodesCreated);
	});

	it("renders a tail-bounded streaming preview while the edit runs", () => {
		const model = createToolCallModel<EditRenderArgs, EditToolDetails>({
			id: "edit-streaming-1",
			toolName: "edit",
			label: "Edit",
		});
		const previewDiff = Array.from({ length: 16 }, (_, index) => `+const value${index + 1} = ${index + 1};`).join(
			"\n",
		);
		model.applyArgsChunk({
			path: "src/live.ts",
			previewDiff,
		});
		model.markRunning();

		const root = mountForTest(() => editToolView.view(model), { width: 80, theme: uiTheme });
		roots.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("src/live.ts");
		expect(text).toContain("value16");
		expect(text).not.toContain("value1 = 1");
		expect(text).toContain("content above");
		expect(text).toContain("(preview)");
	});

	it("uses typed edit preview state and the raw argument prefix before JSON closes", () => {
		const model = createToolCallModel<EditRenderArgs, EditToolDetails>({
			id: "edit-raw-prefix-1",
			toolName: "edit",
			label: "Edit",
		});
		model.applyArgsChunk('{"path":"src/partial.ts');
		model.setUi({
			edit: {
				editMode: "hashline",
				editDiffPreview: { diff: "@@ -1,1 +1,1 @@\n-old\n+new" },
			},
		});
		model.markRunning();

		const root = mountForTest(() => editToolView.view(model), { width: 80, theme: uiTheme });
		roots.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("src/partial.ts");
		expect(text).toContain("old");
		expect(text).toContain("new");
	});

	it("does not retain a path from a malformed raw argument snapshot", () => {
		const model = createToolCallModel<EditRenderArgs, EditToolDetails>({
			id: "edit-invalid-raw-1",
			toolName: "edit",
			label: "Edit",
		});
		model.applyArgsChunk('{"path":"src/stale.ts"} trailing');
		model.markRunning();

		const root = mountForTest(() => editToolView.view(model), { width: 80, theme: uiTheme });
		roots.push(root);
		expect(root.text().join("\n")).not.toContain("src/stale.ts");
	});

	it("renders payload-less deletes as an inline completed action", () => {
		const { root } = mountEdit(
			{ path: "scripts/obsolete.ts", op: "delete" },
			{ path: "scripts/obsolete.ts", op: "delete", diff: "" },
		);

		const text = root.text().join("\n");
		expect(text).toContain("Delete");
		expect(text).toContain("scripts/obsolete.ts");
		expect(text).not.toContain("No changes were made");
	});

	it("renders payload-less moves as an inline action with both paths", () => {
		const { root } = mountEdit(
			{ path: "src/old-name.ts", rename: "src/new-name.ts" },
			{
				path: "src/new-name.ts",
				sourcePath: "src/old-name.ts",
				move: "src/new-name.ts",
				diff: "",
			},
		);

		const text = root.text().join("\n");
		expect(text).toContain("Move");
		expect(text).toContain("src/old-name.ts");
		expect(text).toContain("src/new-name.ts");
		expect(text).toContain("→");
	});

	it("shows a per-file display error in preference to transport output", () => {
		const { root } = mountEdit(
			{},
			{
				perFileResults: [
					{
						path: "src/conflict.ts",
						diff: "",
						isError: true,
						displayErrorText: "Expected the original line near line 17.",
					},
					{ path: "src/unchanged.ts", diff: "" },
				],
			},
			true,
		);

		const text = root.text().join("\n");
		expect(text).toContain("Expected the original line near line 17.");
		expect(text).not.toContain("Patch conflict at line 42");
	});

	it("renders an explicit cancelled lifecycle outcome", () => {
		const model = createToolCallModel<EditRenderArgs, EditToolDetails>({
			id: "edit-cancelled-1",
			toolName: "edit",
			label: "Edit",
		});
		model.applyArgsChunk({ path: "src/interrupted.ts" });
		model.applyResult({
			content: [],
			details: { path: "src/interrupted.ts", diff: "" },
			status: "cancelled",
		});

		const root = mountForTest(() => editToolView.view(model), { width: 80, theme: uiTheme });
		roots.push(root);

		expect(root.text().join("\n")).toContain("Edit cancelled.");
	});
});
