import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createTreeSelectorController, type TreeSelectorNode } from "@oh-my-pi/pi-tui/overlays/tree-selector";

const userEntry = {
	id: "u1",
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	type: "message" as const,
	message: { role: "user", content: "start", timestamp: 0 } as AgentMessage,
};

const responseEntry = {
	id: "r1",
	parentId: "u1",
	timestamp: "2026-01-01T00:00:01.000Z",
	type: "message" as const,
	message: { role: "assistant", content: "response", timestamp: 1 } as unknown as AgentMessage,
};

const tree: TreeSelectorNode[] = [{ entry: userEntry, children: [{ entry: responseEntry, children: [] }] }];

function controller(records: Array<{ entryId: string; summarize: boolean }>) {
	return createTreeSelectorController(
		tree,
		(entryId, options) => records.push({ entryId, summarize: options.summarize }),
		() => {},
	);
}

describe("tree selector Shift+Enter fallback (issue #8821)", () => {
	it("treats a bare LF as Shift+Enter and summarizes before switching", () => {
		const records: Array<{ entryId: string; summarize: boolean }> = [];
		const selector = controller(records);
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(records).toEqual([{ entryId: responseEntry.id, summarize: true }]);
	});

	it("keeps CR as a plain switch", () => {
		const records: Array<{ entryId: string; summarize: boolean }> = [];
		const selector = controller(records);
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		expect(records).toEqual([{ entryId: responseEntry.id, summarize: false }]);
	});

	it("recognizes kitty and legacy Shift+Enter encodings", () => {
		for (const input of ["\x1b[13;2u", "\x1b[13;2~"]) {
			const records: Array<{ entryId: string; summarize: boolean }> = [];
			const selector = controller(records);
			selector.handleInput("\x1b[B");
			selector.handleInput(input);
			expect(records).toEqual([{ entryId: responseEntry.id, summarize: true }]);
		}
	});
});
