import { beforeAll, describe, expect, it } from "bun:test";
import { encodeKittyPlaceholderGrid, encodeKittyVirtualPlacement } from "../src/kitty-graphics";
import { initTheme, theme } from "../src/theme";
import { parseAnsiRow, parseAnsiRows } from "../src/core/ansi";
import { emitRow } from "../src/core/emit";
import { RichText, RunFlag } from "../src/core/richtext";
import { ansi16, ansi256, Attr, DEFAULT_COLOR, linkUrl, rgb } from "../src/core/style";
import { encodeTextSized, replaceTabs, visibleWidth } from "../src/utils";
import { VirtualTerminal } from "./virtual-terminal";

function renderedRow(line: string): RichText {
	const text = new RichText();
	parseAnsiRow(line, text);
	text.br();
	return text;
}

function cellObservations(terminal: VirtualTerminal): object {
	return {
		text: terminal.getViewport()[0],
		foreground: terminal.getViewportRowForegroundColumns(0),
		background: terminal.getViewportRowBackgroundColumns(0),
		backgroundValues: terminal.getViewportRowBackgroundValues(0),
		underline: terminal.getViewportRowUnderlineColumns(0),
		italic: Array.from({ length: terminal.columns }, (_, col) => terminal.getCellItalic(0, col)),
		graphics: terminal.graphicsPlacements(),
	};
}

function expectSameCells(line: string, emitted: string): void {
	const legacy = new VirtualTerminal(80, 4);
	const replay = new VirtualTerminal(80, 4);
	legacy.write(line);
	replay.write(emitted);
	expect(cellObservations(replay)).toEqual(cellObservations(legacy));
}

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

describe("legacy ANSI row decomposition", () => {
	it("replays the legacy corpus to the same terminal cells and preserves every row width", () => {
		const placeholders = encodeKittyPlaceholderGrid({
			imageId: 0x123456,
			placementId: 0x234567,
			columns: 3,
			rows: 1,
		})[0]!;
		const corpus = [
			theme.fg("accent", "accent"),
			theme.bgFill("userMessageBg", `outer ${theme.fg("accent", "inner")} \x1b[0mresumed`),
			"\x1b]8;id=docs;https://example.test/docs\x07linked\x1b]8;;\x1b\\ plain",
			"\x1b[1;4;9mbold underline strike\x1b[22;24;29m plain",
			"\x1b[38;5;201;48;5;17mindexed\x1b[39;49m \x1b[38;2;12;34;56;48:2::78:90:123mrgb\x1b[0m",
			`sized ${encodeTextSized("wide", { scale: 2 })} end`,
			`${encodeKittyVirtualPlacement({ imageId: 0x123456, placementId: 0x234567, columns: 3, rows: 1 })}${placeholders}`,
		];

		for (const line of corpus) {
			const text = renderedRow(line);
			expect(text.rowWidth[0], line).toBe(visibleWidth(line));
			expectSameCells(line, emitRow(text, 0, { mode: "truecolor" }));
		}
	});

	it("records links, attributes, sized spans, and image placeholders", () => {
		const line =
			"ab\x1b[1;2;3;4:3;5;7;8;9;53m" +
			"styled" +
			"\x1b[22;23;24;25;27;28;29;55m" +
			"\x1b]8;;https://example.test\x07link\x1b]8;;\x07" +
			encodeTextSized("XX", { widthCells: 5, scale: 2 }) +
			encodeKittyPlaceholderGrid({ imageId: 7, columns: 2, rows: 1 })[0]!;
		const text = renderedRow(line);

		const styled = text.style[text.text.indexOf("styled")]!;
		expect(styled.attrs).toBe(
			Attr.Bold |
				Attr.Dim |
				Attr.Italic |
				Attr.Undercurl |
				Attr.Blink |
				Attr.Inverse |
				Attr.Hidden |
				Attr.Strike |
				Attr.Overline,
		);
		const linked = text.style[text.text.indexOf("link")]!;
		expect(linkUrl(linked.link)).toBe("https://example.test");
		expect(linked.attrs).toBe(Attr.None);
		const sized = text.flags.findIndex(flag => (flag & RunFlag.Sized) !== 0);
		expect(text.width[sized]).toBe(10);
		const images = text.flags.filter(flag => (flag & RunFlag.Image) !== 0);
		expect(images.length).toBe(1);

		const tabbed = renderedRow("tab\tstop");
		expect(tabbed.rowText(0)).toBe(replaceTabs("tab\tstop"));
		expect(tabbed.rowWidth[0]).toBe(visibleWidth("tab\tstop"));
	});

	it("maps ANSI16 and colon-form extended colors onto interned styles", () => {
		const text = renderedRow(
			"\x1b[31;104;58;5;6mansi\x1b[39;49;59mdefaults\x1b[38:5:201;48:2::1:2:3;58:2:4:5:6mcolon",
		);
		const ansi = text.style[text.text.indexOf("ansi")]!;
		expect({ fg: ansi.fg, bg: ansi.bg, ul: ansi.ul }).toEqual({
			fg: ansi16(31),
			bg: ansi16(94),
			ul: ansi256(6),
		});
		const defaults = text.style[text.text.indexOf("defaults")]!;
		expect({ fg: defaults.fg, bg: defaults.bg, ul: defaults.ul }).toEqual({
			fg: DEFAULT_COLOR,
			bg: DEFAULT_COLOR,
			ul: DEFAULT_COLOR,
		});
		const colon = text.style[text.text.indexOf("colon")]!;
		expect({ fg: colon.fg, bg: colon.bg, ul: colon.ul }).toEqual({
			fg: ansi256(201),
			bg: rgb(1, 2, 3),
			ul: rgb(4, 5, 6),
		});
	});

	it("keeps unknown controls verbatim at zero width and terminates every input row", () => {
		const lines = ["a\x1b[2Cb", "c\x1bPq~sixel\x1b\\d", "e\x1b_Ga=p,i=1\x1b\\f", "g\x1b]133;A\x07h"];
		const text = new RichText();
		parseAnsiRows(lines, text);

		expect(text.rows).toBe(lines.length);
		for (let row = 0; row < lines.length; row++) {
			expect(text.rowWidth[row]).toBe(visibleWidth(lines[row]!));
			expectSameCells(lines[row]!, emitRow(text, row, { mode: "truecolor" }));
		}
		const rawWidths = text.width.filter((_, run) => (text.flags[run]! & RunFlag.Raw) !== 0);
		expect(rawWidths.every(width => width === 0)).toBe(true);
	});
});
