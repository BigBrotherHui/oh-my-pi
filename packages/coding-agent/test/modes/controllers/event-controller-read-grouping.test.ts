import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { TranscriptView } from "@oh-my-pi/pi-tui/chat/transcript-store";
import { TranscriptController } from "@oh-my-pi/pi-tui/compositor/transcript";
import { createPaintContext } from "@oh-my-pi/pi-tui/host/paint";
import { resolveStyle } from "@oh-my-pi/pi-tui/style/cascade";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { mountForTest } from "@oh-my-pi/pi-tui/testing";
import "@oh-my-pi/pi-tui/host/elements/badge";
import "@oh-my-pi/pi-tui/host/elements/box";
import "@oh-my-pi/pi-tui/host/elements/code";
import "@oh-my-pi/pi-tui/host/elements/frame";
import "@oh-my-pi/pi-tui/host/elements/link";
import "@oh-my-pi/pi-tui/host/elements/preview";
import "@oh-my-pi/pi-tui/host/elements/row";
import "@oh-my-pi/pi-tui/host/elements/span";
import "@oh-my-pi/pi-tui/host/elements/stack";
import "@oh-my-pi/pi-tui/host/elements/status";
import "@oh-my-pi/pi-tui/host/elements/text";
import "@oh-my-pi/pi-tui/host/elements/transcript";
import "@oh-my-pi/pi-tui/host/elements/transcript-block";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

const READ_BODY_SENTINEL = "READ_GROUP_BODY_MUST_STAY_HIDDEN";

