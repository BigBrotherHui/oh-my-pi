import { describe, expect, it } from "bun:test";
import { CustomMessageView } from "../src/chat/custom-message";
import { LIVE_DELEGATION_MESSAGE_TYPE, type CustomMessage } from "../src/chat/messages";
import { renderToRows, renderToText } from "../src/testing";

const message: CustomMessage = {
	role: "custom",
	customType: "extension:build",
	content: "Persisted extension output",
	display: true,
	timestamp: 0,
};

const plain = (rows: readonly string[]) => Bun.stripANSI(rows.join("\n"));

describe("CustomMessageView", () => {
	it("restores the rounded custom-message fallback within wide and narrow bounds", () => {
		const wide = renderToRows(() => CustomMessageView({ message }), 48);
		expect(plain(wide)).toContain("extension:build");
		expect(plain(wide)).toContain("Persisted extension output");
		expect(Bun.stripANSI(wide[0]!).trimStart()).toStartWith("╭");
		expect(Bun.stripANSI(wide[wide.length - 1]!).trimStart()).toStartWith("╰");

		const narrow = renderToRows(() => CustomMessageView({ message }), 4);
		for (const row of narrow) expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(4);
		expect(plain(narrow)).not.toContain("╭");
		expect(plain(narrow)).not.toContain("╰");
	});

	it("hides the delegation type while retaining its emphasized fallback frame", () => {
		const delegated: CustomMessage = {
			...message,
			customType: LIVE_DELEGATION_MESSAGE_TYPE,
			content: "Implement the requested change",
		};

		const text = plain(renderToRows(() => CustomMessageView({ message: delegated }), 48));
		expect(text).toContain("Implement the requested change");
		expect(text).not.toContain(LIVE_DELEGATION_MESSAGE_TYPE);
	});

	it("prefers an extension view but falls back when it declines or fails", () => {
		const custom = plain(
			renderToText(
				() =>
					CustomMessageView({
						message,
						expanded: true,
						view: props => <text>{props.expanded ? "Extension-owned content" : "collapsed"}</text>,
					}),
				48,
			),
		);
		expect(custom).toContain("Extension-owned content");
		expect(custom).not.toContain("Persisted extension output");

		const absent = plain(renderToText(() => CustomMessageView({ message, view: () => undefined }), 48));
		expect(absent).toContain("Persisted extension output");

		const failed = plain(
			renderToText(
				() =>
					CustomMessageView({
						message,
						view: () => {
							throw new Error("extension rendering failed");
						},
					}),
				48,
			),
		);
		expect(failed).toContain("Persisted extension output");
	});
});
