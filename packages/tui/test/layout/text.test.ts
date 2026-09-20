import { beforeAll, describe, expect, it } from "bun:test";
import { textElement } from "../../src/host/elements/text";
import { initTheme } from "../../src/theme/theme";
import { DEFAULT_TAB_WIDTH } from "../../src/utils";
import { cellGrid, expectSameCells } from "../cell-grid";
import { elementRows, elementText, hostElement, hostText } from "./host-harness";

void textElement;

beforeAll(async () => {
	await initTheme(false);
});

describe("retained text layout", () => {
	it("word-wraps wide glyphs without splitting them", () => {
		const node = hostElement("text", { wrap: "word" }, [hostText("ab 한글 cd")]);
		const rows = elementRows(node, 5);
		expectSameCells(["ab", "한글", "cd"], rows, 5);
		expect(elementText(node, 5)).toEqual(["ab", "한글", "cd"]);
	});

	it("keeps combining graphemes intact across hard wraps", () => {
		const node = hostElement("text", { wrap: "word" }, [hostText("éé")]);
		const rows = elementRows(node, 1);
		expectSameCells(["é", "é"], rows, 1);
	});

	it("expands tabs to fixed cells before clipping", () => {
		const node = hostElement("text", { wrap: "none", pad: true }, [hostText("a\tb")]);
		const width = DEFAULT_TAB_WIDTH + 1;
		const rows = elementRows(node, width);
		expectSameCells([`a${" ".repeat(DEFAULT_TAB_WIDTH)}`], rows, width);
		expect(cellGrid(rows, width)[0]?.map(cell => cell.ch)).toEqual([
			"a",
			...new Array<string>(DEFAULT_TAB_WIDTH).fill(" "),
		]);
	});

	it("distinguishes clip, ellipsis, middle, and terminal overflow", () => {
		expect(elementText(hostElement("text", { wrap: "none" }, [hostText("abcdefgh")]), 5)).toEqual(["abcde"]);
		expect(elementText(hostElement("text", { wrap: "clip" }, [hostText("abcdefgh")]), 5)).toEqual(["abcd…"]);
		expect(elementText(hostElement("text", { wrap: "none", overflow: "middle" }, [hostText("abcdefgh")]), 5)).toEqual(
			["ab…gh"],
		);
		expect(elementText(hostElement("text", { wrap: "overflow" }, [hostText("abcdefgh")]), 5)).toEqual(["abcdefgh"]);
	});
});
