import { describe, expect, it } from "bun:test";
import { openSessionSelectorOverlay, type SessionSelectorEntry } from "../src/overlays/session-selector";
import { render } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";
import { VirtualTerminal } from "./virtual-terminal";

function session(id: string, overrides: Partial<SessionSelectorEntry> = {}): SessionSelectorEntry {
	return {
		id,
		path: `/sessions/${id}.jsonl`,
		cwd: "/work/current",
		title: id,
		modified: new Date(Date.now()),
		size: 2_048,
		firstMessage: `first message for ${id}`,
		allMessagesText: "",
		...overrides,
	};
}

function plainViewport(terminal: VirtualTerminal): string[] {
	return terminal.getViewport().map(line => Bun.stripANSI(line));
}

describe("session selector view", () => {
	it("keeps its multi-line preview and footer inside a fullscreen narrow viewport", () => {
		const terminal = new VirtualTerminal(48, 24);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const current = session("current", {
			title: "Current session",
			firstMessage: "preview\ncontinues on another line",
			parentSessionPath: "/sessions/parent.jsonl",
			status: "complete",
		});
		const overlay = openSessionSelectorOverlay(root.tui, {
			sessions: [session("older", { title: "Older session" }), current],
			onSelect() {},
			onCancel() {},
			onExit() {},
			options: {
				fillHeight: true,
				getTerminalRows: () => terminal.rows,
				currentSessionPath: current.path,
				pinnedIds: new Set([current.id]),
			},
		});
		try {
			root.tui.renderNow();
			const viewport = plainViewport(terminal);
			const rendered = viewport.join("\n");

			expect(rendered).toContain("Resume Session (current folder)");
			expect(rendered).toContain("Current session");
			expect(rendered).toContain("preview continues on another line");
			expect(rendered).toContain("current");
			// Metadata clips from the right at narrow widths. The leading live and
			// lifecycle fields remain visible while the trailing fork marker does
			// not force a wrapped row or displace the pinned footer.
			expect(rendered).toContain("done");
			expect(rendered).not.toContain("fork");
			expect(viewport).toHaveLength(24);
			expect(viewport[21]).toContain("Del/⌫ delete");
			expect(viewport[21]).toContain("Tab all");
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});

	it("routes list navigation and scope switching through the retained input", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const local = session("local", { title: "Local session" });
		const remote = session("remote", { title: "Remote session", cwd: "/work/other-project" });
		const selected: string[] = [];
		const overlay = openSessionSelectorOverlay(root.tui, {
			sessions: [local],
			onSelect: item => selected.push(item.id),
			onCancel() {},
			onExit() {},
			options: {
				fillHeight: true,
				getTerminalRows: () => terminal.rows,
				loadAllSessions: async () => [local, remote],
			},
		});
		try {
			terminal.sendInput("\t");
			await Promise.resolve();
			root.tui.renderNow();
			expect(plainViewport(terminal).join("\n")).toContain("Resume Session (all projects)");
			expect(plainViewport(terminal).join("\n")).toContain("other-project");

			terminal.sendInput("\x1b[B");
			terminal.sendInput("\n");
			expect(selected).toEqual(["remote"]);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});
});
