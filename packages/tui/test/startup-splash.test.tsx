import { describe, expect, it } from "bun:test";
import { runStartupSplash } from "../src/setup/startup-splash";
import { render } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";
import { VirtualTerminal } from "./virtual-terminal";

describe("startup splash", () => {
	it("owns a fullscreen overlay until skip and restores input to the active TUI", async () => {
		const terminal = new VirtualTerminal(32, 8);
		const theme = loadThemeSync("dark");
		const keys: string[] = [];
		const root = render(
			() => (
				<box tabIndex={0} onKey={event => keys.push(event.data)}>
					<text>editor</text>
				</box>
			),
			{ terminal, theme },
		);
		try {
			root.tui.renderNow();
			const splash = runStartupSplash(
				{ ui: root.tui, terminal, theme },
				{
					durationMs: 1_000,
					tickMs: 1_000,
					now: () => 0,
				},
			);
			root.tui.renderNow();

			expect(root.tui.hasOverlay()).toBe(true);
			expect(terminal.getViewport().join("\n")).toContain("press enter to skip");

			terminal.sendInput("\r");
			await splash;
			expect(root.tui.hasOverlay()).toBe(false);

			terminal.sendInput("x");
			expect(keys).toEqual(["x"]);
		} finally {
			root.dispose();
		}
	});
});
