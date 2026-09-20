import { afterEach, describe, expect, it } from "bun:test";
import { mountForTest, type TestRoot } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import { mcpToolView, parseMCPToolName, setMcpRenderMarkdownResults, type MCPToolDetails } from "../src/tools/mcp";
import { loadThemeSync } from "../src/theme/loader";

const mounted: TestRoot[] = [];
afterEach(() => {
	for (const root of mounted.splice(0)) root.dispose();
	setMcpRenderMarkdownResults(false);
});

describe("mcpToolView", () => {
	it("parses server and tool names correctly", () => {
		expect(parseMCPToolName("mcp__github_search_code")).toEqual({
			serverName: "github",
			toolName: "search_code",
		});
		expect(parseMCPToolName("mcp__sentry_peek")).toEqual({
			serverName: "sentry",
			toolName: "peek",
		});
		expect(parseMCPToolName("bash")).toBeNull();
		expect(parseMCPToolName("mcp__incomplete")).toBeNull();
	});

	it("renders collapsed view with mcp icon, server/tool title, and args preview", () => {
		const model = createToolCallModel<Record<string, unknown>, MCPToolDetails>({
			id: "call-1",
			toolName: "mcp__github_search_code",
			label: "mcp__github_search_code",
		});
		model.applyArgsChunk({ query: "import foo", language: "typescript" });
		model.markRunning();
		model.setUi({ expanded: false, allocation: 80, showImages: false });

		const root = mountForTest(() => mcpToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("github/search_code");
		expect(text).toContain("query");
		expect(text).toContain("import foo");
	});

	it("renders expanded view with args, structured JSON result, and truncation notice", () => {
		const model = createToolCallModel<Record<string, unknown>, MCPToolDetails>({
			id: "call-2",
			toolName: "mcp__sentry_query",
			label: "mcp__sentry_query",
		});
		model.applyArgsChunk({ eventId: "12345" });
		model.markRunning();
		model.applyResult(
			{
				content: [{ type: "text", text: JSON.stringify({ event: { id: "12345", title: "NullPointer" } }) }],
				details: {
					serverName: "sentry",
					mcpToolName: "query",
					meta: {
						truncation: {
							direction: "tail",
							totalLines: 100,
							totalBytes: 5000,
							outputLines: 2,
							outputBytes: 50,
							artifactId: "art-99",
						},
					},
				},
				isError: false,
			},
			{ partial: false },
		);
		model.setUi({ expanded: true, allocation: 80, showImages: false });

		const root = mountForTest(() => mcpToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("sentry/query");
		expect(text).toContain("Args");
		expect(text).toContain("12345");
		expect(text).toContain("NullPointer");
		expect(text).toContain("artifact://art-99");
	});

	it("renders error state when call fails", () => {
		const model = createToolCallModel<Record<string, unknown>, MCPToolDetails>({
			id: "call-3",
			toolName: "mcp__db_run",
			label: "mcp__db_run",
		});
		model.applyArgsChunk({ sql: "DROP TABLE users" });
		model.markRunning();
		model.applyResult(
			{
				content: [{ type: "text", text: "Permission denied" }],
				details: { serverName: "db", mcpToolName: "run", isError: true },
				isError: true,
				status: "failed",
			},
			{ partial: false },
		);
		model.setUi({ expanded: false, allocation: 80, showImages: false });

		const root = mountForTest(() => mcpToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("db/run");
		expect(text).toContain("Permission denied");
	});

	it("supports markdown rendering toggle", () => {
		setMcpRenderMarkdownResults(true);
		const model = createToolCallModel<Record<string, unknown>, MCPToolDetails>({
			id: "call-4",
			toolName: "mcp__docs_get",
			label: "mcp__docs_get",
		});
		model.markRunning();
		model.applyResult(
			{
				content: [{ type: "text", text: "# Header\nSome documentation text." }],
				details: { serverName: "docs", mcpToolName: "get" },
			},
			{ partial: false },
		);
		model.setUi({ expanded: true, allocation: 80, showImages: false });

		const root = mountForTest(() => mcpToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("docs/get");
		expect(text).toContain("documentation text");
	});

	it("renders streamed output instead of repeating the pending argument preview", () => {
		const model = createToolCallModel<Record<string, unknown>, MCPToolDetails>({
			id: "call-stream",
			toolName: "mcp__logs_tail",
			label: "mcp__logs_tail",
		});
		model.applyArgsChunk({ follow: true });
		model.markRunning();
		model.applyResult(
			{
				content: [{ type: "text", text: "connected\nreceiving events" }],
				details: { serverName: "logs", mcpToolName: "tail" },
			},
			{ partial: true },
		);
		model.setUi({ expanded: false, allocation: 80, showImages: false });

		const root = mountForTest(() => mcpToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("connected");
		expect(text).toContain("receiving events");
		expect(text).not.toContain("follow=");
	});

	it("reports cancelled calls as aborted without duplicating images as text", () => {
		const model = createToolCallModel<Record<string, unknown>, MCPToolDetails>({
			id: "call-abort",
			toolName: "mcp__camera_capture",
			label: "mcp__camera_capture",
		});
		model.markRunning();
		model.applyResult(
			{
				content: [
					{ type: "text", text: "Cancelled" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				details: { serverName: "camera", mcpToolName: "capture" },
				status: "cancelled",
			},
			{ partial: false },
		);
		model.setUi({ expanded: false, allocation: 80, showImages: true });

		const root = mountForTest(() => mcpToolView.view(model), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		const text = root.text().join("\n");
		expect(mcpToolView.summary?.(model)?.status).toBe("aborted");
		expect(text).toContain("Cancelled");
		expect(text).not.toContain("[Image:");
		expect(model.images).toHaveLength(1);
	});

	it("produces pure semantic summary", () => {
		const model = createToolCallModel<Record<string, unknown>, MCPToolDetails>({
			id: "call-5",
			toolName: "mcp__github_issues",
			label: "mcp__github_issues",
		});
		model.applyArgsChunk({ repo: "oh-my-pi/pi", state: "open" });
		model.markRunning();

		const summary = mcpToolView.summary?.(model);
		expect(summary).toBeDefined();
		expect(summary?.label).toBe("github/issues");
		expect(summary?.detail).toBe("2 arguments");
		expect(summary?.status).toBe("running");
	});
});
