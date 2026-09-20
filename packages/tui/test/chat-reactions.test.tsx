import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { describe, expect, test } from "bun:test";
import { AssistantMessageView } from "../src/chat/assistant-message";
import { ChatTranscriptBuilder } from "../src/chat/chat-transcript-builder";
import { createReactionTarget, splitReaction } from "../src/chat/reaction";
import type { TranscriptEntryLike } from "../src/chat/transcript-entry";
import { UserMessageView } from "../src/chat/user-message";
import { createSignal } from "../src/reactive";
import { mountForTest } from "../src/testing";
import { cellGrid } from "./cell-grid";
import "../src/host/elements/box";
import "../src/host/elements/markdown";
import "../src/host/elements/rail";
import "../src/host/elements/raw";
import "../src/host/elements/row";
import "../src/host/elements/stack";
import "../src/host/elements/text";
import "../src/host/elements/transcript";
import "../src/host/elements/transcript-block";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "reaction-test",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("chat reactions", () => {
	test("keeps the original compact user-bubble rows while control zones stay inline", () => {
		const root = mountForTest(() => <UserMessageView text="hi" />, { width: 20 });
		try {
			const rows = root.text();
			expect(rows).toHaveLength(3);
			expect(rows[1]).toContain("hi");
			expect(root.rows()).toHaveLength(3);
		} finally {
			root.dispose();
		}
	});

	test("fills every cell around row-leading OSC 133 boundaries", () => {
		for (const width of [5, 120]) {
			const root = mountForTest(() => <UserMessageView text={width === 5 ? "one two three" : "x"} reaction="👍" />, {
				width,
			});
			try {
				const rows = root.rows();
				if (width === 5) expect(rows.length).toBeGreaterThan(3);
				expect(rows[0]).toStartWith("\x1b]133;A\x07");
				expect(rows[0]!.slice("\x1b]133;A\x07".length)).not.toStartWith("\x1b[0m");
				for (const row of rows.slice(1, -1)) expect(row).not.toContain("\x1b]133;");
				const last = rows.at(-1)!;
				expect(last).toStartWith("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07");
				expect(last.slice("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07".length)).not.toStartWith("\x1b[0m");

				const cells = cellGrid(rows, width);
				const background = cells[1]?.[0]?.bg;
				expect(background).not.toBeNull();
				for (const row of cells) for (const cell of row) expect(cell.bg).toEqual(background);
			} finally {
				root.dispose();
			}
		}
	});

	test("updates the existing top padding row when a reaction arrives", () => {
		const target = createReactionTarget();
		const root = mountForTest(() => <UserMessageView text="hi" reaction={target} />, { width: 20 });
		try {
			expect(root.text()).toHaveLength(3);
			target.setReaction("👍");
			const rows = root.text();
			expect(rows).toHaveLength(3);
			expect(rows[0]).toContain("👍");
			expect(rows[1]).toContain("hi");
		} finally {
			root.dispose();
		}
	});

	test("withholds a partial emoji stream then lifts the completed reaction from prose", () => {
		const target = createReactionTarget();
		const [message, setMessage] = createSignal(assistant("👨‍"));
		const [transient, setTransient] = createSignal(true);
		const root = mountForTest(() => (
			<stack>
				<UserMessageView text="hi" reaction={target} />
				<AssistantMessageView message={message} transient={transient} reactionTarget={target} expanded={false} />
			</stack>
		));
		try {
			expect(root.text().join("\n")).not.toContain("👨");
			expect(target.reaction()).toBeUndefined();
			setMessage(assistant("👨‍👩‍👧\nReady"));
			setTransient(false);
			const rows = root.text();
			expect(target.reaction()).toBe("👨‍👩‍👧");
			expect(rows.find(row => row.includes("Ready"))).not.toContain("👨‍👩‍👧");
		} finally {
			root.dispose();
		}
	});

	test("derives the same reaction during transcript replay", () => {
		const builder = new ChatTranscriptBuilder();
		const entries: TranscriptEntryLike[] = [
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "hi" },
			} as TranscriptEntryLike,
			{
				type: "message",
				id: "assistant",
				parentId: "user",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: assistant("👍\nReady"),
			} as TranscriptEntryLike,
		];
		builder.rebuild(entries);
		const root = mountForTest(builder.view);
		try {
			const rows = root.text();
			expect(rows[0]).toContain("👍");
			expect(rows.find(row => row.includes("Ready"))).not.toContain("👍");
		} finally {
			root.dispose();
		}
	});

	test("recognizes complete reactions and preserves unresolved non-emoji text", () => {
		expect(splitReaction("👍\nReady")).toMatchObject({ emoji: "👍", body: "Ready", pending: false });
		expect(splitReaction("x")).toEqual({ body: "x", pending: false });
	});
});
