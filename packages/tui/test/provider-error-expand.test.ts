import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageView } from "../src/chat/assistant-message";
import { mountForTest } from "../src/testing";

function errorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	};
}

describe("provider error presentation", () => {
	it("keeps a wrapped provider diagnostic reachable in the transcript", () => {
		const detail = "400 requested model is not supported\nraw-http-request=/tmp/request.json";
		const root = mountForTest(() => AssistantMessageView({ message: errorMessage(detail), expanded: false }), {
			width: 40,
		});
		try {
			const rows = root.text().map(row => row.trim());
			expect(rows.join(" ")).toContain("requested model is not supported");
			expect(rows.join("")).toContain("raw-http-request=/tmp/request.json");
		} finally {
			root.dispose();
		}
	});
});
