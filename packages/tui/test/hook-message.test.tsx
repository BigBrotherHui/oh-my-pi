import { describe, expect, it } from "bun:test";
import { HookMessageView } from "../src/chat/hook-message";
import type { HookMessage } from "../src/chat/messages";
import "../src/host/elements/box";
import "../src/host/elements/markdown";
import "../src/host/elements/stack";
import "../src/host/elements/text";
import { renderToText } from "../src/testing";

function hookMessage(content: string): HookMessage {
	return {
		role: "hookMessage",
		customType: "hook:before-agent-start",
		content,
		display: true,
		timestamp: 0,
	};
}

describe("HookMessageView", () => {
	it("uses the historical framed fallback and folds only body lines after the fifth", () => {
		const message = hookMessage("one\ntwo\nthree\nfour\nfive\nsix\nseven");
		const collapsed = renderToText(() => HookMessageView({ message, expanded: false }), 80).join("\n");
		const expanded = renderToText(() => HookMessageView({ message, expanded: true }), 80).join("\n");

		expect(collapsed).toContain("╭");
		expect(collapsed).toContain("hook:before-agent-start");
		expect(collapsed).toContain("one");
		expect(collapsed).toContain("five");
		expect(collapsed).toContain("…");
		expect(collapsed).not.toContain("six");
		expect(collapsed).not.toContain("ctrl+o");
		expect(expanded).toContain("six");
		expect(expanded).toContain("seven");
		expect(expanded).not.toContain("…");

		for (const line of renderToText(() => HookMessageView({ message, expanded: false }), 4)) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(4);
		}
	});

	it("lets a hook renderer replace the fallback frame", () => {
		const message = hookMessage("persisted default body");
		const rendered = renderToText(
			() => HookMessageView({ message, expanded: false, content: <text>hook-provided body</text> }),
			80,
		).join("\n");

		expect(rendered).toContain("hook-provided body");
		expect(rendered).not.toContain("persisted default body");
		expect(rendered).not.toContain("hook:before-agent-start");
		expect(rendered).not.toContain("╭");
	});
});
