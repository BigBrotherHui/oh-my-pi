import { describe, expect, it } from "bun:test";
import { createCopySelectorController } from "../src/overlays/copy-selector";
import type { TranscriptEntryLike } from "../src/chat/transcript-entry";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";

function userEntry(id: string, content: string): TranscriptEntryLike {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content, timestamp: 0 },
	};
}

function controllerOver(
	entries: TranscriptEntryLike[],
	picks: Array<{ content: string; label: string }>,
	opens: Array<{ href: string; label: string }> = [],
	onCancel = (): void => {},
) {
	return createCopySelectorController(entries, {
		onPick: (content, label) => picks.push({ content, label }),
		onOpen: (href, label) => opens.push({ href, label }),
		onCancel,
	});
}

describe("copy selector", () => {
	it("copies the selected transcript request", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const controller = controllerOver([userEntry("u1", "Copy this")], picks);

		controller.copy();

		expect(picks).toEqual([{ content: "Copy this", label: "user message" }]);
	});

	it("navigates transcript targets without passing either boundary", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const controller = controllerOver([userEntry("u1", "first"), userEntry("u2", "second")], picks);

		controller.handleInput(DOWN);
		expect(controller.selectedIndex()).toBe(1);
		controller.handleInput(UP);
		controller.handleInput(UP);
		expect(controller.selectedIndex()).toBe(0);
		controller.handleInput(ENTER);

		expect(picks).toEqual([{ content: "first", label: "user message" }]);
	});

	it("descends into markdown blocks and copies their unfenced source", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const controller = controllerOver([userEntry("u1", "```ts\nconst answer = 42;\n```")], picks);

		controller.handleInput(RIGHT);
		expect(controller.inBlocks()).toBe(true);
		controller.handleInput(ENTER);

		expect(picks).toEqual([{ content: "const answer = 42;", label: "ts code" }]);
	});

	it("opens a link block and ascends before Escape dismisses", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const opens: Array<{ href: string; label: string }> = [];
		let cancelled = 0;
		const controller = controllerOver(
			[userEntry("u1", "[the PR](https://example.com/pr/1)")],
			picks,
			opens,
			() => cancelled++,
		);

		controller.handleInput(RIGHT);
		controller.handleInput("o");
		controller.handleInput(ESC);
		expect(controller.inBlocks()).toBe(false);
		controller.handleInput(ESC);
		controller.handleInput(LEFT);

		expect(opens).toEqual([{ href: "https://example.com/pr/1", label: "link · the PR" }]);
		expect(picks).toEqual([]);
		expect(cancelled).toBe(1);
	});
});
