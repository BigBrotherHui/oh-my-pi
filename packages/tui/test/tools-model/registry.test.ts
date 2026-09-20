import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createEffect, createRoot } from "../../src/reactive";
import type { ToolViewDefinition } from "../../src/tools/view";
import { createToolCallModel } from "../../src/tools/model";
import { registerToolView, resolveToolView, toolViews, type ToolViewSource } from "../../src/tools/registry";

function definition(label: string): ToolViewDefinition<unknown, unknown> {
	return { view: () => label };
}

const originalViews = new Map(toolViews);

beforeEach(() => toolViews.clear());

afterEach(() => {
	toolViews.clear();
	for (const [name, view] of originalViews) toolViews.set(name, view);
});

describe("tool view selection", () => {
	it("selects exact, MCP, extension, and default definitions without mounting", () => {
		const fallback = definition("default");
		const mcp = definition("mcp");
		const exact = definition("bash");
		const custom = definition("extension");
		registerToolView("default", fallback);
		registerToolView("mcp", mcp);
		registerToolView("bash", exact);

		expect(resolveToolView("bash")).toEqual({ definition: exact });
		expect(resolveToolView("mcp__github_search")).toEqual({ definition: mcp });
		expect(resolveToolView("unregistered")).toEqual({ definition: fallback });
		expect(resolveToolView("bash", { toolView: custom })).toEqual({ definition: custom });
	});

	it("returns a readonly delegated presentation for coding-agent-approved xd dispatch", () => {
		const fallback = definition("default");
		const lsp = definition("lsp");
		registerToolView("default", fallback);
		registerToolView("lsp", lsp);
		const outer = createToolCallModel({ id: "write-7", toolName: "write", label: "Write" });
		outer.applyArgsChunk({ path: "xd://lsp", content: "references" });
		outer.markRunning();
		outer.applyResult(
			{
				content: [{ type: "text", text: "searching" }],
				details: { xdev: { tool: "lsp", inner: { tokenCount: 4, async: { state: "running" } } } },
			},
			{ partial: true },
		);
		const source: ToolViewSource = {
			model: outer,
			resolveInnerTool(args) {
				if (args.path !== "xd://lsp") return undefined;
				return {
					toolName: "lsp",
					label: "Language Server",
					args: { action: args.content },
					rawArgs: `{"action":${JSON.stringify(args.content)}}`,
				};
			},
		};

		const first = resolveToolView("write", source);
		expect(first.definition).toBe(lsp);
		expect(first.model?.id).toBe("write-7:inner");
		expect(first.model?.toolName).toBe("lsp");
		expect(first.model?.label).toBe("Language Server");
		expect(first.model?.args).toEqual({ action: "references" });
		expect(first.model?.rawArgs).toBe('{"action":"references"}');
		expect(first.model?.output).toBe(outer.output);
		expect(first.model?.notices).toBe(outer.notices);
		expect(first.model?.phase).toBe("running");
		expect(first.model?.output.text()).toBe("searching");

		outer.applyResult(
			{
				content: [{ type: "text", text: "found 3 references" }],
				details: { xdev: { tool: "lsp", inner: { tokenCount: 9, exitCode: 0 } } },
			},
			{ partial: false },
		);
		expect(first.model?.phase).toBe("settled");
		expect(first.model?.outcome).toBe("success");
		expect(first.model?.output.text()).toBe("found 3 references");
		expect(first.model?.details).toEqual({ tokenCount: 9, exitCode: 0 });
		expect(resolveToolView("write", source).definition).toBe(lsp);
	});

	it("does not rerun pure resolution for outer result updates", () => {
		const fallback = definition("default");
		const lsp = definition("lsp");
		registerToolView("default", fallback);
		registerToolView("lsp", lsp);
		const outer = createToolCallModel({ id: "write-9", toolName: "write", label: "Write" });
		outer.applyArgsChunk({ path: "xd://lsp", content: "symbols" });
		outer.markRunning();
		let selected = resolveToolView("write");
		let runs = 0;
		const dispose = createRoot(rootDispose => {
			createEffect(() => {
				selected = resolveToolView("write", {
					model: outer,
					resolveInnerTool(args) {
						return args.path === "xd://lsp" ? { toolName: "lsp", args: { action: args.content } } : undefined;
					},
				});
				runs++;
			});
			return rootDispose;
		});
		const inner = selected.model;
		expect(runs).toBe(1);
		expect(inner?.output.text()).toBe("");

		outer.applyResult({ content: "symbols: 3", details: { tokenCount: 3 } }, { partial: true });
		expect(runs).toBe(1);
		expect(inner?.output.text()).toBe("symbols: 3");
		expect(inner?.details).toEqual({ tokenCount: 3 });
		dispose();
	});

	it("does not expose an xd inner presentation without host approval", () => {
		const fallback = definition("default");
		const lsp = definition("lsp");
		registerToolView("default", fallback);
		registerToolView("lsp", lsp);
		const outer = createToolCallModel({ id: "write-unapproved", toolName: "write", label: "Write" });
		outer.applyArgsChunk({ path: "xd://lsp", content: "references" });
		outer.applyResult({
			content: [{ type: "text", text: "private details" }],
			details: { xdev: { tool: "lsp", inner: { diagnostics: ["private"] } } },
		});
		const resolved = resolveToolView("write", {
			model: outer,
			resolveInnerTool: () => undefined,
		});
		expect(resolved.definition).toBe(fallback);
		expect(resolved.model).toBeUndefined();
	});

	it("changes delegated identity only when host approval selects another target", () => {
		const fallback = definition("default");
		const lsp = definition("lsp");
		const task = definition("task");
		registerToolView("default", fallback);
		registerToolView("lsp", lsp);
		registerToolView("task", task);
		const outer = createToolCallModel({ id: "write-10", toolName: "write", label: "Write" });
		outer.applyArgsChunk({ path: "xd://lsp", content: "symbols" });
		const source: ToolViewSource = {
			model: outer,
			resolveInnerTool(args) {
				if (args.path === "xd://lsp") return { toolName: "lsp", args: { action: args.content } };
				if (args.path === "xd://task") return { toolName: "task", args: { task: args.content } };
				return undefined;
			},
		};

		const lspSelection = resolveToolView("write", source);
		outer.applyArgsChunk({ path: "xd://task" });
		const taskSelection = resolveToolView("write", source);
		expect(lspSelection.identity).not.toBe(taskSelection.identity);
		expect(taskSelection.definition).toBe(task);
		expect(taskSelection.model?.toolName).toBe("task");
		expect(taskSelection.model?.args).toEqual({ task: "symbols" });
	});

	it("keeps an extension definition ahead of delegated and fallback views", () => {
		const fallback = definition("default");
		const lsp = definition("lsp");
		const custom = definition("outer");
		registerToolView("default", fallback);
		registerToolView("lsp", lsp);
		const outer = createToolCallModel({ id: "write-8", toolName: "write", label: "Write" });
		outer.applyArgsChunk({ path: "xd://lsp" });
		const resolved = resolveToolView("write", {
			model: outer,
			toolView: custom,
			resolveInnerTool: () => ({ toolName: "lsp", args: {} }),
		});
		expect(resolved).toEqual({ definition: custom });
		expect(resolved.model).toBeUndefined();
	});
});
