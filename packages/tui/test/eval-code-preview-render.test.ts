import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-tui/theme";
import { evalToolView, type EvalRenderArgs, type EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import { previewWindowRows } from "@oh-my-pi/pi-tui/render/render-utils";
import { createToolCallModel } from "@oh-my-pi/pi-tui/tools/model";
import { mountForTest, type TestRoot } from "../src/testing";
import { cellGrid } from "./cell-grid";

/** Defends the bounded tail-window contract for document-backed eval cells. */
describe("evalToolView: viewport tail window for cell code", () => {
	let theme: Theme;
	const roots: TestRoot[] = [];
	const total = previewWindowRows() + 5;
	const code = Array.from({ length: total }, (_, index) => `value_${index} = ${index}`).join("\n");
	const firstLine = "value_0 = 0";
	const lastLine = `value_${total - 1} = ${total - 1}`;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("Expected dark theme");
		theme = loaded;
	});

	afterEach(() => {
		for (const root of roots.splice(0)) root.dispose();
	});

	function mountResult(expanded: boolean): TestRoot {
		const model = createToolCallModel<EvalRenderArgs, EvalToolDetails>({
			id: "eval-preview-result",
			toolName: "eval",
			label: "eval",
		});
		model.applyResult({
			content: [{ type: "text", text: "" }],
			details: {
				language: "python",
				languages: ["python"],
				cells: [{ index: 0, code, language: "python", output: "", status: "complete", statusEvents: [] }],
			},
		});
		model.setUi({ expanded });
		const root = mountForTest(() => evalToolView.view(model), { width: 120, theme });
		roots.push(root);
		return root;
	}

	it("caps collapsed result code to a tail window with an earlier-lines marker", () => {
		const root = mountResult(false);
		const rendered = root.text().join("\n");
		expect(rendered).toContain(lastLine);
		expect(rendered).toContain("earlier line");
		expect(rendered).not.toContain(firstLine);
		const grid = cellGrid(root.rows(), 120);
		expect(grid.some(row => row.some(cell => cell.ch === "…"))).toBe(true);
	});

	it("shows the full source when expanded", () => {
		const rendered = mountResult(true).text().join("\n");
		expect(rendered).toContain(firstLine);
		expect(rendered).toContain(lastLine);
		expect(rendered).not.toContain("earlier line");
	});

	it("bounds the pending preview to the same live tail window", () => {
		const model = createToolCallModel<EvalRenderArgs, EvalToolDetails>({
			id: "eval-preview-pending",
			toolName: "eval",
			label: "eval",
		});
		model.applyArgsChunk({ language: "py", code });
		model.markRunning();
		const root = mountForTest(() => evalToolView.view(model), { width: 120, theme });
		roots.push(root);

		const rendered = root.text().join("\n");
		expect(rendered).toContain(lastLine);
		expect(rendered).toContain("earlier line");
		expect(rendered).not.toContain(firstLine);
	});

	it("renders nested partial eval cells and replaces them on a new raw snapshot", () => {
		const model = createToolCallModel<EvalRenderArgs, EvalToolDetails>({
			id: "eval-streamed-cells",
			toolName: "eval",
			label: "eval",
		});
		model.applyArgsChunk('{"cells":[{"language":"js","meta":{"source":"tool"},"code":"const value = \\"partial');
		model.markRunning();
		const root = mountForTest(() => evalToolView.view(model), { width: 120, theme });
		roots.push(root);

		expect(root.text().join("\n")).toContain('const value = "partial');
		model.applyArgsChunk('{"language":"python","code":"print(1)"}');
		root.flush();
		const rendered = root.text().join("\n");
		expect(rendered).toContain("print(1)");
		expect(rendered).not.toContain("const value");
	});

	it("keeps the live terminal output tail and applies carriage-return overwrites", () => {
		const output = [
			"first line",
			...Array.from({ length: 7 }, (_, index) => `output ${index}`),
			"stale progress\rlive progress",
			...Array.from({ length: 5 }, (_, index) => `output ${index + 7}`),
		].join("\n");
		const model = createToolCallModel<EvalRenderArgs, EvalToolDetails>({
			id: "eval-output-tail",
			toolName: "eval",
			label: "eval",
		});
		model.applyResult(
			{
				content: [{ type: "text", text: output }],
				details: {
					cells: [{ index: 0, code: "log('stream')", language: "js", output, status: "running" }],
				},
			},
			{ partial: true },
		);
		const root = mountForTest(() => evalToolView.view(model), { width: 120, height: 24, theme });
		roots.push(root);

		const rendered = root.text().join("\n");
		expect(rendered).toContain("live progress");
		expect(rendered).toContain("output 11");
		expect(rendered).toContain("more lines (ctrl+o to expand)");
		expect(rendered).not.toContain("stale progress");
		expect(rendered).not.toContain("first line");
	});

	it("keeps a mounted cell live across output, status, and expansion updates", () => {
		const liveCode = Array.from({ length: total }, (_, index) => `live_${index} = ${index}`).join("\n");
		const model = createToolCallModel<EvalRenderArgs, EvalToolDetails>({
			id: "eval-live-cell",
			toolName: "eval",
			label: "eval",
		});
		model.applyResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					cells: [
						{ index: 0, code: liveCode, language: "python", output: "", status: "running", statusEvents: [] },
					],
				},
			},
			{ partial: true },
		);
		model.setUi({ expanded: false, allocation: 12 });
		const root = mountForTest(() => evalToolView.view(model), { width: 120, theme });
		roots.push(root);
		expect(root.text().join("\n")).toContain("running");
		expect(root.text().join("\n")).not.toContain("live_0 = 0");

		model.applyResult({
			content: [{ type: "text", text: "cell completed" }],
			details: {
				cells: [
					{
						index: 0,
						code: liveCode,
						language: "python",
						output: "cell completed",
						status: "complete",
						statusEvents: [{ op: "read", path: "result.txt", chars: 14 }],
					},
				],
			},
		});
		model.setUi({ expanded: true });
		root.flush();
		const rendered = root.text().join("\n");
		expect(rendered).toContain("cell completed");
		expect(rendered).toContain("read");
		expect(rendered).toContain("live_0 = 0");
		expect(rendered).not.toContain("running");
	});

	it("marks an unfinished cell aborted when the call is cancelled", () => {
		const model = createToolCallModel<EvalRenderArgs, EvalToolDetails>({
			id: "eval-cancelled",
			toolName: "eval",
			label: "eval",
		});
		model.applyResult({
			status: "cancelled",
			content: [{ type: "text", text: "" }],
			details: {
				cells: [{ index: 0, code: "await wait()", language: "js", output: "", status: "running" }],
			},
		});
		const root = mountForTest(() => evalToolView.view(model), { width: 120, theme });
		roots.push(root);

		expect(root.text().join("\n")).toContain("aborted");
	});
});
