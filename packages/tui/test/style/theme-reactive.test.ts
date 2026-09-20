import { describe, expect, it } from "bun:test";
import { createRoot } from "solid-js";
import { Damage } from "../../src/host/types";
import { loadThemeSync } from "../../src/theme/loader";
import { createThemeSignal } from "../../src/theme/reactive";
import { setThemeInstance } from "../../src/theme/theme";

describe("reactive theme damage", () => {
	it("marks palette replacements Paint and glyph-preset replacements Layout", () => {
		createRoot(dispose => {
			const first = loadThemeSync("dark", { mode: "truecolor", symbolPresetOverride: "unicode" });
			const palette = loadThemeSync("alabaster", { mode: "truecolor", symbolPresetOverride: "unicode" });
			const glyphs = loadThemeSync("alabaster", { mode: "truecolor", symbolPresetOverride: "ascii" });
			const damage: Damage[] = [];
			const signal = createThemeSignal(first, { invalidate: value => damage.push(value) });
			expect(signal.token("toolPendingBg")).toBe(first.bgColor("toolPendingBg"));

			signal.setTheme(palette);
			signal.setTheme(glyphs);
			expect(damage).toEqual([Damage.Paint, Damage.Layout]);

			signal.dispose();
			dispose();
		});
	});

	it("bridges legacy changes to every live root and unsubscribes disposed roots", () => {
		createRoot(dispose => {
			const first = loadThemeSync("dark", { mode: "truecolor", symbolPresetOverride: "unicode" });
			const replacement = loadThemeSync("alabaster", { mode: "truecolor", symbolPresetOverride: "unicode" });
			const glyphs = loadThemeSync("alabaster", { mode: "truecolor", symbolPresetOverride: "ascii" });
			const firstDamage: Damage[] = [];
			const secondDamage: Damage[] = [];
			const firstSignal = createThemeSignal(first, { invalidate: value => firstDamage.push(value) });
			const secondSignal = createThemeSignal(first, { invalidate: value => secondDamage.push(value) });

			setThemeInstance(replacement);
			expect(firstSignal.theme()).toBe(replacement);
			expect(secondSignal.theme()).toBe(replacement);
			expect(firstDamage).toEqual([Damage.Paint]);
			expect(secondDamage).toEqual([Damage.Paint]);

			firstSignal.dispose();
			setThemeInstance(glyphs);
			expect(firstSignal.theme()).toBe(replacement);
			expect(secondSignal.theme()).toBe(glyphs);
			expect(firstDamage).toEqual([Damage.Paint]);
			expect(secondDamage).toEqual([Damage.Paint, Damage.Layout]);

			secondSignal.dispose();
			setThemeInstance(first);
			dispose();
		});
	});
});
