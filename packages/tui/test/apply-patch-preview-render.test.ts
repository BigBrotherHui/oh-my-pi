import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createToolCallModel } from "../src/tools/model";
import { editToolView, type EditRenderArgs, type EditToolDetails, type EditToolPerFileResult } from "../src/tools/edit";
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

function mountApplyPatch(perFiles: EditToolPerFileResult[]): TestRoot {
	const model = createToolCallModel<EditRenderArgs, EditToolDetails>({
		id: "apply-patch-1",
		toolName: "apply_patch",
		label: "Apply Patch",
	});
	model.applyResult({
		content: [],
		details: {
			diff: "",
			perFileResults: perFiles,
		},
	});
	const root = mountForTest(() => editToolView.view(model), { width: 160, theme: uiTheme });
	roots.push(root);
	return root;
}

describe("apply_patch streaming preview renderer", () => {
	test("renders each file from structured per-file diff previews", () => {
		const root = mountApplyPatch([
			{ path: "src/a.ts", diff: "@@ -1,1 +1,1 @@\n-1|old a\n+1|new a", firstChangedLine: 1 },
			{ path: "src/b.ts", diff: "@@ -2,1 +2,1 @@\n-2|old b\n+2|new b", firstChangedLine: 2 },
		]);

		const rendered = root.text().join("\n");
		expect(rendered).toContain("src/a.ts");
		expect(rendered).toContain("new a");
		expect(rendered).toContain("src/b.ts");
		expect(rendered).toContain("new b");

		const grid = cellGrid(root.rows(), 160);
		expect(grid.length).toBeGreaterThanOrEqual(4);
	});

	test("renders a structured per-file preview error beside successful siblings", () => {
		const root = mountApplyPatch([
			{ path: "src/good.ts", diff: "@@ -1,1 +1,1 @@\n-1|old\n+1|new", firstChangedLine: 1 },
			{ path: "src/missing.ts", diff: "", isError: true, errorText: "File not found: src/missing.ts" },
		]);

		const rendered = root.text().join("\n");
		expect(rendered).toContain("src/good.ts");
		expect(rendered).toContain("new");
		expect(rendered).toContain("src/missing.ts");
		expect(rendered).toContain("File not found: src/missing.ts");

		const grid = cellGrid(root.rows(), 160);
		expect(grid.length).toBeGreaterThanOrEqual(2);
	});
});
