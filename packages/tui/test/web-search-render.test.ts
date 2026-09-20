import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { mountForTest } from "../src/testing";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	webSearchToolView,
	type SearchRenderDetails,
	type SearchResponse,
	type WebSearchArgs,
} from "@oh-my-pi/pi-tui/tools/web-search";
import { createToolCallModel } from "../src/tools/model";
import { cellGrid } from "./cell-grid";

afterEach(() => {
	applyHyperlinkSetting("auto");
});

const ANSWER = [
	"## Overview Heading",
	"This is the **first** paragraph with bold text.",
	"",
	"Para two line here.",
	"Para three line here.",
	"Para four line here.",
	"Para five line here.",
	"Para six line here.",
	"Para seven line here.",
	"Para eight line here.",
	"The FINAL_UNIQUE_MARKER paragraph at the very end.",
].join("\n");

function buildResult(answer: string): {
	content: Array<{ type: string; text?: string }>;
	details: SearchRenderDetails;
} {
	const response: SearchResponse = {
		provider: "perplexity",
		answer,
		sources: [
			{ title: "Src One", url: "https://example.com/a", snippet: "snip a" },
			{ title: "Src Two", url: "https://example.com/b", snippet: "snip b" },
		],
	};
	return { content: [{ type: "text", text: answer }], details: { response } };
}

function renderSearchRows(answer: string, expanded: boolean, maxAnswerLines?: number): string[] {
	const model = createToolCallModel<WebSearchArgs, SearchRenderDetails>({
		id: "call-search-result",
		toolName: "web_search",
		label: "Web Search",
	});
	model.applyArgsChunk({ query: "test query", maxAnswerLines });
	model.setUi({ expanded });
	model.applyResult(buildResult(answer));

	const root = mountForTest(() => webSearchToolView.view(model), { width: 120 });
	try {
		return root.text(120);
	} finally {
		root.dispose();
	}
}

/** Slice the rendered lines belonging to the framed "Answer" section. */
function answerSection(lines: string[]): string {
	const start = lines.findIndex(l => / Answer /.test(l));
	const end = lines.findIndex((l, i) => i > start && / Sources /.test(l));
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	return lines
		.slice(start + 1, end)
		.join("\n")
		.trim();
}

