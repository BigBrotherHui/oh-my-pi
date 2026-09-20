import { describe, expect, it } from "bun:test";
import { openSessionAccountSelector, type SessionPinAccount } from "../src/overlays/session-account-selector";
import { render } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";
import { VirtualTerminal } from "./virtual-terminal";

const accounts: readonly SessionPinAccount[] = [
	{ position: 0, credentialId: 11, email: "first@example.com", active: false, label: "first@example.com" },
	{ position: 1, credentialId: 12, email: "second@example.com", active: true, label: "second@example.com" },
];

describe("session account selector", () => {
	it("renders the active provider account, selects the focused account, and cancels", () => {
		const terminal = new VirtualTerminal(80, 12);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const selected: number[] = [];
		let cancellations = 0;
		const overlay = openSessionAccountSelector(root.tui, {
			providerName: "Anthropic",
			accounts,
			onSelect: account => selected.push(account.credentialId),
			onCancel: () => {
				cancellations += 1;
			},
		});
		try {
			root.tui.renderNow();
			const wide = terminal.getViewport().join("\n");
			expect(wide).toContain("Select a Anthropic account for this session");
			expect(wide).toContain("second@example.com");
			expect(wide).toContain("active for this session");

			terminal.sendInput("\x1b[A");
			terminal.sendInput("\n");
			expect(selected).toEqual([11]);

			terminal.sendInput("\x03");
			expect(cancellations).toBe(1);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});

	it("omits account details below the historical wide-list boundary", () => {
		const terminal = new VirtualTerminal(40, 8);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const overlay = openSessionAccountSelector(root.tui, {
			providerName: "Anthropic",
			accounts,
			onSelect() {},
			onCancel() {},
		});
		try {
			root.tui.renderNow();
			const narrow = terminal.getViewport().join("\n");
			expect(narrow).toContain("first@example.com");
			expect(narrow).not.toContain("active for this session");
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});

	it("keeps a selected account visible while navigating past the ten-row viewport", () => {
		const terminal = new VirtualTerminal(80, 16);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const manyAccounts = Array.from({ length: 11 }, (_, position) => ({
			position,
			credentialId: position,
			active: position === 0,
			label: `account-${position}`,
		}));
		const overlay = openSessionAccountSelector(root.tui, {
			providerName: "Anthropic",
			accounts: manyAccounts,
			onSelect() {},
			onCancel() {},
		});
		try {
			root.tui.renderNow();
			for (let index = 0; index < 10; index++) terminal.sendInput("\x1b[B");
			root.tui.renderNow();
			const rows = terminal.getViewport().join("\n");
			expect(rows).toContain("account-10");
			expect(rows).not.toContain("account-0");
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});
});
