import { describe, expect, it } from "bun:test";
import { openResetUsageSelector, type ResetUsageAccount } from "../src/overlays/reset-usage-selector";
import { render } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";
import { VirtualTerminal } from "./virtual-terminal";

function account(label: string, availableCount: number, overrides: Partial<ResetUsageAccount> = {}): ResetUsageAccount {
	return {
		label,
		availableCount,
		target: { email: `${label}@example.com` },
		active: false,
		...overrides,
	};
}

describe("reset usage selector", () => {
	it("renders historical account metadata and retains the unavailable-account warning, confirmation, and dismissal flow", () => {
		const terminal = new VirtualTerminal(80, 16);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const selected: string[] = [];
		let cancellations = 0;
		const overlay = openResetUsageSelector(root.tui, {
			accounts: [
				account("empty", 0),
				account("current", 2, { active: true }),
				account("unreachable", 0, { error: "Could not reach account" }),
			],
			onSelect: value => selected.push(value.label),
			onCancel: () => {
				cancellations++;
			},
		});
		try {
			root.tui.renderNow();
			const initial = terminal.getViewport().join("\n");
			expect(initial).toContain("Spend a saved rate-limit reset");
			expect(initial).toContain("empty  0 saved resets");
			expect(initial).toContain("current (active)  2 saved resets");
			expect(initial).toContain("unreachable  Could not reach account");

			terminal.sendInput("\x1b[A");
			terminal.sendInput("\n");
			root.tui.renderNow();
			expect(selected).toEqual([]);
			expect(terminal.getViewport().join("\n")).toContain("That account has no saved resets to spend.");

			terminal.sendInput("\x1b[5~");
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).not.toContain("That account has no saved resets to spend.");

			terminal.sendInput("\x1b[B");
			terminal.sendInput("\n");
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain(
				"Press Enter again to spend 1 reset for current, Esc to cancel",
			);

			terminal.sendInput("\x1b");
			root.tui.renderNow();
			expect(cancellations).toBe(0);
			expect(terminal.getViewport().join("\n")).not.toContain("Press Enter again to spend 1 reset for current");

			terminal.sendInput("\n");
			terminal.sendInput("\n");
			expect(selected).toEqual(["current"]);

			terminal.sendInput("\x03");
			expect(cancellations).toBe(1);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});

	it("maps mouse clicks to the historical row actions", () => {
		const terminal = new VirtualTerminal(80, 16);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const selected: string[] = [];
		const overlay = openResetUsageSelector(root.tui, {
			accounts: [account("mouse-empty", 0), account("mouse-ready", 1)],
			onSelect: value => selected.push(value.label),
			onCancel() {},
		});
		const click = (label: string): void => {
			root.tui.renderNow();
			const lines = terminal.getViewport();
			const row = lines.findIndex(line => line.includes(label));
			if (row < 0) throw new Error(`Could not find ${label}`);
			const column = lines[row]!.indexOf(label);
			root.tui.injectDebugInput(`\x1b[<0;${column + 1};${row + 1}M`);
		};
		try {
			click("mouse-empty");
			root.tui.renderNow();
			expect(selected).toEqual([]);
			expect(terminal.getViewport().join("\n")).toContain("That account has no saved resets to spend.");

			click("mouse-ready");
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain(
				"Press Enter again to spend 1 reset for mouse-ready, Esc to cancel",
			);

			click("mouse-ready");
			expect(selected).toEqual(["mouse-ready"]);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});

	it("cancels confirmation on a navigation boundary without dismissing the selector", () => {
		const terminal = new VirtualTerminal(80, 12);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const selected: string[] = [];
		const overlay = openResetUsageSelector(root.tui, {
			accounts: [account("only", 1)],
			onSelect: value => selected.push(value.label),
			onCancel() {},
		});
		try {
			root.tui.renderNow();
			terminal.sendInput("\n");
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain(
				"Press Enter again to spend 1 reset for only, Esc to cancel",
			);

			terminal.sendInput("\x1b[A");
			terminal.sendInput("\n");
			root.tui.renderNow();
			expect(selected).toEqual([]);
			expect(terminal.getViewport().join("\n")).toContain(
				"Press Enter again to spend 1 reset for only, Esc to cancel",
			);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});

	it("centers the ten-row viewport on the selected account without enabling search", () => {
		const terminal = new VirtualTerminal(80, 16);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const overlay = openResetUsageSelector(root.tui, {
			accounts: Array.from({ length: 12 }, (_, index) => account(`account-${index}`, 1)),
			onSelect() {},
			onCancel() {},
		});
		try {
			root.tui.renderNow();
			for (let index = 0; index < 6; index++) terminal.sendInput("\x1b[B");
			terminal.sendInput("x");
			root.tui.renderNow();
			const viewport = terminal.getViewport().join("\n");
			expect(viewport).toContain("account-1");
			expect(viewport).toContain("account-6");
			expect(viewport).toContain("account-10");
			expect(viewport).not.toContain("account-0");
			expect(viewport).not.toContain("account-11");
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});
});
