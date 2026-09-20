import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	classifyGroupedLines,
	formatGroupedFiles,
	groupLineIndicesByBlank,
	parseGroupedOutputToStructure,
} from "@oh-my-pi/pi-tui/tools/grouped-file-output";

const REPO_ROOT = path.resolve("repo");
const OUTSIDE_DIR = path.resolve(path.parse(REPO_ROOT).root, "outside", "dir");

function toGroupedHeaderPath(filePath: string): string {
	return filePath.split(path.sep).join("/");
}

describe("formatGroupedFiles", () => {
	it("nests subdirectories with deeper headings and blank-separates top groups", () => {
		const { model } = formatGroupedFiles(["pkg/ai/CHANGELOG.md", "pkg/ai/src/util/x.ts", "README.md"], file => ({
			modelLines: [`  ${file}`],
			headerSuffix: " (1)",
		}));

		expect(model).toEqual([
			"# README.md (1)",
			"  README.md",
			"",
			"# pkg/ai/",
			"## CHANGELOG.md (1)",
			"  pkg/ai/CHANGELOG.md",
			"",
			"## src/util/",
			"### x.ts (1)",
			"  pkg/ai/src/util/x.ts",
		]);
	});

	it("omits skipped files and their now-empty directories", () => {
		const { model } = formatGroupedFiles(["a/keep.ts", "a/drop.ts"], file => ({
			modelLines: [`  ${file}`],
			skip: file.endsWith("drop.ts"),
		}));
		expect(model).toEqual(["# a/", "## keep.ts", "  a/keep.ts"]);
	});
});

describe("classifyGroupedLines", () => {
	it("reconstructs absolute paths across a nested directory stack", () => {
		const lines = ["# pkg/ai/", "## CHANGELOG.md", "  match", "## src/util/", "### x.ts", "*12│const y = 1;"];
		const ctx = classifyGroupedLines(lines, REPO_ROOT);

		expect(ctx[0]).toMatchObject({ kind: "dir", headerPath: path.join(REPO_ROOT, "pkg", "ai") });
		expect(ctx[1]).toMatchObject({ kind: "file", headerPath: path.join(REPO_ROOT, "pkg", "ai", "CHANGELOG.md") });
		expect(ctx[2]).toMatchObject({ kind: "content", filePath: path.join(REPO_ROOT, "pkg", "ai", "CHANGELOG.md") });
		// `src/util/` is a folded subdirectory chain under `pkg/ai/`, not the root.
		expect(ctx[3]).toMatchObject({ kind: "dir", headerPath: path.join(REPO_ROOT, "pkg", "ai", "src", "util") });
		expect(ctx[4]).toMatchObject({
			kind: "file",
			headerPath: path.join(REPO_ROOT, "pkg", "ai", "src", "util", "x.ts"),
		});
		expect(ctx[5]).toMatchObject({
			kind: "content",
			filePath: path.join(REPO_ROOT, "pkg", "ai", "src", "util", "x.ts"),
		});
	});

	it("keeps an absolute folded prefix instead of joining it onto the search base", () => {
		const ctx = classifyGroupedLines([`# ${toGroupedHeaderPath(OUTSIDE_DIR)}/`, "## file.txt"], REPO_ROOT);
		expect(ctx[0]).toMatchObject({ kind: "dir", headerPath: OUTSIDE_DIR });
		expect(ctx[1]).toMatchObject({ kind: "file", headerPath: path.join(OUTSIDE_DIR, "file.txt") });
	});

	it("links body lines before any header to the single-file search base", () => {
		const searchBase = path.join(REPO_ROOT, "file.ts");
		const ctx = classifyGroupedLines(["*7│needle();"], searchBase);
		expect(ctx[0]).toMatchObject({ kind: "content", filePath: searchBase });
	});

	it("flags url-like headers for caller-side resolution without a filesystem path", () => {
		const ctx = classifyGroupedLines(["# omp://docs/", "  body"], REPO_ROOT);
		expect(ctx[0]).toMatchObject({ kind: "file", isUrl: true });
		expect(ctx[0]?.headerPath).toBeUndefined();
	});
});

describe("groupLineIndicesByBlank", () => {
	it("breaks on blank-line runs and keeps original indices", () => {
		expect(groupLineIndicesByBlank(["a", "b", "", "", "c"])).toEqual([[0, 1], [4]]);
	});

	it("returns a single group of non-empty lines when no blanks are present", () => {
		expect(groupLineIndicesByBlank(["a", "b", "c"])).toEqual([[0, 1, 2]]);
	});
});

describe("structured presentation output", () => {
	it("produces files, directories, matches, coordinates, notices alongside model text", () => {
		const out = formatGroupedFiles(["src/index.ts", "src/util/helper.ts"], file => ({
			modelLines: file.endsWith("index.ts")
				? ["*10│export const foo = 1;"]
				: [" 5│const bar = 2;", "*6│return bar;"],
			headerSuffix: " (tag)",
		}));

		expect(out.structure).toBeDefined();
		expect(out.files).toHaveLength(2);
		expect(out.directories.length).toBeGreaterThanOrEqual(1);
		expect(out.matches.length).toBe(3);
		expect(out.coordinates.length).toBe(3);

		const firstFile = out.files.find(f => f.path === "src/index.ts");
		expect(firstFile).toBeDefined();
		expect(firstFile?.matches).toHaveLength(1);
		expect(firstFile?.matches[0]).toMatchObject({
			filePath: "src/index.ts",
			line: 10,
			isMatch: true,
			text: "export const foo = 1;",
		});
		expect(firstFile?.coordinates).toEqual([{ filePath: "src/index.ts", line: 10 }]);

		const secondFile = out.files.find(f => f.path === "src/util/helper.ts");
		expect(secondFile).toBeDefined();
		expect(secondFile?.matches).toHaveLength(2);
		expect(secondFile?.matches[0]).toMatchObject({ line: 5, isMatch: false });
		expect(secondFile?.matches[1]).toMatchObject({ line: 6, isMatch: true });
	});

	it("parses grouped lines back into structured format with parseGroupedOutputToStructure", () => {
		const lines = ["# src/", "## test.ts", "*42│const answer = 42;", " 43│return answer;", "Result limit reached"];
		const parsed = parseGroupedOutputToStructure(lines, REPO_ROOT);

		expect(parsed.directories).toHaveLength(1);
		expect(parsed.directories[0]?.name).toBe("src");
		expect(parsed.files).toHaveLength(1);
		expect(parsed.files[0]?.name).toBe("test.ts");
		expect(parsed.matches).toHaveLength(2);
		expect(parsed.matches[0]).toMatchObject({ line: 42, isMatch: true, text: "const answer = 42;" });
		expect(parsed.matches[1]).toMatchObject({ line: 43, isMatch: false, text: "return answer;" });
		expect(parsed.coordinates).toEqual([
			{ filePath: path.join(REPO_ROOT, "src", "test.ts"), line: 42 },
			{ filePath: path.join(REPO_ROOT, "src", "test.ts"), line: 43 },
		]);
		expect(parsed.notices).toContain("Result limit reached");
	});
});
