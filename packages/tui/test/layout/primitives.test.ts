import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { boxElement } from "../../src/host/elements/box";
import { brElement } from "../../src/host/elements/br";
import { cursorElement } from "../../src/host/elements/cursor";
import { hrElement } from "../../src/host/elements/hr";
import { linkElement } from "../../src/host/elements/link";
import { metaElement } from "../../src/host/elements/meta";
import { railElement } from "../../src/host/elements/rail";
import { rawElement } from "../../src/host/elements/raw";
import { rowElement } from "../../src/host/elements/row";
import { scrollElement, type ScrollViewportState } from "../../src/host/elements/scroll";
import { sizedElement } from "../../src/host/elements/sized";
import { spanElement } from "../../src/host/elements/span";
import { splitElement } from "../../src/host/elements/split";
import { stackElement } from "../../src/host/elements/stack";
import { textElement } from "../../src/host/elements/text";
import { applyHyperlinkSetting } from "../../src/render/hyperlink";
import { Damage } from "../../src/host/types";
import { initTheme, theme } from "../../src/theme/theme";
import { cellGrid } from "../cell-grid";
import { elementRows, elementText, hostElement, hostText, paintElement } from "./host-harness";

void boxElement;
void brElement;
void cursorElement;
void hrElement;
void linkElement;
void metaElement;
void railElement;
void rawElement;
void rowElement;
void scrollElement;
void sizedElement;
void spanElement;
void splitElement;
void stackElement;
void textElement;

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	applyHyperlinkSetting("auto");
});

