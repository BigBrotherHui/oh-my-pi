import { afterEach, describe, expect, it, vi } from "bun:test";
import { Attr, rgb } from "../src/core/style";
import { RichText } from "../src/core/richtext";
import {
	paintShimmerText,
	setShimmerMode,
	type ShimmerPalette,
	type ShimmerTheme,
} from "@oh-my-pi/pi-tui/theme/shimmer";

const DIM = rgb(1, 2, 3);
const MUTED = rgb(4, 5, 6);
const ACCENT = rgb(7, 8, 9);
const CREST = rgb(12, 34, 56);

const testTheme: ShimmerTheme = {
	fgColor(color) {
		if (color === "dim") return DIM;
		if (color === "muted") return MUTED;
		return ACCENT;
	},
};

const palette: ShimmerPalette = {
	low: "dim",
	mid: CREST,
	high: CREST,
	bold: true,
};

function paint(text: string, customPalette?: ShimmerPalette): RichText {
	const runs = new RichText();
	paintShimmerText(runs, text, testTheme, customPalette);
	runs.finish();
	return runs;
}

function visibleText(runs: RichText): string {
	return runs.text.slice(0, runs.runs).join("");
}

describe("paintShimmerText", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses a supplied packed color and bold attribute for the shimmer crest", () => {
		setShimmerMode("classic");
		vi.spyOn(Date, "now").mockReturnValue(333);

		const rendered = paint("x", palette);

		expect(rendered.style[0]?.fg).toBe(CREST);
		expect((rendered.style[0]?.attrs ?? Attr.None) & Attr.Bold).toBe(Attr.Bold);
		expect(visibleText(rendered)).toBe("x");
	});

	it("preserves a mixed BMP and surrogate-pair message", () => {
		setShimmerMode("classic");
		vi.spyOn(Date, "now").mockReturnValue(0);

		expect(visibleText(paint("a😀b"))).toBe("a😀b");
	});

	it("preserves every code point in an all-emoji message", () => {
		setShimmerMode("classic");
		vi.spyOn(Date, "now").mockReturnValue(0);

		expect(visibleText(paint("🎉🌟✨🚀"))).toBe("🎉🌟✨🚀");
	});
});

describe("paintShimmerText band fast-path", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("paints code points outside the band in the low tier", () => {
		setShimmerMode("classic");
		vi.spyOn(Date, "now").mockReturnValue(333);
		const text = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
		const rendered = paint(text, palette);
		const zRun = rendered.text.findIndex(value => value.includes("Z"));

		expect(rendered.style[zRun]?.fg).toBe(DIM);
		expect(visibleText(rendered)).toBe(text);
	});

	it("keeps the crest color when the band sweeps across the string", () => {
		setShimmerMode("classic");
		vi.spyOn(Date, "now").mockReturnValue(833);
		const text = "abcdefghijklmnopqrstuvwxyz0123456789";
		const rendered = paint(text, palette);

		expect(rendered.style.slice(0, rendered.runs).some(style => style.fg === CREST)).toBe(true);
		expect(visibleText(rendered)).toBe(text);
	});

	it("handles a surrogate pair straddling the band boundary atomically", () => {
		setShimmerMode("classic");
		vi.spyOn(Date, "now").mockReturnValue(333);

		expect(visibleText(paint("......😀......"))).toBe("......😀......");
	});
});
