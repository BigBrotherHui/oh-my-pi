// oxlint-disable no-template-curly-in-string -- sample source-code strings intentionally contain literal placeholders.
// Gallery fixtures for the filesystem tools (read, write, glob).
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	ReadToolGroupView,
	createReadToolGroupState,
	type ReadToolGroupState,
} from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { renderSnapshot } from "@oh-my-pi/pi-tui/snapshot";
import { createToolCallModel } from "@oh-my-pi/pi-tui/tools/model";
import type { GalleryFixture, GalleryFixtureState, GalleryResult } from "./types";

const readSnippet = [
	"export const globToolRenderer = {",
	"\tinline: true,",
	"\trenderCall(args: GlobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {",
	"\t\tconst meta: string[] = [];",
	"\t\tif (args.limit !== undefined) meta.push(`limit:${args.limit}`);",
	"",
	"\t\tconst text = renderStatusLine(",
	'\t\t\t{ icon: "pending", title: "Glob", description: formatGlobRenderPaths(args.paths) || "*", meta },',
	"\t\t\tuiTheme,",
	"\t\t);",
	"\t\treturn new Text(text, 0, 0);",
	"\t},",
].join("\n");

const writtenContent = [
	'import { describe, expect, it } from "bun:test";',
	'import { parseSel } from "../src/tools/read";',
	"",
	'describe("parseSel", () => {',
	'\tit("parses a single line range", () => {',
	'\t\texpect(parseSel("42-58")).toEqual({',
	'\t\t\tkind: "lines",',
	"\t\t\tranges: [{ startLine: 42, endLine: 58 }],",
	"\t\t});",
	"\t});",
	"",
	'\tit("treats raw as a verbatim selector", () => {',
	'\t\texpect(parseSel("raw")).toEqual({ kind: "raw" });',
	"\t});",
	"});",
	"",
].join("\n");

const groupedReadTargets = [
	"packages/coding-agent/test/streaming-preview-height.test.ts:301-409",
	"packages/coding-agent/test/tool-live-region-scrollback.test.ts:143-310",
	"packages/tui/test/streaming-scrollback-defer.test.ts:89-464",
];

const groupedReadDelimitedPath = groupedReadTargets.join(",");
const groupedReadRepeatedFile = "packages/coding-agent/src/task/render.ts";
const groupedReadRepeatedRanges = `${groupedReadRepeatedFile}:507-605,1070-1194,1210-1240,1270-1274`;

