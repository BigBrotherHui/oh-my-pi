import { describe, expect, it } from "bun:test";
import { IrcMessageView } from "../src/chat/irc-message";
import type { CustomMessage } from "../src/chat/messages";
import { mountForTest } from "../src/testing";
import "../src/host/elements/box";
import "../src/host/elements/icon";
import "../src/host/elements/rail";
import "../src/host/elements/row";
import "../src/host/elements/span";
import "../src/host/elements/stack";
import "../src/host/elements/text";

function ircMessage(customType: string, details: unknown): CustomMessage<unknown> {
	return {
		role: "custom",
		customType,
		content: "",
		details,
		display: true,
		attribution: "agent",
		timestamp: 0,
	};
}

describe("IrcMessageView", () => {
	it("keeps the historical compact quoted body preview", () => {
		const root = mountForTest(
			() => (
				<IrcMessageView
					message={ircMessage("irc:incoming", {
						from: "Peer",
						message: "first\n\nsecond\nthird\nfourth\nfifth",
						replyTo: "message-1",
					})}
					expanded={false}
				/>
			),
			{ width: 120 },
		);
		try {
			const rendered = root.text().join("\n");
			expect(rendered).toContain(`IRC ${root.root.theme.symbol("nav.back")} Peer reply`);
			expect(rendered).toContain("first");
			expect(rendered).toContain("second");
			expect(rendered).toContain("third");
			expect(rendered).toContain("… +2 more lines");
			expect(rendered).not.toContain("fourth");
		} finally {
			root.dispose();
		}
	});

	it("retains IRC direction, reply context, and workpool mode across every card kind", () => {
		const root = mountForTest(
			() => (
				<stack>
					<IrcMessageView
						message={ircMessage("irc:autoreply", { to: "Peer", body: "automatic", replyTo: "message-1" })}
						expanded={false}
					/>
					<IrcMessageView
						message={ircMessage("irc:relay", { from: "Worker", to: "Main", body: "https://example.test/result" })}
						expanded={false}
					/>
					<IrcMessageView
						message={ircMessage("irc:workpool", {
							pool: "batch",
							to: "Worker",
							body: "dispatched",
							mode: "queued",
						})}
						expanded={false}
					/>
				</stack>
			),
			{ width: 120 },
		);
		try {
			const rendered = root.text().join("\n");
			const selected = root.root.theme.symbol("nav.selected");
			const dot = root.root.theme.symbol("sep.dot");
			expect(rendered).toContain(`IRC ${selected} Peer auto${dot}reply`);
			expect(rendered).toContain(`IRC Worker ${selected} Main`);
			expect(rendered).toContain("https://example.test/result");
			expect(rendered).toContain(`Pool batch ${selected} Worker queued`);
		} finally {
			root.dispose();
		}
	});

	it("extends the quoted preview to the historical twelve-line expanded bound", () => {
		const lines = Array.from({ length: 13 }, (_, index) => `line-${index + 1}`).join("\n");
		const root = mountForTest(
			() => <IrcMessageView message={ircMessage("irc:relay", { from: "A", to: "B", body: lines })} expanded />,
			{ width: 120 },
		);
		try {
			const rendered = root.text().join("\n");
			expect(rendered).toContain("line-12");
			expect(rendered).toContain("… +1 more line");
			expect(rendered).not.toContain("line-13");
		} finally {
			root.dispose();
		}
	});
});
