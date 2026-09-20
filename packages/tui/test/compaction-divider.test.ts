import { describe, expect, it } from "bun:test";
import { createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createComponent } from "solid-js";
import {
	CompactionSummaryMessageView,
	HandoffSummaryMessageView,
	isHandoffMessage,
} from "../src/chat/compaction-summary-message";
import type { CompactionSummaryMessage, CustomMessage } from "../src/chat/messages";
import "../src/host/elements/box";
import "../src/host/elements/br";
import "../src/host/elements/markdown";
import "../src/host/elements/sized";
import "../src/host/elements/span";
import "../src/host/elements/stack";
import "../src/host/elements/text";
import { createSignal } from "../src/reactive";
import { mountForTest, renderToRows } from "../src/testing";

const SUMMARY = "Earlier the user fixed the login TTL bug.";

function compactionMessage(images?: ImageContent[]) {
	return createCompactionSummaryMessage(SUMMARY, 84000, new Date().toISOString(), { images });
}

function rendered(message: CompactionSummaryMessage, width: number, expanded = false): string[] {
	return renderToRows(() => CompactionSummaryMessageView({ message, expanded }), width);
}

function handoffMessage(content: CustomMessage<unknown>["content"]): CustomMessage<unknown> {
	return {
		role: "custom",
		customType: "handoff",
		content,
		display: true,
		attribution: "agent",
		timestamp: 0,
	};
}

describe("CompactionSummaryMessageView", () => {
	it("collapsed: reserves historical breathing room around the full-width divider", () => {
		const lines = rendered(compactionMessage(), 80);
		expect(lines).toHaveLength(3);
		const rule = Bun.stripANSI(lines[1]!);
		expect(rule).toContain("compacted");
		expect(rule).toContain("ctrl+o");
		expect(Bun.stringWidth(rule)).toBe(80);
		expect(rule).not.toContain(SUMMARY);
	});

	it("names the compaction method and the before → after amounts on the divider", () => {
		const message = createCompactionSummaryMessage(SUMMARY, 256_000, new Date().toISOString(), {
			method: "remote",
			tokensAfter: 20_000,
		});
		const rule = Bun.stripANSI(rendered(message, 80)[1]!);
		expect(rule).toContain("remote-compacted");
		expect(rule).toContain("256K→20K");
		expect(rule).toContain("ctrl+o");
	});

	it("labels a handoff-method compaction as handed-off", () => {
		const message = createCompactionSummaryMessage(SUMMARY, 84_000, new Date().toISOString(), { method: "handoff" });
		const rule = Bun.stripANSI(rendered(message, 80)[1]!);
		expect(rule).toContain("handed-off");
		expect(rule).not.toContain("→");
	});

	it("does not render missing pre-compaction usage as a literal zero", () => {
		const message = createCompactionSummaryMessage(SUMMARY, 0, new Date().toISOString(), {
			method: "handoff",
			tokensAfter: 48_573,
		});
		const text = Bun.stripANSI(rendered(message, 80, true).join("\n"));
		expect(text).toContain("Compacted to 48,573 tokens");
		expect(text).not.toContain("Compacted from 0");
	});

	it("expanded: reveals the summary and snapcompact frame count below the divider", () => {
		const message = compactionMessage([{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }]);
		const text = Bun.stripANSI(rendered(message, 80, true).join("\n"));
		expect(text).toContain("compacted");
		expect(text).toContain(SUMMARY);
		expect(text).toContain("tokens");
		expect(text).toContain("1 snapcompact frame attached");
	});

	it("restores themed labels, narrow fallback, and the retained expanded detail", () => {
		const [expanded, setExpanded] = createSignal(false);
		const message = compactionMessage();
		const root = mountForTest(
			() =>
				createComponent(CompactionSummaryMessageView, {
					message,
					get expanded() {
						return expanded();
					},
				}),
			{ width: 80 },
		);
		try {
			const label = `${root.root.theme.symbol("icon.camera")} compacted`;
			const hint = `${root.root.theme.symbol("sep.dot").trim()} ctrl+o`;
			expect(root.text()).toEqual(["", expect.stringContaining(`${label} ${hint}`), ""]);
			expect(root.text(12)).toEqual(["", label, ""]);

			setExpanded(true);
			const expandedRows = root.text();
			expect(expandedRows.some(row => row.includes("Compacted from 84,000 tokens"))).toBe(true);
			expect(expandedRows.some(row => row.includes(SUMMARY))).toBe(true);
			const summary = root.root.node.children[0];
			if (!summary || summary.kind !== "element") throw new Error("Expected compaction summary stack");
			const detail = summary.children.at(-1);
			if (!detail) throw new Error("Expected expanded compaction detail");

			setExpanded(false);
			expect(root.text()).toEqual(["", expect.stringContaining(`${label} ${hint}`), ""]);
			setExpanded(true);
			root.text();
			expect(summary.children.at(-1)).toBe(detail);
		} finally {
			root.dispose();
		}
	});

	it("uses the warning icon on the divider and in expanded detail", () => {
		const [expanded, setExpanded] = createSignal(false);
		const message = createCompactionSummaryMessage(SUMMARY, 84_000, new Date().toISOString(), {
			warning: "Compaction freed too little context to make progress",
		});
		const root = mountForTest(() =>
			createComponent(CompactionSummaryMessageView, {
				message,
				get expanded() {
					return expanded();
				},
			}),
		);
		try {
			const warning = root.root.theme.symbol("icon.warning");
			expect(root.text().join("\n")).toContain(warning);
			setExpanded(true);
			const text = root.text().join("\n");
			expect(text).toContain(`${warning} Warning:`);
			expect(text).toContain("Compaction freed too little context to make progress");
		} finally {
			root.dispose();
		}
	});
});

describe("HandoffSummaryMessageView", () => {
	it("shares the historical divider and exposes only handoff context when expanded", () => {
		const [expanded, setExpanded] = createSignal(false);
		const message = handoffMessage(
			`<handoff-context>\n# Goal\nContinue the resize fix.\n</handoff-context>\n\nThe above is a handoff document.`,
		);
		const root = mountForTest(() =>
			createComponent(HandoffSummaryMessageView, {
				message,
				get expanded() {
					return expanded();
				},
			}),
		);
		try {
			const label = `${root.root.theme.symbol("icon.context")} handed-off`;
			const hint = `${root.root.theme.symbol("sep.dot").trim()} ctrl+o`;
			expect(root.text()).toEqual(["", expect.stringContaining(`${label} ${hint}`), ""]);

			setExpanded(true);
			const text = root.text().join("\n");
			expect(text).toContain("Handoff context");
			expect(text).toContain("Continue the resize fix.");
			expect(text).not.toContain("<handoff-context>");
			expect(text).not.toContain("</handoff-context>");
			expect(text).not.toContain("The above is a handoff document.");
		} finally {
			root.dispose();
		}
	});

	it("only recognizes displayable handoff custom messages", () => {
		const message = handoffMessage("Continue the resize fix.");
		expect(isHandoffMessage(message)).toBe(true);
		expect(isHandoffMessage({ ...message, display: false })).toBe(false);
		expect(isHandoffMessage({ ...message, customType: "extension-note" })).toBe(false);
	});
});