const GROUPED_READ_USAGE: Usage = {
	input: 2400,
	output: 113,
	cacheRead: 103_000,
	cacheWrite: 0,
	totalTokens: 105_513,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function textResult(text: string, details?: unknown, isError?: boolean): GalleryResult {
	return { content: [{ type: "text", text }], details, isError };
}

function groupedReadModel(id: string, args: { path: string }, expanded: boolean) {
	const model = createToolCallModel({ id, toolName: "read", label: "Read" });
	model.setUi({ expanded, allocation: process.stdout.rows ?? 24, showImages: false });
	model.applyArgsChunk(args);
	return model;
}

function snapshotReadGroup(group: ReadToolGroupState, width: number, expanded: boolean): readonly string[] {
	return renderSnapshot(
		() => ReadToolGroupView({ items: group.items, expanded: () => expanded, showContentPreview: false })!,
		{ columns: width, rows: process.stdout.rows ?? 24 },
	).map(line => line + " ".repeat(Math.max(0, width - Bun.stringWidth(line))));
}

function renderReadGroupFixtureState(state: GalleryFixtureState, width: number, expanded: boolean): readonly string[] {
	const group = createReadToolGroupState();
	const first = groupedReadModel(
		"read-delimited",
		{
			path:
				state === "streaming"
					? [
							"packages/coding-agent/test/streaming-preview-height.test.ts:301-409",
							"packages/coding-agent/test/tool-live-region-scrollback.test.ts:143-",
						].join(",")
					: groupedReadDelimitedPath,
		},
		expanded,
	);
	group.add(first.id, first, true);

	if (state === "streaming") return snapshotReadGroup(group, width, expanded);

	if (state === "progress") {
		const second = groupedReadModel("read-ranges", { path: groupedReadRepeatedRanges }, expanded);
		group.add(second.id, second, true);
		return snapshotReadGroup(group, width, expanded);
	}

	first.applyResult(textResult("Read three focused test ranges.", { displayReadTargets: groupedReadTargets }));
	group.settle(first.id);
	group.addUsage({
		kind: "usage",
		usage: GROUPED_READ_USAGE,
		durationMs: 5300,
		ttftMs: 2200,
		timestamp: new Date(2026, 6, 28, 21, 5, 47).getTime(),
	});

	const second = groupedReadModel("read-ranges", { path: groupedReadRepeatedRanges }, expanded);
	group.add(second.id, second, true);
	if (state === "error") {
		second.applyResult(textResult("Error: selector 1270-1274 is outside the file", undefined, true));
	} else {
		second.applyResult(textResult("Read four render.ts ranges."));
	}
	group.settle(second.id);
	group.addUsage({
		kind: "usage",
		usage: GROUPED_READ_USAGE,
		durationMs: 4700,
		ttftMs: 1900,
		timestamp: new Date(2026, 6, 28, 21, 5, 52).getTime(),
	});

	return snapshotReadGroup(group, width, expanded);
}

export const fsFixtures: Record<string, GalleryFixture> = {
	read: {
		label: "Read",
		// Streaming: path still being typed, selector not yet appended.
		streamingArgs: { path: "packages/coding-agent/src/tools/glob" },
		args: { path: "packages/coding-agent/src/tools/glob.ts:437-448" },
		result: {
			content: [
				{
					type: "text",
					text: [
						"[packages/coding-agent/src/tools/glob.ts#E48E]",
						"437:export const globToolRenderer = {",
						"438:\tinline: true,",
						"439:\trenderCall(args: GlobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {",
						"440:\t\tconst meta: string[] = [];",
						"441:\t\tif (args.limit !== undefined) meta.push(`limit:${args.limit}`);",
						"442:",
						"443:\t\tconst text = renderStatusLine(",
						'444:\t\t\t{ icon: "pending", title: "Glob", description: formatGlobRenderPaths(args.paths) || "*", meta },',
						"445:\t\t\tuiTheme,",
						"446:\t\t);",
						"447:\t\treturn new Text(text, 0, 0);",
						"448:\t},",
					].join("\n"),
				},
			],
			// A plain range read records its absolute path only in `meta.source`
			// (`resolvedPath` marks corrected, URL, and archive reads), so the
			// renderer paints no `Resolved path` line for it.
			details: {
				kind: "file",
				contentType: "text/typescript",
				displayContent: { text: readSnippet, startLine: 437 },
			},
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: "Error: ENOENT: no such file or directory, open 'packages/coding-agent/src/tools/glob.ts'",
				},
			],
		},
	},

	read_group: {
		label: "Read Groups",
		args: {},
		result: textResult("Rendered grouped read calls."),
		errorResult: textResult("Rendered grouped read errors.", undefined, true),
		renderState: renderReadGroupFixtureState,
	},

	write: {
		label: "Write",
		// Streaming: path known, content still arriving (only the imports so far).
		streamingArgs: {
			path: "packages/coding-agent/test/parse-sel.test.ts",
			content: 'import { describe, expect, it } from "bun:test";\nimport { parseSel } from "../src/tools/read";\n',
		},
		args: {
			path: "packages/coding-agent/test/parse-sel.test.ts",
			content: writtenContent,
		},
		result: {
			content: [
				{
					type: "text",
					text: "Created packages/coding-agent/test/parse-sel.test.ts (17 lines, 412 bytes).",
				},
			],
			details: {},
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: "Error: EACCES: permission denied, open 'packages/coding-agent/test/parse-sel.test.ts'",
				},
			],
		},
	},

	glob: {
		label: "Glob",
		// Streaming: glob half-typed, no limit yet.
		streamingArgs: { path: "packages/coding-agent/src/tools/*-render" },
		args: { path: "packages/coding-agent/src/**/*.test.ts", limit: 50 },
		result: {
			content: [
				{
					type: "text",
					text: [
						"packages/coding-agent/src/tools/read.test.ts",
						"packages/coding-agent/src/tools/write.test.ts",
						"packages/coding-agent/src/tools/glob.test.ts",
						"packages/coding-agent/src/cli/gallery-cli.test.ts",
						"packages/coding-agent/src/edit/edit.test.ts",
					].join("\n"),
				},
			],
			details: {
				scopePath: "packages/coding-agent/src",
				cwd: "/Users/dev/Projects/pi",
				fileCount: 5,
				truncated: false,
				files: [
					"packages/coding-agent/src/cli/gallery-cli.test.ts",
					"packages/coding-agent/src/edit/edit.test.ts",
					"packages/coding-agent/src/tools/glob.test.ts",
					"packages/coding-agent/src/tools/read.test.ts",
					"packages/coding-agent/src/tools/write.test.ts",
				],
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Glob failed: invalid glob pattern '[unclosed'." }],
			details: { error: "invalid glob pattern '[unclosed'" },
		},
	},
};
