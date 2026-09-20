import { describe, expect, it } from "bun:test";
import { Portal } from "../src/host/overlay";
import { createSignal, Show } from "../src/reactive";
import { render } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";
import { VirtualTerminal } from "./virtual-terminal";

describe("focus-changing menu teardown", () => {
	it("repaints stale menu and working rows on ED3-risk terminals without a viewport oracle", () => {
		const term = new VirtualTerminal(30, 6, 1000);
		const [working, setWorking] = createSignal(false);
		const [menuOpen, setMenuOpen] = createSignal(false);
		const [prompt, setPrompt] = createSignal("prompt");
		const [menuValue, setMenuValue] = createSignal("");
		const root = render(
			() => () => (
				<stack>
					<text>assistant</text>
					<Show when={working()}>
						<text>{": Working... <esc>"}</text>
					</Show>
					<input prompt="" value={prompt()} useTerminalCursor onChange={setPrompt} />
					<Show when={menuOpen()}>
						<Portal to="overlay" row={2} col={0} width={30}>
							<stack>
								{Array.from({ length: 12 }, (_, index) => (
									<text>{`menu-${index}`}</text>
								))}
								<input prompt="" value={menuValue()} onChange={setMenuValue} />
							</stack>
						</Portal>
					</Show>
				</stack>
			),
			{ terminal: term, theme: loadThemeSync("dark") },
		);

		try {
			root.tui.renderNow();
			const promptTarget = root.tui.getFocused();
			expect(promptTarget).not.toBeNull();

			setWorking(true);
			root.tui.renderNow();

			setMenuOpen(true);
			root.tui.renderNow();
			expect(root.tui.getFocused()).not.toBe(promptTarget);
			term.sendInput("m");
			expect(menuValue()).toBe("m");

			setWorking(false);
			root.tui.renderNow();

			setMenuOpen(false);
			root.tui.renderNow();
			expect(root.tui.getFocused()).toBe(promptTarget);

			// Closing the native menu portal restores the retained root's input
			// focus. Its focused cursor tail is shorter than the viewport, so the
			// frame re-anchors at the root tail instead of pinning "prompt" at the
			// top with blank rows underneath.
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(["assistant", "prompt", "", "", "", ""]);
			expect(term.getCursor()).toEqual({ row: 1, col: 6 });

			term.sendInput("!");
			expect(prompt()).toBe("prompt!");
		} finally {
			root.dispose();
		}
	});
});
