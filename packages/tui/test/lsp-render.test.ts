import { beforeAll, describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { lspToolView, type LspParams, type LspToolDetails } from "@oh-my-pi/pi-tui/tools/lsp";
import { createToolCallModel } from "@oh-my-pi/pi-tui/tools/model";

beforeAll(async () => {
	await initTheme();
});

function createLspModel(id: string) {
	return createToolCallModel<LspParams, LspToolDetails>({ id, toolName: "lsp", label: "lsp" });
}

describe("lspToolView", () => {
	it("renders hover markdown code block with request details", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const model = createLspModel("call-lsp-1");
		model.applyArgsChunk({ action: "hover", file: "src/main.ts", line: 10 });
		model.applyResult({
			content: [
				{
					type: "text",
					text: "```typescript\nfunction greet(name: string): string\n\treturn `Hello ${name}`;\n```\nDocumentation for greet",
				},
			],
		});

		const root = mountForTest(() => lspToolView.view(model), { width: 100, theme: theme! });
		const text = root.text().join("\n");

		expect(text).toContain("LSP hover");
		expect(text).toContain("src/main.ts");
		expect(text).toContain("line 10");
		expect(text).toContain("function greet");
		expect(text).toContain("… 1 more lines");

		model.setUi({ expanded: true });
		const expanded = root.text().join("\n");
		expect(expanded).toContain("return `Hello ${name}`;");
		expect(expanded).toContain("Documentation for greet");
		root.dispose();
	});

	it("renders diagnostics with severity, language icon, and compact limit", async () => {
		const theme = await getThemeByName("dark");
		const model = createLspModel("call-lsp-2");
		model.applyArgsChunk({ action: "diagnostics", file: "src/app.ts" });
		model.applyResult({
			content: [
				{
					type: "text",
					text: "2 error(s) found:\nsrc/app.ts:5:10: Cannot find name 'foo'\nsrc/app.ts:8:12: Type 'number' is not assignable to type 'string'",
				},
			],
		});

		const root = mountForTest(() => lspToolView.view(model), { width: 100, theme: theme! });
		const text = root.text().join("\n");

		expect(text).toContain("LSP diagnostics");
		expect(text).toContain("Cannot find name 'foo'");
		expect(text).toContain("src/app.ts:5:10");
		expect(text).toContain("2 errors");
		root.dispose();
	});

	it("expands grouped references from their compact file and location budget", async () => {
		const theme = await getThemeByName("dark");
		const model = createLspModel("call-lsp-3");
		model.applyArgsChunk({ action: "references", symbol: "thing" });
		model.applyResult({
			content: [
				{
					type: "text",
					text: "5 reference(s)\nsrc/a.ts:1:2\nsrc/a.ts:3:4\nsrc/b.ts:5:6\nsrc/c.ts:7:8\nsrc/d.ts:9:10",
				},
			],
		});

		const root = mountForTest(() => lspToolView.view(model), { width: 100, theme: theme! });
		const compact = root.text().join("\n");
		expect(compact).toContain("5 found");
		expect(compact).toContain("src/a.ts");
		expect(compact).toContain("… 1 more file");
		expect(compact).not.toContain("at src/a.ts:1:2");

		model.setUi({ expanded: true });
		const expanded = root.text().join("\n");
		expect(expanded).toContain("src/d.ts");
		expect(expanded).toContain("at src/a.ts:1:2");
		root.dispose();
	});

	it("retains symbol hierarchy while compact mode shows top-level entries only", async () => {
		const theme = await getThemeByName("dark");
		const model = createLspModel("call-lsp-4");
		model.applyArgsChunk({ action: "symbols", file: "src/tree.ts" });
		model.applyResult({
			content: [
				{
					type: "text",
					text: "Symbols in src/tree.ts:\nƒ alpha @ line 1\n  m child @ line 2\nƒ beta @ line 3\nƒ gamma @ line 4\nƒ delta @ line 5",
				},
			],
		});

		const root = mountForTest(() => lspToolView.view(model), { width: 100, theme: theme! });
		const compact = root.text().join("\n");
		expect(compact).toContain("ƒ alpha line 1");
		expect(compact).toContain("… 1 more");
		expect(compact).not.toContain("m child");

		model.setUi({ expanded: true });
		const expanded = root.text().join("\n");
		expect(expanded).toContain("m child");
		expect(expanded).toContain("line 2");
		root.dispose();
	});

	it("transitions from a pending request through streamed output to a failure", async () => {
		const theme = await getThemeByName("dark");
		const model = createLspModel("call-lsp-5");
		model.applyArgsChunk({ action: "hover", file: "src/live.ts" });
		const root = mountForTest(() => lspToolView.view(model), { width: 100, theme: theme! });

		expect(root.text().join("\n")).toContain("LSP: hover src/live.ts");
		model.markRunning();
		expect(root.text().join("\n")).toContain("LSP: hover src/live.ts");

		model.applyResult({ content: [{ type: "text", text: "Waiting for server" }] }, { partial: true });
		expect(root.text().join("\n")).toContain("Waiting for server");

		model.applyResult({ content: [{ type: "text", text: "Error: language server stopped" }], isError: true });
		const failed = root.text().join("\n");
		expect(failed).toContain("LSP hover");
		expect(failed).toContain("Error: language server stopped");
		root.dispose();
	});

	it("keeps an empty aborted result visibly distinct from no result", async () => {
		const theme = await getThemeByName("dark");
		const model = createLspModel("call-lsp-6");
		model.applyArgsChunk({ action: "rename", file: "src/live.ts", line: 4 });
		model.applyResult({ content: [], status: "cancelled" });

		const root = mountForTest(() => lspToolView.view(model), { width: 100, theme: theme! });
		const text = root.text().join("\n");
		expect(text).toContain("LSP rename");
		expect(text).toContain("Cancelled");
		root.dispose();
	});
});
