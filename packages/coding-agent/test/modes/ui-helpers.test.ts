import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { TranscriptView } from "@oh-my-pi/pi-tui/chat/transcript-store";
import { mountForTest } from "@oh-my-pi/pi-tui/testing";
import manualContinuePrompt from "../../src/prompts/system/manual-continue.md" with { type: "text" };
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

describe("live transcript visibility", () => {
	it("keeps internal continuation instructions hidden during delivery and session replay", async () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = message => helpers.addMessageToChat(message);
		const events = new EventController(ctx);
		const visible: AgentMessage = { role: "user", content: "Continue the visible request.", timestamp: 1 };
		const hidden: AgentMessage = {
			role: "developer",
			content: manualContinuePrompt,
			synthetic: true,
			userInitiated: true,
			timestamp: 2,
		};
		const mounted = mountForTest(() => TranscriptView({ store: ctx.chatContainer }), { width: 100 });
		try {
			helpers.addMessageToChat(visible);
			const before = mounted.text();
			expect(before.join("\n")).toContain("Continue the visible request.");
			await events.handleEvent({ type: "message_start", message: hidden });
			await events.handleEvent({ type: "message_end", message: hidden });
			expect(mounted.text()).toEqual(before);

			const context: SessionContext = {
				messages: [visible, hidden],
				models: {},
				injectedTtsrRules: [],
				mode: "none",
			};
			ctx.chatContainer.clear();
			helpers.renderSessionContext(context);
			expect(mounted.text()).toEqual(before);
		} finally {
			events.dispose();
			mounted.dispose();
		}
	});
});

describe("reactive transcript boundaries", () => {
	it("fast-rewinds from the first dropped visible message without disturbing its prefix", () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);
		const before: AgentMessage = { role: "user", content: "Keep this request.", timestamp: 1 };
		const boundary: AgentMessage = { role: "user", content: "Drop this request.", timestamp: 2 };
		const after: AgentMessage = { role: "user", content: "Drop this reply.", timestamp: 3 };
		const mounted = mountForTest(() => TranscriptView({ store: ctx.chatContainer }), { width: 100 });
		try {
			helpers.addMessageToChat(before);
			helpers.addMessageToChat(boundary);
			helpers.addMessageToChat(after);

			expect(helpers.truncateTranscriptFromMessage({ ...boundary })).toBe(true);
			const transcript = mounted.text().join("\n");
			expect(transcript).toContain("Keep this request.");
			expect(transcript).not.toContain("Drop this request.");
			expect(transcript).not.toContain("Drop this reply.");
		} finally {
			mounted.dispose();
		}
	});
});

describe("TTSR transcript notices", () => {
	it("merges consecutive rule triggers into the historical rewind notice", async () => {
		const ctx = createInteractiveModeContext();
		const events = new EventController(ctx);
		const mounted = mountForTest(() => TranscriptView({ store: ctx.chatContainer }), { width: 100 });
		const first: Rule = {
			name: "first-rule",
			path: "/tmp/first-rule.md",
			content: "First rule body",
			_source: { provider: "test", providerName: "test", path: "/tmp/first-rule.md", level: "project" },
		};
		const second: Rule = {
			name: "second-rule",
			path: "/tmp/second-rule.md",
			content: "Second rule body",
			_source: { provider: "test", providerName: "test", path: "/tmp/second-rule.md", level: "project" },
		};
		try {
			await events.handleEvent({ type: "ttsr_triggered", rules: [first] });
			await events.handleEvent({ type: "ttsr_triggered", rules: [second] });

			const transcript = mounted.text().join("\n");
			expect(transcript).toContain("Injecting 2 rules");
			expect(transcript).toContain("first-rule");
			expect(transcript).toContain("second-rule");
		} finally {
			events.dispose();
			mounted.dispose();
		}
	});
});

describe("custom message dispatch", () => {
	it("renders async completion metadata without exposing its model-only notice body", () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);
		const message: CustomMessage = {
			role: "custom",
			customType: "async-result",
			content: '<system-notice reason="background_result">RAW_ASYNC_RESULT_BODY_SENTINEL</system-notice>',
			display: true,
			details: {
				jobId: "job-capture-42",
				type: "task",
				durationMs: 1_234,
				meta: { artifactError: "write" },
			},
			timestamp: 1,
		};
		const mounted = mountForTest(() => TranscriptView({ store: ctx.chatContainer }), { width: 100 });
		try {
			helpers.addMessageToChat(message);
			const transcript = mounted.text().join("\n");
			expect(transcript).toContain("job-capture-42");
			expect(transcript).toContain("Background job completed");
			expect(transcript).toContain("(1.2s)");
			expect(transcript).toContain("Full output was not saved completely (artifact write failed)");
			expect(transcript).not.toContain("RAW_ASYNC_RESULT_BODY_SENTINEL");
			expect(transcript).not.toContain("<system-notice");

			ctx.chatContainer.clear();
			helpers.renderSessionContext({
				messages: [message],
				models: {},
				injectedTtsrRules: [],
				mode: "none",
			});
			const replay = mounted.text().join("\n");
			expect(replay).toContain("job-capture-42");
			expect(replay).not.toContain("RAW_ASYNC_RESULT_BODY_SENTINEL");
			expect(replay).not.toContain("<system-notice");
		} finally {
			mounted.dispose();
		}
	});
});