describe("retained layout primitives", () => {
	it("does not add gaps for empty conditional row children", () => {
		const row = hostElement("row", { gap: 1 }, [
			hostText(""),
			hostElement("text", {}, [hostText("Edit")]),
			hostText(""),
			hostElement("text", {}, [hostText("[+1/-1]")]),
			hostText(""),
		]);
		expect(elementText(row, 30)).toEqual(["Edit [+1/-1]"]);
	});

	it("stacks children with blank gap rows and boxes them to the allocation", () => {
		const stack = hostElement("stack", { gap: 1 }, [
			hostElement("text", { wrap: "none" }, [hostText("a")]),
			hostElement("text", { wrap: "none" }, [hostText("b")]),
		]);
		const box = hostElement("box", { padding: { x: 1 }, border: "round" }, [stack]);
		expect(elementText(box, 7)).toEqual(["╭─────╮", "│ a   │", "│     │", "│ b   │", "╰─────╯"]);
	});

	it("keeps container geometry bounded when padding, gaps, or decorations exceed width", () => {
		const narrowBox = hostElement("box", { padding: { x: 9 }, border: "round" }, [
			hostElement("text", { wrap: "none" }, [hostText("x")]),
		]);
		expect(elementText(narrowBox, 3)).toEqual(["   "]);

		const narrowRow = hostElement("row", { gap: 9 }, [
			hostElement("text", { wrap: "none" }, [hostText("a")]),
			hostElement("text", { wrap: "none" }, [hostText("b")]),
			hostElement("text", { wrap: "none" }, [hostText("c")]),
		]);
		expect(elementText(narrowRow, 1)[0]).toHaveLength(1);

		const narrowSplit = hostElement("split", { prefix: "prefix", divider: "|", suffix: "suffix", height: 1 }, [
			hostElement("text", { wrap: "none" }, [hostText("left")]),
			hostElement("text", { wrap: "none" }, [hostText("right")]),
		]);
		expect(elementText(narrowSplit, 3)).toEqual(["pre"]);
	});

	it("uses separate first and continuation rail slots", () => {
		const prefix = hostElement("span", {}, [hostText("> ")]);
		const rest = hostElement("span", {}, [hostText("| ")]);
		const body = hostElement("text", { wrap: "word" }, [hostText("one two")]);
		const rail = hostElement("rail", { prefix, rest }, [body]);
		expect(elementText(rail, 6)).toEqual(["> one", "| two"]);
	});

	it("windows retained rows at a controlled scroll offset", () => {
		const content = hostElement(
			"stack",
			{},
			["a", "b", "c", "d"].map(value => hostElement("text", { wrap: "none" }, [hostText(value)])),
		);
		const scroll = hostElement("scroll", { height: 2, offset: 1, scrollbar: "never" }, [content]);
		expect(elementText(scroll, 4)).toEqual(["b   ", "c   "]);
	});

	it("publishes a clamped measured viewport once per geometry change", () => {
		const viewports: ScrollViewportState[] = [];
		const content = hostElement(
			"stack",
			{},
			["a", "b", "c", "d"].map(value => hostElement("text", { wrap: "none" }, [hostText(value)])),
		);
		const scroll = hostElement(
			"scroll",
			{
				height: 2,
				offset: 99,
				scrollbar: "auto",
				onViewport: (viewport: ScrollViewportState) => viewports.push(viewport),
			},
			[content],
		);

		expect(elementText(scroll, 4)).toEqual(["c  │", "d  █"]);
		expect(viewports).toEqual([{ offset: 2, totalRows: 4, height: 2, width: 3 }]);
		expect(elementText(scroll, 4)).toEqual(["c  │", "d  █"]);
		expect(viewports).toHaveLength(1);

		scroll.props = { ...scroll.props, offset: 1 };
		scroll.damage = Damage.Paint;
		expect(elementText(scroll, 4)).toEqual(["b  │", "c  █"]);
		expect(viewports).toEqual([
			{ offset: 2, totalRows: 4, height: 2, width: 3 },
			{ offset: 1, totalRows: 4, height: 2, width: 3 },
		]);
	});

	it("follows the tail only while it was already at the measured end", () => {
		const viewports: ScrollViewportState[] = [];
		const content = hostElement(
			"stack",
			{},
			["a", "b", "c"].map(value => hostElement("text", { wrap: "none" }, [hostText(value)])),
		);
		const scroll = hostElement(
			"scroll",
			{
				height: 2,
				scrollbar: "never",
				followTail: true,
				onViewport: (viewport: ScrollViewportState) => viewports.push(viewport),
			},
			[content],
		);

		expect(elementText(scroll, 4)).toEqual(["b   ", "c   "]);
		const next = hostElement("text", { wrap: "none" }, [hostText("d")]);
		next.parent = content;
		content.children.push(next);
		content.damage = Damage.Layout;
		scroll.damage = Damage.Layout;
		expect(elementText(scroll, 4)).toEqual(["c   ", "d   "]);
		expect(viewports).toEqual([
			{ offset: 1, totalRows: 3, height: 2, width: 4 },
			{ offset: 2, totalRows: 4, height: 2, width: 4 },
		]);
	});

	it("preserves an end anchor's trailing rows after a controlled offset", () => {
		const content = hostElement(
			"stack",
			{},
			["a", "b", "c", "d"].map(value => hostElement("text", { wrap: "none" }, [hostText(value)])),
		);
		const scroll = hostElement("scroll", { height: 2, scrollbar: "never", anchor: "end", offset: 1 }, [content]);

		expect(elementText(scroll, 4)).toEqual(["b   ", "c   "]);
		scroll.props = { height: 2, scrollbar: "never", anchor: "end" };
		scroll.damage = Damage.Layout;
		expect(elementText(scroll, 4)).toEqual(["b   ", "c   "]);

		const next = hostElement("text", { wrap: "none" }, [hostText("e")]);
		next.parent = content;
		content.children.push(next);
		content.damage = Damage.Layout;
		scroll.damage = Damage.Layout;
		expect(elementText(scroll, 4)).toEqual(["c   ", "d   "]);
	});

	it("clips a fixed-width horizontal canvas at its bounded camera offset", () => {
		const content = hostElement("text", { wrap: "none" }, [hostText("abcdefgh")]);
		const scroll = hostElement("scroll", { height: 1, scrollbar: "never", contentWidth: 8, offsetX: 3 }, [content]);

		expect(elementText(scroll, 4)).toEqual(["defg"]);
		scroll.props = { ...scroll.props, offsetX: 99 };
		scroll.damage = Damage.Paint;
		expect(elementText(scroll, 4)).toEqual(["efgh"]);
	});

	it("paints adaptive split panes at exact cell widths", () => {
		const left = hostElement("text", { wrap: "none" }, [hostText("L")]);
		const right = hostElement("text", { wrap: "none" }, [hostText("R")]);
		const split = hostElement("split", { leftSize: { fixed: 3 }, divider: "|" }, [left, right]);
		expect(elementText(split, 8)).toEqual(["L  |R   "]);
	});

	it("renders width-dependent sized content and full rules", () => {
		const sizedChild = hostElement("text", { wrap: "none" }, [hostText("wide")]);
		const sized = hostElement("sized", { paint: (width: number) => (width >= 4 ? sizedChild : "x") });
		expect(elementText(sized, 4)).toEqual(["wide"]);
		expect(elementText(hostElement("hr", { char: "-" }), 5)).toEqual(["-----"]);
	});

	it("joins styled text metadata without block padding or stray continuation rows", () => {
		applyHyperlinkSetting("always");
		const metadata = hostElement("meta", {}, [
			hostElement("text", { color: "accent", pad: true, align: "right" }, [
				hostElement("text", { bold: true }, [
					hostElement("link", { href: "https://example.com/source" }, [hostText("source")]),
				]),
			]),
			hostText(" "),
			hostElement("text", {}, [hostText("4 rows\nhidden continuation")]),
		]);
		expect(elementText(metadata, 30)).toEqual([`source${theme.symbol("sep.dot")}4 rows`]);
		const cells = cellGrid(elementRows(metadata, 30), 30);
		expect(cells[0]?.slice(0, 6).every(cell => cell.link === "https://example.com/source")).toBe(true);
	});

	it("carries OSC 8 targets through inline links", () => {
		applyHyperlinkSetting("always");
		const link = hostElement("link", { href: "https://example.com" }, [hostText("site")]);
		const text = hostElement("text", { wrap: "none" }, [link]);
		const grid = cellGrid(elementRows(text, 4), 4);
		for (const cell of grid[0] ?? []) expect(cell.link).toBe("https://example.com");
	});

	it("preserves raw and cursor compositor runs", () => {
		const raw = hostElement("raw", { value: "\u001b[2C", width: 2 });
		const cursor = hostElement("cursor");
		const stack = hostElement("stack", {}, [raw, cursor]);
		const result = paintElement(stack, 4);
		expect(result.flags.some(flag => (flag & 1) !== 0)).toBe(true);
		expect(result.flags.some(flag => (flag & 2) !== 0)).toBe(true);
	});
});
