import { describe, expect, it } from "bun:test";
import { setupSplashRows, SplashFrameView } from "@oh-my-pi/pi-tui/setup/scenes/splash";
import { renderSnapshot } from "../src/snapshot";
import { loadThemeSync } from "../src/theme/loader";
import { cellGrid } from "./cell-grid";

describe("setupSplashRows", () => {
	it("clears the full-scene hint strip and leaves its whitespace unstyled", () => {
		const width = 80;
		const hint = "press enter to skip";
		const hintStart = Math.floor((width - hint.length) / 2);
		const theme = loadThemeSync("dark");
		const rendered = renderSnapshot(() => SplashFrameView({ rows: setupSplashRows(width, 30, 0) }), {
			columns: width,
			theme,
		});
		const row = cellGrid(rendered, width).at(-1)!;
		const dim = cellGrid([theme.fg("dim", "p")], 1)[0]![0]!.fg;

		expect(
			row
				.slice(hintStart - 1, hintStart + hint.length + 1)
				.map(cell => cell.ch)
				.join(""),
		).toBe(` ${hint} `);
		expect(row[hintStart - 1]!.fg).toBeNull();
		expect(row[hintStart + hint.length]!.fg).toBeNull();
		expect(row[hintStart + hint.indexOf(" ")]!.fg).toBeNull();
		expect(row[hintStart]!.fg).toEqual(dim);
	});
});
