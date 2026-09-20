import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { BorderedLoader, BorderedLoaderView } from "../src/overlays/bordered-loader";
import { mountForTest } from "../src/testing";
import { createClock } from "../src/reactive";
import { render } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";
import { VirtualTerminal } from "./virtual-terminal";

describe("BorderedLoader", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps the compact six-row loading frame without a spare row below its hint", () => {
		const root = mountForTest(() => BorderedLoaderView({ message: "pending work" }), { width: 32 });
		try {
			const rows = root.text();
			expect(rows).toHaveLength(6);
			expect(rows[2]).toContain("pending work");
			expect(rows[1]?.trim()).toBe("");
			expect(rows[3]?.trim()).toBe("");
			expect(rows[0]).toBe(rows[5]);
		} finally {
			root.dispose();
		}
	});

	it("mounts through the current factory, advances with the root spinner clock, and aborts on Escape", () => {
		vi.useFakeTimers();
		setSystemTime(0);
		const terminal = new VirtualTerminal(24, 6);
		const clock = createClock();
		let aborts = 0;
		const root = render(
			() =>
				BorderedLoader({
					message: "Working…",
					onAbort: () => {
						aborts++;
					},
				}),
			{ terminal, theme: loadThemeSync("dark"), clock },
		);
		try {
			root.tui.renderNow();
			const initial = terminal.getViewport().join("\n");
			expect(initial).toContain("Working…");

			vi.advanceTimersByTime(80);
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).not.toBe(initial);

			terminal.sendInput("x");
			root.tui.renderNow();
			expect(aborts).toBe(0);

			terminal.sendInput("\x1b");
			root.tui.renderNow();
			expect(aborts).toBe(1);
		} finally {
			root.dispose();
		}
	});
});
