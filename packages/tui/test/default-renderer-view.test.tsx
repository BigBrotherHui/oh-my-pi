import { afterEach, describe, expect, it } from "bun:test";
import { mountForTest, type TestRoot } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import { defaultToolView, toolStatus } from "../src/tools/default-renderer";
import { resolveToolView, toolViews } from "../src/tools/registry";
import { loadThemeSync } from "../src/theme/loader";

const mounted: TestRoot[] = [];
afterEach(() => {
	for (const root of mounted.splice(0)) root.dispose();
});

describe("defaultToolView", () => {
	it("is registered as the default view in toolViews", () => {
		expect(toolViews.get("default")).toBe(defaultToolView);
		expect(resolveToolView("unregistered_tool").definition).toBe(defaultToolView);
	});

	it("maps active, queued, terminal error, and benign abort states to historical status glyphs", () => {
		expect(toolStatus("receiving")).toBe("running");
		expect(toolStatus("queued")).toBe("pending");
		expect(toolStatus("running")).toBe("running");
		expect(toolStatus("settled", "success")).toBe("done");
		expect(toolStatus("settled", "failed")).toBe("error");
		expect(toolStatus("settled", "timed_out")).toBe("error");
		expect(toolStatus("settled", "cancelled")).toBe("info");
		expect(toolStatus("settled", "skipped")).toBe("info");
	});

	it("keeps four logical streaming output rows before the expand affordance", () => {
		const model = createToolCallModel({
			id: "call-output-budget",
			toolName: "custom_stream",
			label: "Streaming Tool",
		});
		model.markRunning();
		model.applyResult({ content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix\n" }] }, { partial: true });
		model.setUi({ expanded: false, allocation: 80, showImages: false });

		const root = mountForTest(() => defaultToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("one");
		expect(text).toContain("four");
		expect(text).not.toContain("five");
		expect(text).toContain("… 2 more lines");
		expect(text).toContain("Expand");
	});

	it("keeps twelve logical expanded output rows before the omitted-line notice", () => {
		const model = createToolCallModel({
			id: "call-expanded-output-budget",
			toolName: "custom_stream",
			label: "Streaming Tool",
		});
		model.applyResult(
			{
				content: [
					{
						type: "text",
						text: Array.from({ length: 13 }, (_, index) => `line ${index + 1}`).join("\n"),
					},
				],
			},
			{ partial: false },
		);
		model.setUi({ expanded: true, allocation: 80, showImages: false });

		const root = mountForTest(() => defaultToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("line 12");
		expect(text).not.toContain("line 13");
		expect(text).toContain("… 1 more line");
	});

	it("keeps normalized recovery notices visible while collapsed", () => {
		const model = createToolCallModel({
			id: "call-collapsed-recovery",
			toolName: "custom_recovery",
			label: "Recovery",
		});
		model.applyResult({
			content: [{ type: "text", text: "saved\n[raw output: artifact://42]" }],
		});
		model.setUi({ expanded: false, allocation: 80, showImages: false });
		const root = mountForTest(() => defaultToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);
		const text = root.text().join("\n");
		expect(text).toContain("saved");
		expect(text).toContain("Raw output: artifact://42");
		expect(text).not.toContain("[raw output: artifact://42]");
	});

	it("shows the historical empty-result placeholder once a call settles", () => {
		const model = createToolCallModel({
			id: "call-empty-result",
			toolName: "custom_empty",
			label: "Empty Tool",
		});
		model.applyResult({ content: [] }, { partial: false });
		model.setUi({ expanded: true, allocation: 80, showImages: false });

		const root = mountForTest(() => defaultToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		expect(root.text().join("\n")).toContain("(no output)");
	});

	it("adds the historical ellipsis after an expanded JSON tree hits its row budget", () => {
		const model = createToolCallModel({
			id: "call-json-budget",
			toolName: "custom_json",
			label: "JSON Tool",
		});
		model.applyResult(
			{
				content: [
					{
						type: "text",
						text: JSON.stringify(
							Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`key${index}`, index])),
						),
					},
				],
			},
			{ partial: false },
		);
		model.setUi({ expanded: true, allocation: 240, showImages: false });

		const root = mountForTest(() => defaultToolView.view(model), {
			width: 240,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("key199");
		expect(text).toContain("…");
	});

	it("renders collapsed view with label, status, and inline args preview", () => {
		const model = createToolCallModel({
			id: "call-1",
			toolName: "custom_calc",
			label: "Calculator",
		});
		model.applyArgsChunk({ expression: "2 + 2", precision: 4 });
		model.markRunning();
		model.setUi({ expanded: false, allocation: 80, showImages: false });

		const root = mountForTest(() => defaultToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("Calculator");
		expect(text).toContain("expression=");
		expect(text).toContain("2 + 2");
	});

	it("renders expanded view with args section and JSON tree result", () => {
		const model = createToolCallModel({
			id: "call-2",
			toolName: "custom_query",
			label: "Query Service",
		});
		model.applyArgsChunk({ query: "SELECT 1" });
		model.markRunning();
		model.applyResult(
			{
				content: [{ type: "text", text: JSON.stringify({ rows: [1], count: 1 }) }],
				isError: false,
			},
			{ partial: false },
		);
		model.setUi({ expanded: true, allocation: 80, showImages: false });

		const root = mountForTest(() => defaultToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("Query Service");
		expect(text).toContain("Args");
		expect(text).toContain("SELECT 1");
		expect(text).toContain("count: 1");
	});

	it("updates reactively on result arrival and phase transition", () => {
		const model = createToolCallModel({
			id: "call-3",
			toolName: "data_fetch",
			label: "Data Fetch",
		});
		model.applyArgsChunk({ url: "https://api.example.com" });
		model.markRunning();
		model.setUi({ expanded: false, allocation: 80, showImages: false });

		const root = mountForTest(() => defaultToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		const initialCounters = { ...root.counters() };
		expect(root.text().join("\n")).not.toContain("result data");

		model.applyResult({ content: [{ type: "text", text: "result data arrived" }] }, { partial: false });
		root.flush();

		const updatedText = root.text().join("\n");
		expect(updatedText).toContain("result data arrived");

		// Granularity: bindings update reactively
		const updatedCounters = root.counters();
		expect(updatedCounters.bindings).toBeGreaterThan(initialCounters.bindings);
	});

	it("generates pure semantic summary", () => {
		const model = createToolCallModel({
			id: "call-4",
			toolName: "sample_tool",
			label: "Sample Tool",
		});
		model.applyArgsChunk({ mode: "fast", timeout: 30 });
		model.markRunning();

		const summary = defaultToolView.summary?.(model);
		expect(summary).toBeDefined();
		expect(summary?.label).toBe("Sample Tool");
		expect(summary?.detail).toContain("mode=");
		expect(summary?.status).toBe("running");
	});

	it("replaces streamed generic output reactively", () => {
		const model = createToolCallModel({
			id: "call-replaced-output",
			toolName: "custom_stream",
			label: "Streaming Tool",
		});
		model.markRunning();
		model.applyResult({ content: [{ type: "text", text: "connecting…" }] }, { partial: true });
		model.setUi({ expanded: false, allocation: 80, showImages: false });

		const root = mountForTest(() => defaultToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);
		expect(root.text().join("\n")).toContain("connecting…");

		model.applyResult({ content: [{ type: "text", text: "connected" }] }, { partial: true });
		root.flush();

		const text = root.text().join("\n");
		expect(text).toContain("connected");
		expect(text).not.toContain("connecting…");
	});
});