function assistantWithToolCalls(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

describe("reactive read groups", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("replays adjacent reads as one compact group and breaks at a mixed tool", () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = message => helpers.addMessageToChat(message);
		const root = mountForTest(() => TranscriptView({ store: ctx.chatContainer }), { width: 100 });
		try {
			helpers.addMessageToChat(
				assistantWithToolCalls(
					[
						{ type: "toolCall", id: "read-one", name: "read", arguments: { path: "src/one.ts" } },
						{ type: "toolCall", id: "read-two", name: "read", arguments: { path: "src/two.ts:4-8" } },
						{ type: "toolCall", id: "bash-after", name: "bash", arguments: { command: "pwd" } },
						{ type: "toolCall", id: "read-after", name: "read", arguments: { path: "src/after.ts" } },
					],
					1,
				),
			);
			helpers.addMessageToChat({
				role: "toolResult",
				toolCallId: "read-one",
				toolName: "read",
				timestamp: 2,
				content: [{ type: "text", text: READ_BODY_SENTINEL }],
				isError: false,
			});
			helpers.addMessageToChat({
				role: "toolResult",
				toolCallId: "read-two",
				toolName: "read",
				timestamp: 3,
				content: [{ type: "text", text: READ_BODY_SENTINEL }],
				isError: false,
			});
			helpers.addMessageToChat({
				role: "toolResult",
				toolCallId: "read-after",
				toolName: "read",
				timestamp: 4,
				content: [{ type: "text", text: READ_BODY_SENTINEL }],
				isError: false,
			});

			const transcript = root.text().join("\n");
			expect(transcript).toContain("Read (2)");
			expect(transcript).toContain("src/one.ts");
			expect(transcript).toContain("src/two.ts:4-8");
			expect(transcript).toContain("src/after.ts");
			expect(transcript).not.toContain(READ_BODY_SENTINEL);
			expect(transcript.indexOf("src/two.ts:4-8")).toBeLessThan(transcript.indexOf("pwd"));
			expect(transcript.indexOf("pwd")).toBeLessThan(transcript.indexOf("src/after.ts"));
		} finally {
			root.dispose();
		}
	});

	it("retires completed reads under pressure and starts a fresh run for later reads", () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);
		const root = mountForTest(() => TranscriptView({ store: ctx.chatContainer }), { width: 100 });
		try {
			helpers.addMessageToChat(
				assistantWithToolCalls(
					[{ type: "toolCall", id: "first", name: "read", arguments: { path: "src/first.ts" } }],
					1,
				),
			);
			helpers.addMessageToChat({
				role: "toolResult",
				toolCallId: "first",
				toolName: "read",
				timestamp: 2,
				content: [{ type: "text", text: READ_BODY_SENTINEL }],
				isError: false,
			});
			expect(root.text().join("\n")).toContain("src/first.ts");
			root.flush();
			const transcript = root.root.node.children[0];
			if (transcript?.kind !== "element" || !(transcript.state instanceof TranscriptController)) {
				throw new Error("Expected transcript controller");
			}
			const context = createPaintContext(root.root, node => resolveStyle(node, { theme: root.root.theme }), {
				now: 0,
			});
			const batch = transcript.state.peekFinalizedBatch(100, 0, context);
			expect(batch?.rows.join("\n")).toContain("src/first.ts");
			if (batch) transcript.state.acknowledgeHistory(batch.id);

			helpers.addMessageToChat(
				assistantWithToolCalls(
					[{ type: "toolCall", id: "second", name: "read", arguments: { path: "src/second.ts" } }],
					3,
				),
			);
			helpers.addMessageToChat({
				role: "toolResult",
				toolCallId: "second",
				toolName: "read",
				timestamp: 4,
				content: [{ type: "text", text: READ_BODY_SENTINEL }],
				isError: false,
			});
			const joined = root.text().join("\n");
			expect(joined).not.toContain("src/first.ts");
			expect(joined).toContain("src/second.ts");
		} finally {
			root.dispose();
		}
	});

	it("shows no success checkmark and spaces failed entries within the joined tree", async () => {
		const ctx = createInteractiveModeContext();
		const events = new EventController(ctx);
		const root = mountForTest(() => TranscriptView({ store: ctx.chatContainer }), { width: 100 });
		try {
			await events.handleEvent({
				type: "tool_execution_start",
				toolCallId: "success",
				toolName: "read",
				args: { path: "src/success.ts" },
			});
			await events.handleEvent({
				type: "tool_execution_end",
				toolCallId: "success",
				toolName: "read",
				result: { content: [{ type: "text", text: READ_BODY_SENTINEL }] },
				isError: false,
			});
			expect(
				root
					.text()
					.filter(line => line.trim())
					.map(line => line.trim()),
			).toEqual([`${theme.format.bullet} Read src/success.ts`]);

			await events.handleEvent({
				type: "tool_execution_start",
				toolCallId: "failed",
				toolName: "read",
				args: { path: "src/missing.ts" },
			});
			await events.handleEvent({
				type: "tool_execution_end",
				toolCallId: "failed",
				toolName: "read",
				result: { content: [{ type: "text", text: "File missing" }] },
				isError: true,
			});
			const tree = root
				.text()
				.filter(line => line.trim())
				.map(line => line.trim());
			expect(tree).toEqual([
				`${theme.format.bullet} Read (2)`,
				`${theme.tree.branch} src/success.ts`,
				`${theme.tree.last} ${theme.status.error} src/missing.ts`,
			]);
		} finally {
			events.dispose();
			root.dispose();
		}
	});

	it("keeps live read results compact until the explicit preview preference is enabled", async () => {
		const ctx = createInteractiveModeContext();
		const events = new EventController(ctx);
		const root = mountForTest(() => TranscriptView({ store: ctx.chatContainer }), { width: 100 });
		try {
			await events.handleEvent({
				type: "tool_execution_start",
				toolCallId: "read-live",
				toolName: "read",
				args: { path: "src/live.ts" },
			});
			await events.handleEvent({
				type: "tool_execution_end",
				toolCallId: "read-live",
				toolName: "read",
				result: { content: [{ type: "text", text: READ_BODY_SENTINEL }] },
				isError: false,
			});
			expect(root.text().join("\n")).toContain("src/live.ts");
			expect(root.text().join("\n")).not.toContain(READ_BODY_SENTINEL);

			await events.handleEvent({
				type: "tool_execution_start",
				toolCallId: "boundary",
				toolName: "bash",
				args: { command: "pwd" },
			});
			await events.handleEvent({
				type: "tool_execution_end",
				toolCallId: "boundary",
				toolName: "bash",
				result: { content: [{ type: "text", text: "pwd" }] },
				isError: false,
			});
			ctx.settings.override("read.toolResultPreview", true);
			await events.handleEvent({
				type: "tool_execution_start",
				toolCallId: "read-preview",
				toolName: "read",
				args: { path: "src/preview.ts" },
			});
			await events.handleEvent({
				type: "tool_execution_end",
				toolCallId: "read-preview",
				toolName: "read",
				result: { content: [{ type: "text", text: READ_BODY_SENTINEL }] },
				isError: false,
			});
			expect(root.text().join("\n")).toContain(READ_BODY_SENTINEL);
		} finally {
			events.dispose();
			root.dispose();
		}
	});
});
