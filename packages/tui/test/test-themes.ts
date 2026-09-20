/**
 * Default themes for TUI tests using chalk
 */
import { ansi16, Attr, Style } from "../src/core/style";

const defaultSymbols = {
	cursor: ">",
	inputCursor: "|",
	boxRound: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
	},
	boxSharp: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	table: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	quoteBorder: "│",
	hrChar: "-",
	spinnerFrames: ["-", "\\", "|", "/"],
};

const defaultSelectListTheme = {
	selectedPrefix: Style.of({ fg: ansi16(34) }),
	selectedText: Style.NONE.plus(Attr.Bold),
	description: Style.NONE.plus(Attr.Dim),
	scrollInfo: Style.NONE.plus(Attr.Dim),
	noMatch: Style.NONE.plus(Attr.Dim),
	symbols: defaultSymbols,
};

export const defaultMarkdownTheme = {
	heading: Style.of({ fg: ansi16(36), attrs: Attr.Bold }),
	link: Style.of({ fg: ansi16(34) }),
	linkUrl: Style.NONE.plus(Attr.Dim),
	code: Style.of({ fg: ansi16(33) }),
	codeBlock: Style.of({ fg: ansi16(32) }),
	codeBlockBorder: Style.NONE.plus(Attr.Dim),
	quote: Style.NONE.plus(Attr.Italic),
	quoteBorder: Style.NONE.plus(Attr.Dim),
	hr: Style.NONE.plus(Attr.Dim),
	listBullet: Style.of({ fg: ansi16(36) }),
	bold: Style.NONE.plus(Attr.Bold),
	italic: Style.NONE.plus(Attr.Italic),
	strikethrough: Style.NONE.plus(Attr.Strike),
	underline: Style.NONE.plus(Attr.Underline),
	symbols: defaultSymbols,
};

export const defaultEditorTheme = {
	borderStyle: Style.NONE.plus(Attr.Dim),
	selectList: defaultSelectListTheme,
	symbols: defaultSymbols,
};
