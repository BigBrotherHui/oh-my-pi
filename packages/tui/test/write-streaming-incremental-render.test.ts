import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createToolCallModel, type ToolCallModel } from "../src/tools/model";
import { writeToolView, type WriteRenderArgs, type WriteToolDetails } from "../src/tools/write";
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

function mountWriteStream(): {
	model: ToolCallModel<WriteRenderArgs, WriteToolDetails>;
	root: TestRoot;
} {
	const model = createToolCallModel<WriteRenderArgs, WriteToolDetails>({
		id: "write-stream-1",
		toolName: "write",
		label: "Write",
	});
	model.applyArgsChunk({ path: "/tmp/stream.ts", content: "" });
	model.markRunning();
	const root = mountForTest(() => writeToolView.view(model), { width: 120, theme: uiTheme });
	roots.push(root);
	return { model, root };
}

describe("write streaming preview incremental line tracking", () => {
	it("uses an authoritative revised path instead of a stale streamed alias", () => {
		const { model, root } = mountWriteStream();
		model.applyArgsChunk({ file_path: "/tmp/stale-alias.ts" });
		expect(root.text().join("\n")).toContain("stale-alias.ts");

		model.applyArgsChunk({ path: "/tmp/revised.ts", content: "revised payload" }, { snapshot: true });
		const rendered = root.text().join("\n");
		expect(rendered).toContain("revised.ts");
		expect(rendered).toContain("revised payload");
		expect(rendered).not.toContain("stale-alias.ts");
	});

	it("tracks an append-only stream incrementally with documentFromSnapshots", () => {
		const { model, root } = mountWriteStream();

		// Stream content in chunks
		let accumulated = "";
		for (let i = 1; i <= 20; i++) {
			accumulated += (i === 1 ? "" : "\n") + `line ${i}`;
			model.applyArgsChunk({ content: accumulated });
			root.flush();
		}

		const rendered = root.text().join("\n");
		expect(rendered).toContain("line 20");
		expect(rendered).toContain("line 19");
		// 20 lines with 12 limit -> tail preview shows earlier lines/rows summary
		expect(rendered).toContain("earlier");

		const grid = cellGrid(root.rows(), 120);
		expect(grid.length).toBeGreaterThanOrEqual(10);
	});

	it("preserves retained DOM nodes across chunk updates (granularity test)", () => {
		const { model, root } = mountWriteStream();

		model.applyArgsChunk({ content: "const a = 1;\nconst b = 2;\n" });
		root.flush();

		const initialCounters = root.counters();
		const initialNodes = initialCounters.nodesCreated;
		expect(initialNodes).toBeGreaterThan(0);

		// Append more content to the stream
		model.applyArgsChunk({ content: "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n" });
		root.flush();

		const updatedCounters = root.counters();
		// Adding content to the document does NOT re-create the DOM node tree
		expect(updatedCounters.nodesCreated).toBe(initialNodes);

		const rendered = root.text().join("\n");
		expect(rendered).toContain("const d = 4;");
	});

	it("normalizes CRLF without leaking carriage returns into rows", () => {
		const { model, root } = mountWriteStream();

		model.applyArgsChunk({ content: "first\r\nsecond\r\nthird\r\n" });
		root.flush();

		const rows = root.rows();
		for (const row of rows) {
			expect(row).not.toContain("\r");
		}
		expect(root.text().join("\n")).toContain("first");
		expect(root.text().join("\n")).toContain("second");
	});

	it("toggles between tail preview when collapsed and full document when expanded", () => {
		const { model, root } = mountWriteStream();

		const allLines = Array.from({ length: 30 }, (_, i) => `item_${i + 1}`).join("\n");
		model.applyArgsChunk({ content: allLines });
		root.flush();

		// Collapsed shows tail lines and earlier lines summary
		let text = root.text().join("\n");
		expect(text).toContain("item_30");
		expect(text).toContain("earlier");

		// Expand view
		model.setUi({ expanded: true });
		root.flush();

		// Expanded shows all lines from line 1
		text = root.text().join("\n");
		expect(text).toContain("item_1");
		expect(text).toContain("item_30");
	});
});
