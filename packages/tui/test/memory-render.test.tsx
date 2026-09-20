import { afterEach, describe, expect, test } from "bun:test";
import { createToolCallModel } from "../src/tools/model";
import {
	recallToolView,
	reflectToolView,
	retainToolView,
	type MemoryRetainDetails,
	type QueryRenderArgs,
	type RetainRenderArgs,
} from "../src/tools/memory";
import { mountForTest, type TestRoot } from "../src/testing";

const roots: TestRoot[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) root.dispose();
});

describe("memory tool presentations", () => {
	test("keeps retain items, streaming storage metadata, and the expandable item budget", () => {
		const model = createToolCallModel<RetainRenderArgs, MemoryRetainDetails>({
			id: "retain-memory",
			toolName: "retain",
			label: "Retain",
		});
		model.applyArgsChunk({
			items: Array.from({ length: 9 }, (_, index) => ({ content: `memory ${index + 1}` })),
		});
		const root = mountForTest(() => retainToolView.view(model), { width: 100 });
		roots.push(root);

		const pending = root.text().join("\n");
		expect(pending).toContain("Retain");
		expect(pending).toContain("memory 1");
		expect(pending).toContain("… 1 more");
		expect(pending).not.toContain("memory 9");

		model.markRunning();
		model.applyResult(
			{ content: [{ type: "text", text: "9 memories stored." }], details: { count: 9 } },
			{ partial: true },
		);
		expect(root.text().join("\n")).toContain("9 memories stored");

		model.applyResult({ content: [{ type: "text", text: "9 memories stored." }], details: { count: 9 } });
		model.setUi({ expanded: true });
		expect(root.text().join("\n")).toContain("memory 9");
	});

	test("uses the historical recall header, collapsed inspection hint, and expanded result body", () => {
		const model = createToolCallModel<QueryRenderArgs>({ id: "recall-memory", toolName: "recall", label: "Recall" });
		model.applyArgsChunk({ query: "project convention" });
		model.applyResult({
			content: [{ type: "text", text: "Found 2 relevant memories\nfirst recalled memory\nsecond recalled memory" }],
		});
		const root = mountForTest(() => recallToolView.view(model), { width: 100 });
		roots.push(root);

		const collapsed = root.text().join("\n");
		expect(collapsed).toContain("Recall: project convention");
		expect(collapsed).toContain("2 found");
		expect(collapsed).toContain("Expand");
		expect(collapsed).not.toContain("first recalled memory");

		model.setUi({ expanded: true });
		const expanded = root.text().join("\n");
		expect(expanded).toContain("first recalled memory");
		expect(expanded).toContain("second recalled memory");
	});

	test("caps reflect output when collapsed and restores every historical result line when expanded", () => {
		const model = createToolCallModel<QueryRenderArgs>({
			id: "reflect-memory",
			toolName: "reflect",
			label: "Reflect",
		});
		model.applyArgsChunk({ query: "recent activity" });
		model.applyResult({ content: [{ type: "text", text: "one\ntwo\nthree\nfour" }] });
		const root = mountForTest(() => reflectToolView.view(model), { width: 100 });
		roots.push(root);

		const collapsed = root.text().join("\n");
		expect(collapsed).toContain("Reflect: recent activity");
		expect(collapsed).toContain("… 1 more lines");
		expect(collapsed).not.toContain("four");

		model.setUi({ expanded: true });
		expect(root.text().join("\n")).toContain("four");
	});

	test("keeps failure and abort states distinct from successful memory views", () => {
		const failed = createToolCallModel<RetainRenderArgs, MemoryRetainDetails>({
			id: "retain-memory-failed",
			toolName: "retain",
			label: "Retain",
		});
		failed.applyResult({ content: [{ type: "text", text: "Error: memory store unavailable" }], isError: true });
		const failedRoot = mountForTest(() => retainToolView.view(failed), { width: 100 });
		roots.push(failedRoot);
		expect(failedRoot.text().join("\n")).toContain("Error: memory store unavailable");
		expect(retainToolView.summary?.(failed)?.status).toBe("error");

		const aborted = createToolCallModel<QueryRenderArgs>({
			id: "recall-memory-aborted",
			toolName: "recall",
			label: "Recall",
		});
		aborted.applyArgsChunk({ query: "unfinished query" });
		aborted.applyResult({
			content: [{ type: "text", text: "Found 1 relevant memories\npartial recall" }],
			status: "cancelled",
		});
		aborted.setUi({ expanded: true });
		const abortedRoot = mountForTest(() => recallToolView.view(aborted), { width: 100 });
		roots.push(abortedRoot);
		expect(abortedRoot.text().join("\n")).toContain("partial recall");
		expect(recallToolView.summary?.(aborted)?.status).toBe("aborted");
	});
});