describe("webSearchToolView", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the answer as markdown (strips ## and ** markers)", () => {
		const answer = answerSection(renderSearchRows(ANSWER, true));
		// Heading hashes and bold asterisks are consumed by the markdown renderer.
		expect(answer).not.toContain("##");
		expect(answer).not.toContain("**");
		// The text content survives.
		expect(answer.toLowerCase()).toContain("overview heading");
		expect(answer).toContain("first");
	});

	it("shows the full answer when expanded — no answer truncation summary", () => {
		const answer = answerSection(renderSearchRows(ANSWER, true));
		// The final paragraph is present and there is no "… N more lines" cap inside the Answer section.
		expect(answer).toContain("FINAL_UNIQUE_MARKER");
		expect(answer).not.toMatch(/more line/);
	});

	it("shows the full answer when collapsed by default", () => {
		const answer = answerSection(renderSearchRows(ANSWER, false));
		// TUI collapsed view keeps the answer intact; only explicit compact mode caps it.
		expect(answer).toContain("FINAL_UNIQUE_MARKER");
		expect(answer).not.toMatch(/more line/);
	});

	it("truncates the answer only when compact mode provides maxAnswerLines", () => {
		const answer = answerSection(renderSearchRows(ANSWER, false, 3));

		expect(answer).toMatch(/more line/);
		expect(answer).not.toContain("FINAL_UNIQUE_MARKER");
	});

	it("updates the mounted reactive view when the search settles", () => {
		applyHyperlinkSetting("always");
		const model = createToolCallModel<WebSearchArgs, SearchRenderDetails>({
			id: "call-search-1",
			toolName: "web_search",
			label: "Web Search",
		});

		model.applyArgsChunk({ query: "bun test runner" });
		model.markRunning();

		const root = mountForTest(() => webSearchToolView.view(model), {
			width: 120,
		});

		const runningText = root.text(120).join("\n");
		expect(runningText).toContain("Web Search");
		expect(runningText).toContain("bun test runner");

		model.applyResult({
			content: [{ type: "text", text: "Bun has a fast native test runner." }],
			details: {
				response: {
					provider: "tavily",
					answer: "Bun has a fast native test runner.",
					sources: [{ title: "Bun Docs", url: "https://bun.sh/docs/cli/test" }],
				},
			},
		});

		root.flush();
		const settledText = root.text(120).join("\n");
		expect(settledText).toContain("Answer");
		expect(settledText).toContain("fast native test runner");
		expect(settledText).toContain("Sources");
		expect(settledText).toContain("Bun Docs");
		expect(cellGrid(root.rows(120), 120).flatMap(row => row.map(cell => cell.link))).toContain(
			"https://bun.sh/docs/cli/test",
		);

		root.dispose();
	});

	it("preserves the historical response fallback when no structured result arrives", () => {
		const model = createToolCallModel<WebSearchArgs, SearchRenderDetails>({
			id: "call-search-fallback",
			toolName: "web_search",
			label: "Web Search",
		});
		model.applyResult({
			content: [{ type: "text", text: ["one", "two", "three", "four", "five", "six", "seven"].join("\n") }],
		});

		const root = mountForTest(() => webSearchToolView.view(model), { width: 120 });
		try {
			const text = root.text(120).join("\n");
			expect(text).toContain("Response");
			expect(text).toContain("… 1 more line");
			expect(text).not.toContain("seven");
		} finally {
			root.dispose();
		}
	});

	it("renders streamed raw output before structured search details arrive", () => {
		const model = createToolCallModel<WebSearchArgs, SearchRenderDetails>({
			id: "call-search-streaming",
			toolName: "web_search",
			label: "Web Search",
		});
		model.applyArgsChunk({ query: "streamed lookup" });
		model.markRunning();
		model.applyResult({ content: [{ type: "text", text: "partial search response" }] }, { partial: true });

		const root = mountForTest(() => webSearchToolView.view(model), { width: 120 });
		try {
			const text = root.text(120).join("\n");
			expect(text).toContain("Response");
			expect(text).toContain("partial search response");
		} finally {
			root.dispose();
		}
	});

	it("keeps provider metadata separate from the query and protects source metadata at narrow widths", () => {
		const model = createToolCallModel<WebSearchArgs, SearchRenderDetails>({
			id: "call-search-narrow",
			toolName: "web_search",
			label: "Web Search",
		});
		model.applyArgsChunk({ query: "historical source layout" });
		model.applyResult({
			content: [{ type: "text", text: "Result" }],
			details: {
				response: {
					provider: "perplexity",
					answer: "Result",
					sources: [
						{
							title: "A deliberately long source title that must yield space to its domain metadata",
							url: "https://example.com/a",
							ageSeconds: 60,
						},
					],
				},
			},
		});

		const root = mountForTest(() => webSearchToolView.view(model), { width: 42 });
		try {
			const text = root.text(42).join("\n");
			expect(text).toContain("Web Search: Perplexity");
			expect(text).toContain("Query: historical source layout");
			expect(text).toContain("example.com");
		} finally {
			root.dispose();
		}
	});

	it("renders error and abort terminal states without a successful result body", () => {
		const errorModel = createToolCallModel<WebSearchArgs, SearchRenderDetails>({
			id: "call-search-error",
			toolName: "web_search",
			label: "Web Search",
		});
		errorModel.applyResult({
			content: [{ type: "text", text: "provider unavailable" }],
			details: {
				response: { provider: "tavily", sources: [] },
				error: "provider unavailable",
			},
		});

		const errorRoot = mountForTest(() => webSearchToolView.view(errorModel), { width: 120 });
		try {
			const text = errorRoot.text(120).join("\n");
			expect(text).toContain("Error: provider unavailable");
			expect(text).not.toContain("Answer");
		} finally {
			errorRoot.dispose();
		}

		const abortModel = createToolCallModel<WebSearchArgs, SearchRenderDetails>({
			id: "call-search-abort",
			toolName: "web_search",
			label: "Web Search",
		});
		abortModel.applyArgsChunk({ query: "cancelled lookup" });
		abortModel.applyResult({ content: [{ type: "text", text: "partial result" }], status: "cancelled" });

		const abortRoot = mountForTest(() => webSearchToolView.view(abortModel), { width: 120 });
		try {
			const text = abortRoot.text(120).join("\n");
			expect(text).toContain("Web Search: cancelled lookup");
			expect(text).not.toContain("Answer");
		} finally {
			abortRoot.dispose();
		}
	});
});
