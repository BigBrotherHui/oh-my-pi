import { describe, expect, it } from "bun:test";
import { openHistorySearch, type HistorySearchEntry, type HistorySource } from "../src/overlays/history-search";
import { render } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";
import { VirtualTerminal } from "./virtual-terminal";

function source(entries: readonly HistorySearchEntry[]): HistorySource {
	return {
		getRecent(limit) {
			return entries.slice(0, limit);
		},
		search(query, limit) {
			const tokens = query
				.toLowerCase()
				.split(/[^\p{L}\p{N}]+/u)
				.filter(token => token.length > 0);
			return entries
				.filter(entry => tokens.every(token => entry.prompt.toLowerCase().includes(token)))
				.slice(0, limit);
		},
	};
}

describe("history search overlay", () => {
	it("distinguishes empty history from an unmatched search", () => {
		const terminal = new VirtualTerminal(80, 14);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const empty = openHistorySearch(root.tui, {
			historyStorage: source([]),
			onSelect() {},
			onCancel() {},
		});
		try {
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("No history yet");
		} finally {
			empty.dispose();
		}

		const unmatched = openHistorySearch(root.tui, {
			historyStorage: source([{ prompt: "deploy the release", created_at: Math.floor(Date.now() / 1_000) }]),
			onSelect() {},
			onCancel() {},
		});
		try {
			terminal.sendInput("zzzz");
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("No matching history");
		} finally {
			unmatched.dispose();
			root.dispose();
		}
	});

	it("filters and highlights matching prompts, then selects or cancels", () => {
		const now = Math.floor(Date.now() / 1_000);
		const terminal = new VirtualTerminal(80, 14);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const selected: string[] = [];
		let cancelled = 0;
		const overlay = openHistorySearch(root.tui, {
			historyStorage: source([
				{ prompt: "deploy the needle rollback", created_at: now },
				{ prompt: "routine status update", created_at: now - 7_200 },
			]),
			onSelect: prompt => selected.push(prompt),
			onCancel: () => {
				cancelled += 1;
			},
		});
		try {
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("deploy the needle rollback");
			expect(terminal.getViewport().join("\n")).toContain("now");

			terminal.sendInput("needle");
			root.tui.renderNow();
			const viewport = terminal.getViewport();
			const row = viewport.findIndex(line => line.includes("deploy the needle rollback"));
			expect(row).toBeGreaterThanOrEqual(0);
			expect(viewport.join("\n")).not.toContain("routine status update");
			expect(terminal.getViewportRowForegroundColumns(row).length).toBeGreaterThanOrEqual(7);
			expect(terminal.getViewportRowBackgroundColumns(row).length).toBeGreaterThan(10);

			terminal.sendInput("\n");
			expect(selected).toEqual(["deploy the needle rollback"]);
			terminal.sendInput("\x1b");
			expect(cancelled).toBe(1);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});

	it("keeps navigation keys on the results list and clips timestamps at narrow widths", () => {
		const now = Math.floor(Date.now() / 1_000);
		const terminal = new VirtualTerminal(20, 28);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const entries = Array.from({ length: 15 }, (_, index) => ({
			prompt: `p${14 - index}`,
			created_at: now,
		}));
		const selected: string[] = [];
		const overlay = openHistorySearch(root.tui, {
			historyStorage: source(entries),
			onSelect: prompt => selected.push(prompt),
			onCancel() {},
		});
		try {
			root.tui.renderNow();
			const narrow = terminal.getViewport().join("\n");
			expect(narrow).toContain("p14");
			expect(narrow).not.toContain("now");

			terminal.sendInput("\x1b[6~");
			terminal.sendInput("\n");
			terminal.sendInput("\x1b[F");
			terminal.sendInput("\n");
			terminal.sendInput("\x1b[5~");
			terminal.sendInput("\n");
			terminal.sendInput("\x1b[H");
			terminal.sendInput("\n");

			expect(selected).toEqual(["p4", "p0", "p10", "p14"]);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});
});
