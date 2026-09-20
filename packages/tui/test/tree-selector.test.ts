import { describe, expect, it } from "bun:test";
import { createTreeSelectorController, type TreeSelectorNode } from "../src/overlays/tree-selector";

function userNode(id: string, parentId: string | null, content: string): TreeSelectorNode {
	return {
		entry: {
			type: "message",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content, timestamp: 1_767_225_600_000 },
		},
		children: [],
	};
}

describe("tree selector", () => {
	it("puts the active branch first, keeps hidden metadata out of the default view, and finds it in all mode", () => {
		const root = userNode("root", null, "Start");
		const active = userNode("active", "root", "Continue");
		const title: TreeSelectorNode = {
			entry: { type: "title_change", id: "title", parentId: "root", title: "Archived work" },
			children: [],
		};
		root.children.push(title, active);

		const selector = createTreeSelectorController(
			[root],
			() => {},
			() => {},
			"default",
			{ currentLeafId: active.entry.id },
		);
		expect(selector.rows().map(row => row.key)).toEqual(["root", "active"]);
		expect(selector.selectedIndex()).toBe(1);

		const all = createTreeSelectorController(
			[root],
			() => {},
			() => {},
			"all",
			{ currentLeafId: active.entry.id },
		);
		expect(all.rows().map(row => row.key)).toEqual(["root", "active", "title"]);
		for (const key of "arch") all.handleInput(key);
		expect(all.rows().map(row => row.key)).toEqual(["title"]);
	});

	it("wraps ordinary navigation and sends Shift+Enter selection as summarize", () => {
		const root = userNode("root", null, "Start");
		const child = userNode("child", "root", "Continue");
		root.children.push(child);
		const selected: Array<{ id: string; summarize: boolean }> = [];
		const selector = createTreeSelectorController(
			[root],
			(id, options) => selected.push({ id, summarize: options.summarize }),
			() => {},
			"default",
			{ currentLeafId: child.entry.id },
		);

		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(selected).toEqual([{ id: root.entry.id, summarize: true }]);
	});

	it("edits and persists labels without leaving the selector", () => {
		const root = userNode("root", null, "Request");
		const labels: Array<{ id: string; label: string | undefined }> = [];
		const selector = createTreeSelectorController(
			[root],
			() => {},
			() => {},
			"default",
			{
				currentLeafId: root.entry.id,
				onLabelChange: (id, label) => labels.push({ id, label }),
			},
		);

		selector.handleInput("L");
		expect(selector.editing()?.entryId).toBe(root.entry.id);
		selector.setDraft("checkpoint");
		selector.submitLabel();
		expect(root.label).toBe("checkpoint");
		expect(labels).toEqual([{ id: root.entry.id, label: "checkpoint" }]);
	});
});
