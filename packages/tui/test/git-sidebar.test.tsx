import { describe, expect, test } from "bun:test";
import { createSignal } from "../src/reactive";
import { dispatchMouse, HostMouseEvent } from "../src/host/input";
import { Sidebar, type SidebarAction } from "../src/apps/git/sidebar";
import type { ChangedFile, GitViewState, HeadCommit } from "../src/apps/git/state";
import { mountForTest, type TestRoot } from "../src/testing";
import "../src/host/elements/box";
import "../src/host/elements/editor";
import "../src/host/elements/hr";
import "../src/host/elements/row";
import "../src/host/elements/scroll";
import "../src/host/elements/path";
import "../src/host/elements/span";
import "../src/host/elements/stack";
import "../src/host/elements/text";

const files: readonly ChangedFile[] = [
	{ path: "a/one.txt", kind: "untracked", area: "unstaged" },
	{ path: "a/two.txt", kind: "untracked", area: "unstaged" },
	{ path: "b/three.txt", kind: "untracked", area: "unstaged" },
];

function dirtyModel(): GitViewState {
	return { cwd: "/repo", branch: "main", clean: false, unstaged: files, staged: [], headCommit: null };
}

function cleanModel(headCommit: HeadCommit): GitViewState {
	return { cwd: "/repo", branch: "main", clean: true, unstaged: [], staged: [], headCommit };
}

function mountedSidebar(model: GitViewState): {
	readonly actions: SidebarAction[];
	readonly sidebar: Sidebar;
	readonly root: TestRoot;
} {
	const actions: SidebarAction[] = [];
	const [revision, setRevision] = createSignal(0);
	const sidebar = new Sidebar({
		model,
		avatars: { get: () => null },
		onSelectFile: () => {},
		onAction: action => actions.push(action),
		onFocusDiff: () => {},
		requestRender: () => setRevision(value => value + 1),
	});
	sidebar.reconcile();
	const root = mountForTest(
		() => {
			revision();
			return sidebar.viewNode();
		},
		{ width: 44, height: 20 },
	);
	return { actions, sidebar, root };
}

describe("git sidebar", () => {
	test("stages every descendant from a tree directory without collapsing the file list", () => {
		const mounted = mountedSidebar(dirtyModel());
		try {
			mounted.sidebar.handleInput("j");
			expect(mounted.sidebar.selected).toEqual({ kind: "dir", key: "unstaged:a" });
			mounted.sidebar.handleInput(" ");
			expect(mounted.actions).toEqual([
				{
					type: "stage",
					selection: {
						files: [files[0], files[1]],
						label: "a/",
					},
				},
			]);
			expect(mounted.root.text().join("\n")).toContain("one.txt");
		} finally {
			mounted.root.dispose();
		}
	});

	test("wand opens a prompt, submits selective staging, and clears the draft", () => {
		const mounted = mountedSidebar(dirtyModel());
		try {
			mounted.sidebar.setFocused(true);
			const rows = mounted.root.text();
			const headerRow = rows.findIndex(row => row.includes("Unstaged Files"));
			const header = rows[headerRow] ?? "";
			const wandColumn = header.indexOf(header.includes("✦") ? "✦" : "");
			expect(headerRow).toBeGreaterThanOrEqual(0);
			expect(wandColumn).toBeGreaterThan(0);
			dispatchMouse(
				mounted.root.root,
				new HostMouseEvent({ row: headerRow, col: wandColumn, action: "down", button: 0 }),
			);
			mounted.root.flush();
			expect(mounted.sidebar.editing).toBe(true);
			for (const character of "comment changes") mounted.sidebar.handleInput(character);
			mounted.sidebar.handleInput("\r");
			expect(mounted.actions).toEqual([{ type: "stage-ai", prompt: "comment changes" }]);
			expect(mounted.sidebar.aiInput.getValue()).toBe("");
			expect(mounted.root.text().join("\n")).not.toContain("What should we stage?");
		} finally {
			mounted.root.dispose();
		}
	});

	test("clean repositories retain commit metadata, avatar fallback space, and changed-file navigation", () => {
		const head: HeadCommit = {
			sha: "0123456789abcdef",
			shortSha: "01234567",
			subject: "restore complete sidebar",
			body: "Includes author metadata and changed files.",
			authorName: "Ada Lovelace",
			authorEmail: "ada@example.com",
			authorDate: "2025-01-02T03:04:05.000Z",
			parents: ["abcdef0123456789"],
			files,
			filesLoaded: true,
		};
		const mounted = mountedSidebar(cleanModel(head));
		try {
			const rendered = mounted.root.text().join("\n");
			expect(rendered).toContain("restore complete sidebar");
			expect(rendered).toContain("Ada Lovelace");
			expect(rendered).toContain("parent: abcdef01");
			mounted.sidebar.handleInput("j");
			expect(mounted.sidebar.selectedFile?.path).toBe("a/one.txt");
		} finally {
			mounted.root.dispose();
		}
	});
});
