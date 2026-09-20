import { describe, expect, it } from "bun:test";
import { createRewindSelectorController } from "../src/overlays/rewind-selector";
import type { TranscriptEntryLike } from "../src/chat/transcript-entry";
import type { TUI } from "../src/tui";

function userEntry(id: string, parentId: string | null, content: string): TranscriptEntryLike {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content, timestamp: 0 },
	};
}

function hiddenNotice(id: string, parentId: string): TranscriptEntryLike {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: "test-notice",
		content: "invisible",
		display: false,
	};
}

function selector(
	entries: TranscriptEntryLike[],
	onSelect: (id: string) => void,
	onCancel = () => {},
	siblingPaths?: (entryId: string) => { rootId: string; entries: TranscriptEntryLike[] }[],
) {
	return createRewindSelectorController(entries, {
		ui: {} as TUI,
		siblingPaths,
		onSelect,
		onCancel,
	});
}

describe("rewind selector", () => {
	it("starts at the newest visible target and uses Left/Right to jump between user turns", () => {
		const selected: string[] = [];
		const controller = selector(
			[
				userEntry("u1", null, "first"),
				userEntry("u2", "u1", "second"),
				hiddenNotice("notice", "u2"),
				userEntry("u3", "notice", "third"),
			],
			id => selected.push(id),
		);

		controller.select();
		controller.handleInput("\x1b[D");
		controller.select();
		controller.handleInput("\x1b[C");
		controller.select();

		expect(controller.targetCount()).toBe(3);
		expect(selected).toEqual(["u3", "u2", "u3"]);
	});

	it("enters a sibling path with Right, then restores the current path with Left", () => {
		const selected: string[] = [];
		const controller = selector(
			[userEntry("u1", null, "first"), userEntry("u2", "u1", "current")],
			id => selected.push(id),
			() => {},
			entryId => (entryId === "u2" ? [{ rootId: "u2b", entries: [userEntry("u2b", "u1", "alternate")] }] : []),
		);

		controller.handleInput("\x1b[C");
		controller.select();
		controller.handleInput("\x1b[D");
		controller.select();
		controller.dispose();

		expect(selected).toEqual(["u2b", "u2"]);
	});

	it("cancels once and ignores input after disposal", () => {
		const selected: string[] = [];
		let cancelled = 0;
		const controller = selector(
			[userEntry("u1", null, "first")],
			id => selected.push(id),
			() => {
				cancelled++;
			},
		);

		controller.handleInput("\x1b");
		controller.dispose();
		controller.select();
		controller.handleInput("\r");
		controller.cancel();

		expect(cancelled).toBe(1);
		expect(selected).toEqual([]);
	});

	it("bounds wheel scrolling", () => {
		const controller = createRewindSelectorController([userEntry("u1", null, "first")], {
			ui: {} as TUI,
			onSelect() {},
			onCancel() {},
		});
		controller.setViewport({ offset: 0, totalRows: 5, height: 3, width: 80 });

		controller.handleInput("\x1b[<65;1;1M");
		controller.handleInput("\x1b[<65;1;1M");

		expect(controller.scrollOffset()).toBe(2);
	});
});
