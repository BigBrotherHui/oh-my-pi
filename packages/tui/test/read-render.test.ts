import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { mountForTest } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import { readToolView, type ReadRenderArgs, type ReadToolDetails } from "../src/tools/read";
import { cellGrid } from "./cell-grid";

afterEach(() => {
	applyHyperlinkSetting("auto");
});

describe("read tool view", () => {
	it("renders the requested path as a selected filesystem link and a collapsed output preview", () => {
		applyHyperlinkSetting("always");
		const model = createToolCallModel<ReadRenderArgs, ReadToolDetails>({
			id: "read-1",
			toolName: "read",
			label: "Read",
		});
		model.applyArgsChunk({ path: "local://handoff.md:2" });
		model.applyResult({
			content: [{ type: "text", text: "first line\nsecond line\nthird line" }],
			details: { resolvedPath: "/tmp/handoff.md", contentType: "text/plain" },
		});

		const root = mountForTest(() => readToolView.view(model), { width: 80 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("local://handoff.md:2");
			expect(text).toContain("first line");
			expect(text).toContain("third line");
			const links = cellGrid(root.rows(), 80).flatMap(row => row.map(cell => cell.link));
			expect(links).toContain(url.pathToFileURL(path.resolve("/tmp/handoff.md")).href);
		} finally {
			root.dispose();
		}
	});

	it("keeps streaming read output visible before the result settles", () => {
		const model = createToolCallModel<ReadRenderArgs, ReadToolDetails>({
			id: "read-streaming",
			toolName: "read",
			label: "Read",
		});
		model.applyArgsChunk({ path: "src/live.ts" });
		model.markRunning();
		model.applyResult(
			{
				content: [{ type: "text", text: "export const streamed = true;" }],
				details: { contentType: "text/typescript" },
			},
			{ partial: true },
		);

		const root = mountForTest(() => readToolView.view(model), { width: 80 });
		try {
			expect(root.text().join("\n")).toContain("export const streamed = true;");
		} finally {
			root.dispose();
		}
	});

	it("caps collapsed code output, preserves source line numbers, and expands the full document", () => {
		const model = createToolCallModel<ReadRenderArgs, ReadToolDetails>({
			id: "read-lines",
			toolName: "read",
			label: "Read",
		});
		const source = Array.from({ length: 14 }, (_, index) => `line-${index + 1}`).join("\n");
		model.applyArgsChunk({ path: "src/lines.ts" });
		model.applyResult({
			content: [{ type: "text", text: source }],
			details: { contentType: "text/typescript", displayContent: { text: source, startLine: 40 } },
		});

		const root = mountForTest(() => readToolView.view(model), { width: 80 });
		try {
			const collapsed = root.text().join("\n");
			expect(collapsed).toContain("40 line-1");
			expect(collapsed).toContain("line-12");
			expect(collapsed).toContain("2 more lines");
			expect(collapsed).not.toContain("line-13");

			model.setUi({ expanded: true });
			const expanded = root.text().join("\n");
			expect(expanded).toContain("line-14");
			expect(expanded).not.toContain("2 more lines");
		} finally {
			root.dispose();
		}
	});

	it("renders markdown documents unless a raw selector requests source text", () => {
		const markdown = "# Heading\n\nThis is **bold** text.";
		const rendered = createToolCallModel<ReadRenderArgs, ReadToolDetails>({
			id: "read-markdown",
			toolName: "read",
			label: "Read",
		});
		rendered.applyArgsChunk({ path: "notes.md" });
		rendered.applyResult({
			content: [{ type: "text", text: markdown }],
			details: { contentType: "text/markdown", displayContent: { text: markdown, startLine: 1 } },
		});
		rendered.setUi({ expanded: true });

		const raw = createToolCallModel<ReadRenderArgs, ReadToolDetails>({
			id: "read-markdown-raw",
			toolName: "read",
			label: "Read",
		});
		raw.applyArgsChunk({ path: "notes.md:raw" });
		raw.applyResult({
			content: [{ type: "text", text: markdown }],
			details: { contentType: "text/markdown", displayContent: { text: markdown, startLine: 1 } },
		});
		raw.setUi({ expanded: true });

		const renderedRoot = mountForTest(() => readToolView.view(rendered), { width: 80 });
		const rawRoot = mountForTest(() => readToolView.view(raw), { width: 80 });
		try {
			expect(renderedRoot.text().join("\n")).toContain("This is bold text.");
			expect(renderedRoot.text().join("\n")).not.toContain("# Heading");
			expect(rawRoot.text().join("\n")).toContain("# Heading");
			expect(rawRoot.text().join("\n")).toContain("**bold**");
		} finally {
			renderedRoot.dispose();
			rawRoot.dispose();
		}
	});

	it("renders image details and output warnings without losing the attached image block", () => {
		const model = createToolCallModel<ReadRenderArgs, ReadToolDetails>({
			id: "read-image",
			toolName: "read",
			label: "Read",
		});
		model.applyArgsChunk({ path: "local://shot.png" });
		model.applyResult({
			content: [
				{ type: "text", text: "a\tb" },
				{ type: "image", data: "not-a-real-image", mimeType: "image/png" },
			],
			details: {
				contentType: "image/png",
				meta: {
					truncation: {
						direction: "head",
						truncatedBy: "lines",
						totalLines: 3,
						totalBytes: 20,
						outputLines: 1,
						outputBytes: 4,
					},
				},
			},
		});

		const root = mountForTest(() => readToolView.view(model), { width: 80 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("Details");
			expect(text).toContain("a   b");
			expect(text).toContain("Showing 1 of 3 lines");
		} finally {
			root.dispose();
		}
	});

	it("restores URL metadata and a bounded content preview", () => {
		const model = createToolCallModel<ReadRenderArgs, ReadToolDetails>({
			id: "read-url",
			toolName: "read",
			label: "Read",
		});
		model.applyArgsChunk({ path: "http://example.com/start" });
		model.applyResult({
			content: [{ type: "text", text: "---\n\none\ntwo\nthree\nfour" }],
			details: {
				kind: "url",
				url: "http://example.com/start",
				finalUrl: "http://example.com/final",
				contentType: "text/plain",
				method: "GET",
				truncated: true,
				notes: ["redirect followed"],
			},
		});

		const root = mountForTest(() => readToolView.view(model), { width: 100 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("example.com /final");
			expect(text).toContain("Metadata");
			expect(text).toContain("Content-Type: text/plain");
			expect(text).toContain("Method: GET");
			expect(text).toContain("Final URL: http://example.com/final");
			expect(text).toContain("Lines: 4 lines");
			expect(text).toContain("Chars: 18");
			expect(text).toContain("Output truncated");
			expect(text).toContain("Notes: redirect followed");
			expect(text).toContain("Content Preview");
			expect(text).toContain("… 1 more line");
			expect(text).toContain("Expand");
		} finally {
			root.dispose();
		}
	});

	it("marks failures and aborts without corrupting CRLF or tabs", () => {
		const failure = createToolCallModel<ReadRenderArgs, ReadToolDetails>({
			id: "read-error",
			toolName: "read",
			label: "Read",
		});
		failure.applyArgsChunk({ path: "ssh://host/config" });
		failure.applyResult({
			content: [{ type: "text", text: "Error: fetch failed:\treset\r\nby peer" }],
			isError: true,
		});

		const aborted = createToolCallModel<ReadRenderArgs, ReadToolDetails>({
			id: "read-aborted",
			toolName: "read",
			label: "Read",
		});
		aborted.applyArgsChunk({ path: "stopped.txt" });
		aborted.applyResult({ content: [{ type: "text", text: "cancelled" }], status: "cancelled" });

		const failureRoot = mountForTest(() => readToolView.view(failure), { width: 80 });
		try {
			const text = failureRoot.text().join("\n");
			expect(text).toContain("fetch failed:   reset");
			expect(text).toContain("by peer");
			expect(text).not.toContain("\r");
			expect(text).not.toContain("\t");
			expect(readToolView.summary!(aborted).status).toBe("aborted");
		} finally {
			failureRoot.dispose();
		}
	});
});
