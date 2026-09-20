import { afterEach, describe, expect, it } from "bun:test";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { mountForTest } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import {
	fetchToolView,
	repairCollapsedScheme,
	type FetchArgs,
	type ReadUrlToolDetails,
} from "@oh-my-pi/pi-tui/tools/fetch";
import { cellGrid } from "./cell-grid";

afterEach(() => {
	applyHyperlinkSetting("auto");
});

describe("fetchToolView reactive mount", () => {
	it("repairs collapsed HTTP schemes before resolving links", () => {
		expect(repairCollapsedScheme("https:/example.com/docs")).toBe("https://example.com/docs");
	});

	it("mounts via mountForTest and renders metadata and content preview", async () => {
		applyHyperlinkSetting("always");
		const model = createToolCallModel<FetchArgs, ReadUrlToolDetails>({
			id: "fetch-1",
			toolName: "fetch",
			label: "Read",
		});

		model.applyArgsChunk({ url: "https://example.com/docs" });
		model.markRunning();

		const root = mountForTest(() => fetchToolView.view(model), {
			width: 120,
		});

		const runningText = root.text(120).join("\n");
		expect(runningText).toContain("Read");
		expect(runningText).toContain("example.com");

		const details: ReadUrlToolDetails = {
			kind: "url",
			url: "https://example.com/docs",
			finalUrl: "https://example.com/docs/v2",
			contentType: "text/html",
			method: "GET",
			truncated: false,
			notes: ["redirect followed"],
		};

		model.applyResult({
			content: [{ type: "text", text: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5" }],
			details,
		});

		root.flush();
		const settledText = root.text(120).join("\n");
		expect(settledText).toContain("Metadata");
		expect(settledText).toContain("Content-Type: text/html");
		expect(settledText).toContain("Method: GET");
		expect(settledText).toContain("Final URL:");
		expect(settledText).toContain("Lines: 5 lines");
		expect(settledText).toContain("Chars: 34");
		expect(settledText).toContain("Notes: redirect followed");
		expect(settledText).toContain("Content Preview");
		expect(settledText).toContain("Line 1");

		const rows = root.rows(120);
		const grid = cellGrid(rows, 120);
		expect(grid.length).toBeGreaterThan(0);
		expect(grid.flatMap(row => row.map(cell => cell.link))).toContain("https://example.com/docs/v2");

		root.dispose();
	});

	it("shows truncation warning when truncated", async () => {
		const model = createToolCallModel<FetchArgs, ReadUrlToolDetails>({
			id: "fetch-2",
			toolName: "fetch",
			label: "Read",
		});

		const details: ReadUrlToolDetails = {
			kind: "url",
			url: "https://example.com/big",
			finalUrl: "https://example.com/big",
			contentType: "text/plain",
			method: "GET",
			truncated: true,
			notes: [],
			meta: {
				truncation: {
					direction: "head",
					truncatedBy: "lines",
					totalLines: 10,
					totalBytes: 100,
					outputLines: 1,
					outputBytes: 20,
					artifactId: "fetch-output",
				},
			},
		};

		model.applyResult({
			content: [{ type: "text", text: "Long output content here" }],
			details,
		});

		const root = mountForTest(() => fetchToolView.view(model), {
			width: 120,
		});

		const text = root.text(120).join("\n");
		expect(text).toContain("Output truncated");
		expect(text).toContain("truncated");
		expect(text).toContain("Read artifact://fetch-output for full output");

		root.dispose();
	});

	it("keeps the pending call inline and limits the collapsed preview to three source lines", () => {
		const model = createToolCallModel<FetchArgs, ReadUrlToolDetails>({
			id: "fetch-preview",
			toolName: "fetch",
			label: "Read",
		});
		model.applyArgsChunk({ path: "https://example.com/pending", raw: true });

		const root = mountForTest(() => fetchToolView.view(model), { width: 120 });
		const pending = root.text(120).join("\n");
		expect(pending).toContain("Read: example.com /pending");
		expect(pending).toContain("raw");
		expect(pending).not.toContain("Metadata");
		expect(pending).not.toContain("No response data");

		model.applyResult({
			content: [{ type: "text", text: "ONE\nTWO\nTHREE\nFOUR\nFIVE" }],
			details: {
				kind: "url",
				url: "https://example.com/pending",
				finalUrl: "https://example.com/pending",
				contentType: "text/plain",
				method: "GET",
				truncated: false,
				notes: [],
			},
		});

		const compact = root.text(120).join("\n");
		expect(compact).toContain("ONE");
		expect(compact).toContain("TWO");
		expect(compact).toContain("THREE");
		expect(compact).not.toContain("FOUR");
		expect(compact).toContain("… 2 more lines");

		const narrow = root.text(32).join("\n");
		expect(narrow).toContain("ONE");
		expect(narrow).toContain("… 2 more lines");

		model.setUi({ expanded: true });
		const expanded = root.text(120).join("\n");
		expect(expanded).toContain("FOUR");
		expect(expanded).toContain("FIVE");
		expect(expanded).not.toContain("… 2 more lines");

		root.dispose();
	});

	it("renders failed and aborted calls without a stale no-response fallback", () => {
		const failed = createToolCallModel<FetchArgs, ReadUrlToolDetails>({
			id: "fetch-failed",
			toolName: "fetch",
			label: "Read",
		});
		failed.applyResult({
			content: [{ type: "text", text: "Error: origin refused the request" }],
			isError: true,
		});

		const failedRoot = mountForTest(() => fetchToolView.view(failed), { width: 120 });
		const failedText = failedRoot.text(120).join("\n");
		expect(failedText).toContain("origin refused the request");
		expect(failedText).not.toContain("Error: origin refused the request");
		expect(failedText).not.toContain("Metadata");
		failedRoot.dispose();

		const aborted = createToolCallModel<FetchArgs, ReadUrlToolDetails>({
			id: "fetch-aborted",
			toolName: "fetch",
			label: "Read",
		});
		aborted.applyArgsChunk({ url: "https://example.com/aborted" });
		aborted.applyResult({ content: [], status: "cancelled" });

		const abortedRoot = mountForTest(() => fetchToolView.view(aborted), { width: 120 });
		const abortedText = abortedRoot.text(120).join("\n");
		expect(abortedText).toContain("Read");
		expect(abortedText).not.toContain("No response data");
		expect(abortedText).not.toContain("Metadata");
		abortedRoot.dispose();
	});
});
