import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { TranscriptView } from "@oh-my-pi/pi-tui/chat/transcript-store";
import { findTranscriptController } from "@oh-my-pi/pi-tui/compositor/transcript";
import { createPaintContext } from "@oh-my-pi/pi-tui/host/paint";
import { resolveStyle } from "@oh-my-pi/pi-tui/style/cascade";
import { mountForTest } from "@oh-my-pi/pi-tui/testing";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 1,
	};
}

function transcriptHarness() {
	const ctx = createInteractiveModeContext();
	const events = new EventController(ctx);
	ctx.eventController = events;
	const helpers = new UiHelpers(ctx);
	const root = mountForTest(() => TranscriptView({ store: ctx.chatContainer }), { width: 80, height: 6 });
	return {
		events,
		helpers,
		history(mode: "retire" | "replay"): string {
			root.flush();
			const controller = findTranscriptController(root.root.node);
			if (!controller) throw new Error("Expected transcript controller");
			controller.setCapacity(4);
			root.flush();
			const paint = createPaintContext(root.root, node => resolveStyle(node, { theme: root.root.theme }), {
				now: 0,
			});
			if (mode === "replay") controller.beginReplay();
			const batch =
				mode === "replay" ? controller.peekReplayBatch(80, paint) : controller.peekFinalizedBatch(80, 4, paint);
			if (!batch) return "";
			controller.acknowledgeHistory(batch.id);
			return batch.rows.join("\n");
		},
		dispose() {
			events.dispose();
			root.dispose();
		},
	};
}

const continuation = assistant([
	{ type: "text", text: Array.from({ length: 8 }, (_, index) => `later-${index}`).join("\n\n") },
]);

describe("completed output retirement", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});
	afterEach(() => resetSettingsForTest());

	for (const ingress of ["live", "replay"]) {
		it(`${ingress} background launches release later output while completion remains routable`, async () => {
			const harness = transcriptHarness();
			const message = assistant([
				{ type: "toolCall", id: "background", name: "bash", arguments: { command: "long-job" } },
			]);
			try {
				if (ingress === "live") {
					await harness.events.handleEvent({ type: "message_end", message });
					await harness.events.handleEvent({
						type: "tool_execution_start",
						toolCallId: "background",
						toolName: "bash",
						args: { command: "long-job" },
					});
					await harness.events.handleEvent({
						type: "tool_execution_end",
						toolCallId: "background",
						toolName: "bash",
						result: { content: [{ type: "text", text: "queued-job" }], details: { async: { state: "running" } } },
						isError: false,
					});
				} else {
					harness.helpers.renderSessionContext({
						messages: [
							message,
							{
								role: "toolResult",
								toolCallId: "background",
								toolName: "bash",
								content: [{ type: "text", text: "queued-job" }],
								details: { async: { state: "running" } },
								isError: false,
								timestamp: 2,
							},
						],
						models: {},
						injectedTtsrRules: [],
						mode: "none",
					});
				}
				harness.helpers.addMessageToChat(continuation);
				const history = harness.history("retire");
				expect(history).toContain("queued-job");
				expect(history).toContain("later-7");

				await harness.events.handleEvent({
					type: "tool_execution_update",
					toolCallId: "background",
					toolName: "bash",
					args: { command: "long-job" },
					partialResult: {
						content: [{ type: "text", text: "halfway-job" }],
						details: { async: { state: "running" } },
					},
				});
				expect(harness.history("replay")).toContain("halfway-job");
				await harness.events.handleEvent({
					type: "tool_execution_end",
					toolCallId: "background",
					toolName: "bash",
					result: {
						content: [{ type: "text", text: "completed-job" }],
						details: { async: { state: "completed" } },
					},
					isError: false,
				});
				const completed = harness.history("replay");
				expect(completed).toContain("completed-job");
				expect(completed).not.toContain("halfway-job");
			} finally {
				harness.dispose();
			}
		});
	}

	it("publishes streaming thinking outside the render owner and retires completed tools before the next response ends", async () => {
		const harness = transcriptHarness();
		const history: string[] = [];
		let message = assistant([]);
		try {
			for (let count = 4; count <= 16; count += 4) {
				message = assistant([
					{
						type: "thinking",
						thinking: `${Array.from({ length: count }, (_, index) => `thought-${index}.`).join("\n\n")}\n\nStill considering`,
					},
				]);
				await harness.events.handleEvent({
					type: "message_update",
					message,
					assistantMessageEvent: { type: "start", partial: message },
				});
				history.push(harness.history("retire"));
			}
			expect(history.join("\n")).toContain("thought-0.");
			expect(history.join("\n")).toContain("thought-12.");
			expect(history.join("\n")).not.toContain("Still considering");

			message = assistant([
				...message.content,
				{ type: "toolCall", id: "streamed-tool", name: "bash", arguments: { command: "printf retained-result" } },
			]);
			await harness.events.handleEvent({ type: "message_end", message });
			history.push(harness.history("retire"));
			await harness.events.handleEvent({
				type: "tool_execution_start",
				toolCallId: "streamed-tool",
				toolName: "bash",
				args: { command: "printf retained-result" },
			});
			await harness.events.handleEvent({
				type: "tool_execution_end",
				toolCallId: "streamed-tool",
				toolName: "bash",
				result: { content: [{ type: "text", text: "retained-result" }] },
				isError: false,
			});
			await harness.events.handleEvent({
				type: "message_update",
				message: continuation,
				assistantMessageEvent: { type: "start", partial: continuation },
			});
			history.push(harness.history("retire"));
			const retired = history.join("\n");
			expect(retired).toContain("retained-result");
			for (let index = 0; index < 16; index++) expect(retired.split(`thought-${index}.`)).toHaveLength(2);
		} finally {
			harness.dispose();
		}
	});

	it("retires finished prose while the following tool call is still streaming", async () => {
		const harness = transcriptHarness();
		const message = assistant([
			...continuation.content,
			{ type: "toolCall", id: "receiving", name: "bash", arguments: { command: "still-receiving" } },
		]);
		try {
			await harness.events.handleEvent({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "start", partial: message },
			});
			const history = harness.history("retire");
			expect(history).toContain("later-7");
			expect(history).not.toContain("still-receiving");
		} finally {
			harness.dispose();
		}
	});

	it("retires a read run after its last pending call returns, without waiting for later prose", async () => {
		const harness = transcriptHarness();
		try {
			await harness.events.handleEvent({
				type: "tool_execution_start",
				toolCallId: "read",
				toolName: "read",
				args: { path: "src/finished-read.ts" },
			});
			await harness.events.handleEvent({
				type: "tool_execution_start",
				toolCallId: "read-pending",
				toolName: "read",
				args: { path: "src/last-read.ts" },
			});
			await harness.events.handleEvent({
				type: "tool_execution_end",
				toolCallId: "read",
				toolName: "read",
				result: { content: [{ type: "text", text: "read body" }] },
				isError: false,
			});
			await harness.events.handleEvent({
				type: "message_update",
				message: continuation,
				assistantMessageEvent: { type: "start", partial: continuation },
			});
			expect(harness.history("retire")).toBe("");
			await harness.events.handleEvent({
				type: "tool_execution_end",
				toolCallId: "read-pending",
				toolName: "read",
				result: { content: [{ type: "text", text: "last body" }] },
				isError: false,
			});
			const history = harness.history("retire");
			expect(history).toContain("src/finished-read.ts");
			expect(history).toContain("src/last-read.ts");
		} finally {
			harness.dispose();
		}
	});
});
