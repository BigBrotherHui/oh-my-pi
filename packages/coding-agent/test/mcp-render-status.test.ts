import { mountForTest } from "@oh-my-pi/pi-tui/testing";
import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DeferredMCPTool, MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { mcpToolView, type MCPToolDetails } from "@oh-my-pi/pi-tui/tools/mcp";
import type { MCPServerConnection, MCPToolDefinition, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createToolCallModel } from "@oh-my-pi/pi-tui/tools/model";
import { formatOutputNotice, type OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false, undefined, undefined, "dark", "light");
}, 15_000);

function makeConnection(): MCPServerConnection {
	const transport: MCPTransport = {
		connected: true,
		request<T = unknown>(): Promise<T> {
			return Promise.reject(new Error("transport is not used by renderer tests"));
		},
		notify(): Promise<void> {
			return Promise.resolve();
		},
		close(): Promise<void> {
			return Promise.resolve();
		},
	};

	return {
		name: "sentry",
		config: { command: "sentry-mcp" },
		transport,
		serverInfo: { name: "sentry", version: "1.0.0" },
		capabilities: { tools: {} },
	};
}

function makeDefinition(): MCPToolDefinition {
	return {
		name: "search_events",
		description: "Search Sentry events",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		},
	};
}

function makeTool(): MCPTool {
	return new MCPTool(makeConnection(), makeDefinition());
}

function makeDeferredTool(): DeferredMCPTool {
	return new DeferredMCPTool("sentry", makeDefinition(), () => Promise.resolve(makeConnection()));
}

function renderCompletedMCPTool(isError: boolean): string {
	const model = createToolCallModel<Record<string, unknown>, MCPToolDetails>({
		id: "call-1",
		toolName: "mcp__sentry_search_events",
		label: "sentry/search_events",
	});
	model.applyArgsChunk({ query: "level:error" });
	model.markRunning();
	model.applyResult(
		{
			content: [{ type: "text", text: isError ? "Error: denied" : '{"ok":true}' }],
			details: { serverName: "sentry", mcpToolName: "search_events", isError },
			isError,
			status: isError ? "failed" : "success",
		},
		{ partial: false },
	);
	model.setUi({ expanded: true, allocation: 80, showImages: true });

	const root = mountForTest(() => mcpToolView.view(model), { width: 160, theme: loadThemeSync("dark") });
	const text = root.text().join("\n");
	root.dispose();
	return text;
}

describe("MCP tool rendering", () => {
	it("supplies toolView on MCPTool and DeferredMCPTool and renders completed call", () => {
		const tool = makeTool();
		const deferred = makeDeferredTool();

		expect(tool.toolView).toBe(mcpToolView);
		expect(deferred.toolView).toBe(mcpToolView);

		const rendered = renderCompletedMCPTool(false);
		expect(rendered).toContain("sentry/search_events");
		expect(rendered).toContain("ok: true");
	});

	it("replaces the pending call header with an error header for MCP errors", () => {
		const rendered = renderCompletedMCPTool(true);

		expect(rendered).toContain("sentry/search_events");
		expect(rendered).toContain("Error: denied");
	});

	it("strips the spill notice from the body and surfaces the artifact link as a styled warning", () => {
		const meta: OutputMeta = {
			truncation: {
				direction: "tail",
				truncatedBy: "bytes",
				totalLines: 100,
				totalBytes: 8000,
				outputLines: 4,
				outputBytes: 160,
				maxBytes: 1024,
				shownRange: { start: 97, end: 100 },
				artifactId: "7",
			},
		};
		const body = "event 97\nevent 98\nevent 99\nevent 100";
		const model = createToolCallModel<Record<string, unknown>, MCPToolDetails>({
			id: "call-2",
			toolName: "mcp__evk_peek",
			label: "evk/peek",
		});
		model.markRunning();
		model.applyResult(
			{
				content: [{ type: "text" as const, text: body + formatOutputNotice(meta) }],
				details: { serverName: "evk", mcpToolName: "peek", meta },
			},
			{ partial: false },
		);
		model.setUi({ expanded: true, allocation: 80, showImages: true });

		const root = mountForTest(() => mcpToolView.view(model), { width: 160, theme: loadThemeSync("dark") });
		const rendered = root.text().join("\n");
		root.dispose();

		expect(rendered).toContain("event 97");
		expect(rendered).toContain("event 100");
		expect(rendered).toContain("artifact://7");
		expect(rendered.split("artifact://7").length - 1).toBe(1);
	});
});
