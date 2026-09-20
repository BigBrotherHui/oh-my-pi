import {
	Lexer,
	Marked,
	type Token,
	Tokenizer,
	type TokenizerAndRendererExtension,
	type Tokens,
} from "@oh-my-pi/pi-utils/marked";
import { mathBlockAt, mathSpanAt, mathStartIndex } from "@oh-my-pi/pi-utils/math-delimiters";
import { paintLatexBlock } from "../latex-block";
import { isBareMathEnvironment, latexToUnicode } from "../latex-to-unicode";
import type { SymbolTheme } from "../symbols";
import { TERMINAL } from "../terminal-capabilities";
import {
	Ellipsis,
	encodeTextSized,
	getPaddingX,
	getSegmenter,
	getWidthConfigEpoch,
	replaceTabs,
	visibleWidth,
} from "../utils";
import { getMarkdownTheme } from "../theme/theme";
import { parseAnsiRow } from "../core/ansi";
import { sgrFull } from "../core/emit";
import { Clip, over, Pad, spaces, Wrap } from "../core/out";
import { type Out, RichText, RunFlag } from "../core/richtext";
import { type Color, linkId, linkUrl, parseColor, rgb, Style } from "../core/style";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

// Marked treats the backslash in an ST-terminated OSC 8 sequence (`ESC \\`) as
// Markdown punctuation when it is immediately followed by markup such as a
// codespan backtick. Normalize well-formed OSC 8 prefixes to the equivalent BEL
// terminator before lexing so the control sequence stays opaque to Markdown.
const OSC8_ST_PREFIX_REGEX = /(\x1b\]8;[^\x07\x1b]*)\x1b\\/g;

function normalizeOsc8Terminators(text: string): string {
	return text.replace(OSC8_ST_PREFIX_REGEX, "$1\x07");
}

/** The longest suffix of `text` a future append could still complete into a
 *  full `\x1b]8;[^\x07\x1b]*\x1b\\` match: the last `\x1b]8;` plus clean
 *  body (or that plus the pending ST-ESC `\x1b`), or a strict prefix of the
 *  escape start. Any other suffix is already normalized or uncompletable
 *  (a BEL or an ESC follows it), so this is exactly the region a crossing
 *  match can occupy. */
function trailingOsc8Partial(text: string): string | undefined {
	const start = text.lastIndexOf("\x1b]8;");
	if (start !== -1) {
		const body = text.slice(start + 4);
		const cut = body.search(/[\x07\x1b]/);
		if (cut === -1 || (cut === body.length - 1 && body.charCodeAt(cut) === 0x1b)) {
			return text.slice(start);
		}
	}
	if (text.endsWith("\x1b]8;") || text.endsWith("\x1b]8") || text.endsWith("\x1b]") || text.endsWith("\x1b")) {
		return text.slice(text.lastIndexOf("\x1b"));
	}
	return undefined;
}

const MARKDOWN_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const MARKDOWN_HEADING_LINE = /^ {0,3}#{1,6}[ \t]+\S/;
const FENCED_SOURCE_INTRO = /\b(?:code|example|markdown|output|snippet|source)\s*:?\s*$/i;

function isGfmTableDelimiter(line: string, headerLine: string | undefined): boolean {
	if (!headerLine || !line.includes("|") || !headerLine.includes("|")) return false;
	const delimiterCells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
	const headerCells = headerLine.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
	return (
		delimiterCells.length >= 2 &&
		headerCells.length === delimiterCells.length &&
		delimiterCells.every(cell => /^:?-{3,}:?$/.test(cell.trim())) &&
		headerCells.every(cell => cell.trim().length > 0)
	);
}

/**
 * Gemini can emit a bare closing fence without its opener, then continue with
 * headings and tables. CommonMark must interpret that lone fence as an opener,
 * which turns the rest of an otherwise valid report into one raw code block.
 *
 * Repair only the unambiguous rich-document shape at final render: one
 * unmatched bare fence after prose, followed by both an ATX heading and a GFM
 * table delimiter. Keep ordinary incomplete code blocks, fenced Markdown
 * examples, and every matched fence untouched.
 */
function repairOrphanClosingFence(text: string): string {
	const lines = text.split("\n");
	let open: { index: number; marker: string; info: string } | undefined;
	for (let index = 0; index < lines.length; index++) {
		const match = MARKDOWN_FENCE_LINE.exec(lines[index]!);
		if (!match) continue;
		const marker = match[1]!;
		const info = match[2]!.trim();
		if (!open) {
			open = { index, marker, info };
			continue;
		}
		if (marker[0] === open.marker[0] && marker.length >= open.marker.length && info === "") {
			open = undefined;
		}
	}
	if (open?.info !== "") return text;

	let previous = "";
	for (let index = open.index - 1; index >= 0; index--) {
		previous = lines[index]!.trim();
		if (previous) break;
	}
	if (!previous || previous.endsWith(":") || FENCED_SOURCE_INTRO.test(previous)) return text;

	let hasHeading = false;
	let hasTableDelimiter = false;
	for (let index = open.index + 1; index < lines.length; index++) {
		const line = lines[index]!;
		hasHeading ||= MARKDOWN_HEADING_LINE.test(line);
		hasTableDelimiter ||= isGfmTableDelimiter(line, lines[index - 1]);
		if (hasHeading && hasTableDelimiter) {
			lines.splice(open.index, 1);
			return lines.join("\n");
		}
	}
	return text;
}

// OSC 66 (Kitty text-sizing) heading spans are emitted as one indivisible raw
// run. Re-wrapping would split the sized payload and padding would append cells
// past the doubled glyph.

function normalizeHtmlEntitiesForTerminal(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch {
				// Fallback to empty string or original if invalid codepoint
			}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.startsWith("#")) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}

interface HtmlListState {
	type: "ol" | "ul";
	next: number;
}

interface HtmlNormalizationState {
	lists: HtmlListState[];
	openItems: boolean[];
	itemHasContent: boolean[];
}

function createHtmlNormalizationState(): HtmlNormalizationState {
	return { lists: [], openItems: [], itemHasContent: [] };
}

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const HTML_TAG_REGEX = /<\/?(?:br|p|ol|ul|li|span|text|code|hr|blockquote)\b(?:\s[^>]*)?\s*\/?>/gi;
// Block-level HTML that needs structural (not just textual) rendering: standalone
// `<hr>` becomes a rule and balanced `<blockquote>…</blockquote>` renders with
// quote styling. Group 1 captures blockquote inner content; it is undefined for hr.
const BLOCK_HTML_REGEX = /<hr\b[^>]*\/?>|<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi;

function htmlTagName(tag: string): string {
	const match = /^<\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(tag);
	return match ? match[1].toLowerCase() : "";
}

function htmlOlStart(tag: string): number {
	const match = /\bstart\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i.exec(tag);
	if (!match) return 1;
	return Number(match[1] ?? match[2] ?? match[3]);
}

function appendHtmlLineBreak(output: string, force: boolean = false): string {
	const trimmed = output.replace(/[ \t]+$/u, "");
	return !force && trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

function htmlListIndent(state: HtmlNormalizationState): string {
	return "  ".repeat(Math.max(0, state.lists.length - 1));
}

function appendHtmlListBreak(output: string, state: HtmlNormalizationState): string {
	const indent = htmlListIndent(state);
	return output.endsWith(`${indent}\n`) ? output : appendHtmlLineBreak(output);
}

function markCurrentHtmlItemContent(state: HtmlNormalizationState, text: string): void {
	if (text.trim() !== "" && state.itemHasContent.length > 0) {
		state.itemHasContent[state.itemHasContent.length - 1] = true;
	}
}

function isAtEmptyHtmlListItem(state: HtmlNormalizationState): boolean {
	const itemIndex = state.itemHasContent.length - 1;
	return state.openItems[itemIndex] === true && state.itemHasContent[itemIndex] !== true;
}

function normalizeHtmlForTerminal(raw: string, state: HtmlNormalizationState = createHtmlNormalizationState()): string {
	let output = "";
	let lastIndex = 0;
	let inCode = false;
	const withoutComments = raw.replace(HTML_COMMENT_REGEX, "");

	for (const match of withoutComments.matchAll(HTML_TAG_REGEX)) {
		const tag = match[0];
		const index = match.index ?? 0;
		const textBeforeTag = normalizeHtmlEntitiesForTerminal(withoutComments.slice(lastIndex, index));
		const name = htmlTagName(tag);
		// Most tags handled here are block-level. Inline contexts — span, text, and
		// the content inside a `<code>` run — keep their surrounding whitespace
		// verbatim because it is significant. For block-level tags, HTML formatting
		// whitespace between tags (e.g. the newlines and indentation in
		// pretty-printed `<ul>\n  <li>…`) is not rendered content; appending it
		// literally would leak source indentation before bullets and blank rows
		// between items, so a whitespace-only slice is dropped.
		const isInlineTag = name === "span" || name === "text";
		if (isInlineTag || inCode || textBeforeTag.trim() !== "") {
			output += textBeforeTag;
			markCurrentHtmlItemContent(state, textBeforeTag);
		}
		lastIndex = index + tag.length;

		const isClosing = tag.startsWith("</");
		const isSelfClosing = /\/\s*>$/.test(tag);

		switch (name) {
			case "span":
			case "text":
				break;
			case "code":
				if (isClosing) inCode = false;
				else if (!isSelfClosing) inCode = true;
				break;
			case "br":
			case "hr":
				output = appendHtmlLineBreak(output, true);
				break;
			case "p":
			case "blockquote":
				if (isClosing) {
					output = appendHtmlLineBreak(output);
				} else if (output.trim() !== "" && !output.endsWith("\n") && !isAtEmptyHtmlListItem(state)) {
					output = appendHtmlLineBreak(output);
				}
				break;
			case "ol":
				if (isClosing) {
					state.lists.pop();
					state.openItems.pop();
					state.itemHasContent.pop();
				} else if (!isSelfClosing) {
					if (state.openItems.length > 0 && state.openItems[state.openItems.length - 1]) {
						output = appendHtmlListBreak(output, state);
					}
					state.lists.push({ type: "ol", next: htmlOlStart(tag) });
					state.openItems.push(false);
					state.itemHasContent.push(false);
				}
				break;
			case "ul":
				if (isClosing) {
					state.lists.pop();
					state.openItems.pop();
					state.itemHasContent.pop();
				} else if (!isSelfClosing) {
					if (state.openItems.length > 0 && state.openItems[state.openItems.length - 1]) {
						output = appendHtmlListBreak(output, state);
					}
					state.lists.push({ type: "ul", next: 1 });
					state.openItems.push(false);
					state.itemHasContent.push(false);
				}
				break;
			case "li": {
				if (isClosing) {
					output = appendHtmlLineBreak(output);
					break;
				}
				if (state.openItems.length > 0) {
					const itemOpenIndex = state.openItems.length - 1;
					if (state.openItems[itemOpenIndex]) output = appendHtmlListBreak(output, state);
					state.openItems[itemOpenIndex] = true;
					state.itemHasContent[itemOpenIndex] = false;
				} else if (output.trim() !== "" && !output.endsWith("\n")) {
					output = appendHtmlLineBreak(output);
				}
				const list = state.lists[state.lists.length - 1];
				const indent = htmlListIndent(state);
				if (list?.type === "ol") {
					output += `${indent}${list.next}. `;
					list.next++;
				} else {
					output += `${indent}• `;
				}
				break;
			}
			default:
				output += tag;
				break;
		}
	}

	const remainingText = normalizeHtmlEntitiesForTerminal(withoutComments.slice(lastIndex));
	markCurrentHtmlItemContent(state, remainingText);
	return output + remainingText;
}

function splitTerminalLines(text: string): string[] {
	const lines = text.split("\n");
	while (lines.length > 1 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Tree-guide hanging wrap
//
// Models routinely emit box-drawing trees ("├── item") inside plain
// paragraphs — directory layouts, decision trees. The lexer sees those lines
// as ordinary prose, so the generic wrap pass restarts wrapped continuations
// at column 0 and visually shears the tree apart (doubly fast for CJK text,
// where every glyph is two cells wide). Mirror the guide semantics of
// `tree(1)` / rich.tree instead: wrap the node text within the cells that
// remain after the guide prefix, and indent every continuation row under the
// node text — branch glyphs swap to their pass-through form (`├` → `│`,
// `└` → blank) so the rails of still-open ancestors stay visually joined.
// ---------------------------------------------------------------------------

/** Continuation glyph for each guide character a tree prefix may contain. */
const TREE_GUIDE_CONTINUATION: Record<string, string> = {
	"│": "│",
	"┃": "┃",
	"║": "║",
	"├": "│",
	"┣": "┃",
	"╠": "║",
	"└": " ",
	"┗": " ",
	"╚": " ",
	"╰": " ",
	"─": " ",
	"━": " ",
	"═": " ",
	" ": " ",
};

/** Cheap pre-gate: any guide glyph at all. The structural test is TREE_BRANCH_CONNECTOR_RE. */
const TREE_GUIDE_ANCHOR_RE = /[│┃║├┣╠└┗╚╰]/;

/**
 * A prefix qualifies as tree-shaped only when a branch/corner glyph is
 * immediately followed by a horizontal connector (`├──`, `└─`, `╰──`, …).
 * A lone rail or branch glyph used as prose ("│ is the Unicode vertical box
 * drawing glyph…") never qualifies, so such paragraphs keep the plain wrap.
 */
const TREE_BRANCH_CONNECTOR_RE = /[├┣╠└┗╚╰][─━═]/;

/** Below this many content cells a hanging wrap degenerates; keep the plain wrap. */
const MIN_TREE_CONTENT_WIDTH = 8;

const SGR_SEQUENCE_STICKY = /\x1b\[[0-9;:]*m/y;

interface TreeGuidePrefix {
	/** Index of the first char past the guide run (start of the node text). */
	end: number;
	/** SGR sequences interleaved with the guides, in order (zero visible width). */
	codes: string;
	/** Guide characters with SGR stripped, exactly as they appear on screen. */
	guides: string;
}

/**
 * Match the leading box-drawing guide run of a rendered line (e.g. `│   ├── `),
 * tolerating interleaved SGR styling. Returns undefined unless the run
 * contains a branch glyph joined to a horizontal connector and node text
 * follows, so dash art, indented prose, and lone glyphs used as prose are
 * never treated as a tree.
 */
function matchTreeGuidePrefix(line: string): TreeGuidePrefix | undefined {
	let codes = "";
	let guides = "";
	let i = 0;
	while (i < line.length) {
		if (line.charCodeAt(i) === 0x1b) {
			SGR_SEQUENCE_STICKY.lastIndex = i;
			const match = SGR_SEQUENCE_STICKY.exec(line);
			if (!match) break;
			codes += match[0];
			i = SGR_SEQUENCE_STICKY.lastIndex;
			continue;
		}
		const char = line[i]!;
		if (!(char in TREE_GUIDE_CONTINUATION)) break;
		guides += char;
		i++;
	}
	if (i >= line.length || !TREE_BRANCH_CONNECTOR_RE.test(guides)) return undefined;
	return { end: i, codes, guides };
}

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

// Math spans (`$$…$$`, `\[…\]`, `$…$`, `\(…\)`) are tokenized as a dedicated
// `math` inline token before markdown's escape/emphasis/link rules run, so
// backslash commands (`\frac`, `\alpha`) and intraword underscores (`x_i`)
// survive intact instead of being mangled or split. The `$…$` form uses
// pandoc's anti-currency heuristic (`mathSpanAt`) so "$5 and $10" is
// never math. Inline extensions run before marked's escape tokenizer, so
// `\(…\)` becomes math while a genuinely escaped `\$` is left to `escape` and
// renders as a literal dollar.
const CUSTOM_HR_START_REGEX = /(?:^|\n) {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;
const CUSTOM_HR_TOKENIZER_REGEX = /^ {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;

function getHrChar(char: string, hrChar: string): string {
	const isAscii = hrChar === "-";
	switch (char) {
		case "=":
			return "=";
		case "═":
			return isAscii ? "=" : "═";
		case "━":
			return isAscii ? "-" : "━";
		case "─":
			return isAscii ? "-" : "─";
		case "–":
			return isAscii ? "-" : "–";
		case "—":
			return isAscii ? "-" : "—";
		default:
			return hrChar;
	}
}

const customHrExtension: TokenizerAndRendererExtension = {
	name: "customHr",
	level: "block",
	start(src) {
		const match = CUSTOM_HR_START_REGEX.exec(src);
		if (!match) return undefined;
		let idx = match.index;
		if (src[idx] === "\n") {
			idx += 1;
		}
		return idx;
	},
	tokenizer(src) {
		const match = CUSTOM_HR_TOKENIZER_REGEX.exec(src);
		if (match) {
			return {
				type: "hr",
				raw: match[0],
			};
		}
		return undefined;
	},
	renderer() {
		return "";
	},
};

// Delimiters come from `@oh-my-pi/pi-utils/math-delimiters`; rendering policy stays here.
const mathExtension: TokenizerAndRendererExtension = {
	name: "math",
	level: "inline",
	start: mathStartIndex,
	tokenizer(src) {
		const span = mathSpanAt(src, 0);
		if (!span) return undefined;
		return { type: "math", raw: src.slice(0, span.end), text: span.body, display: span.display };
	},
	renderer(token) {
		return typeof token.text === "string" ? token.text : "";
	},
};

const mathBlockExtension: TokenizerAndRendererExtension = {
	name: "mathBlock",
	level: "block",
	// No `start` hint: marked only probes block extensions at a block boundary
	// here and never consults their hints.
	tokenizer(src) {
		const block = mathBlockAt(src);
		if (!block) return undefined;
		return { type: "math", raw: block.raw, text: block.body, display: true };
	},
	renderer(token) {
		return typeof token.text === "string" ? token.text : "";
	},
};

// Bare (delimiter-less) display-math environments: `\begin{<mathenv>}…\end{…}`
// written without `$$`/`\[` fences (common in raw model output). Captured at the
// block level as a whole unit — including any immediately preceding `lhs =`
// line — so marked never splits it on inline `\\` row breaks. Restricted to math
// environments (isBareMathEnvironment), and the `≤3 leading spaces` + "block
// starts at offset 0" guards keep fenced/indented `\begin{cases}` code blocks
// for marked's own code rules.
const BARE_ENV_BEGIN = /(?:^|\n)[ \t]{0,3}\\begin\{([A-Za-z]+\*?)\}/;
function bareMathEnvBlock(src: string): readonly [number, number] | null {
	const bm = BARE_ENV_BEGIN.exec(src);
	if (!bm || !isBareMathEnvironment(bm[1])) return null;
	const beginLineStart = bm.index === 0 ? 0 : bm.index + 1; // skip the matched leading `\n`
	const endToken = `\\end{${bm[1]}}`;
	const endAt = src.indexOf(endToken, bm.index);
	if (endAt === -1) return null;
	// The `\end` must close before any blank line (i.e. within the same block).
	if (/\n[ \t]*\n/.test(src.slice(beginLineStart, endAt))) return null;
	let blockEnd = endAt + endToken.length;
	while (src[blockEnd] === " " || src[blockEnd] === "\t") blockEnd++;
	if (src[blockEnd] === "\n") blockEnd++;
	// Pull in one immediately-preceding `lhs =`/open-delimiter line (e.g. `f(x) =`).
	let start = beginLineStart;
	if (start > 0 && src[start - 1] === "\n") {
		const prevStart = src.lastIndexOf("\n", start - 2) + 1;
		const prevLine = src.slice(prevStart, start - 1);
		if (/[=([{]\s*$/.test(prevLine)) start = prevStart;
	}
	return [start, blockEnd];
}
const mathEnvBlockExtension: TokenizerAndRendererExtension = {
	name: "mathEnvBlock",
	level: "block",
	start(src) {
		const r = bareMathEnvBlock(src);
		return r ? r[0] : undefined;
	},
	tokenizer(src) {
		const r = bareMathEnvBlock(src);
		if (r?.[0] !== 0) return undefined; // only consume when the block starts at offset 0
		const raw = src.slice(0, r[1]);
		const text = raw.replace(/\n[ \t]*$/, "");
		if (text.trim().length === 0) return undefined;
		return { type: "math", raw, text, display: true };
	},
	renderer(token) {
		return (token as { text?: string }).text ?? "";
	},
};

// GFM's extended autolinks (`www.`, `http:/`, `https:/`, `ftp:/`) may only
// begin at a valid left boundary: start of line, whitespace, or one of `* _ ~ (`
// (https://github.github.com/gfm/#autolinks-extension-). marked's bundled `url`
// tokenizer instead fires after ANY character, so a local path such as
// `~/meta/www.share/blog/index.dj` is mangled into a `http://www.share/...`
// link. This inline extension runs before the built-in tokenizer: when an
// autolink candidate is glued to an invalid preceding character it emits the
// bare scheme prefix as literal text, so the remainder never reaches the `url`
// tokenizer at a valid start. Candidates at a legal boundary fall through
// (return undefined) to marked's own autolink handling unchanged.
const AUTOLINK_SCHEME_REGEX = /^(?:www\.|https?:\/\/|ftp:\/\/)/i;
// Case-insensitive scheme scan replacing /www\.|https?:\/\/|ftp:\/\/i in
// boundedAutolinkExtension.start — like `mathStartIndex`, this runs on the
// remaining source at every inline position (part of a ~4.3% CPU start() scan
// tail in profiles). charCode-only: no allocation, no toLowerCase copies.
// `| 32` lower-cases ASCII letters; `.`/`:`/`/` are compared exactly, matching
// the regex's ASCII-only `i` semantics. charCodeAt past the end returns NaN,
// which fails every comparison, so no explicit bounds checks are needed.
function isAutolinkSchemeAt(src: string, i: number): boolean {
	const c = src.charCodeAt(i) | 32;
	if (c === 119 /* w */) {
		// www.
		return (
			(src.charCodeAt(i + 1) | 32) === 119 &&
			(src.charCodeAt(i + 2) | 32) === 119 &&
			src.charCodeAt(i + 3) === 46 /* . */
		);
	}
	if (c === 104 /* h */) {
		// http:/ | https:/
		if (
			(src.charCodeAt(i + 1) | 32) !== 116 /* t */ ||
			(src.charCodeAt(i + 2) | 32) !== 116 /* t */ ||
			(src.charCodeAt(i + 3) | 32) !== 112 /* p */
		) {
			return false;
		}
		let j = i + 4;
		if ((src.charCodeAt(j) | 32) === 115 /* s */) j++;
		return src.charCodeAt(j) === 58 /* : */ && src.charCodeAt(j + 1) === 47 /* / */ && src.charCodeAt(j + 2) === 47;
	}
	if (c === 102 /* f */) {
		// ftp:/
		return (
			(src.charCodeAt(i + 1) | 32) === 116 /* t */ &&
			(src.charCodeAt(i + 2) | 32) === 112 /* p */ &&
			src.charCodeAt(i + 3) === 58 /* : */ &&
			src.charCodeAt(i + 4) === 47 /* / */ &&
			src.charCodeAt(i + 5) === 47 /* / */
		);
	}
	return false;
}

/** @internal exported for tests — must stay index-identical to the old regex scan. */
export function autolinkSchemeScanIndex(src: string): number | undefined {
	for (let i = 0; i < src.length; i++) {
		const c = src.charCodeAt(i) | 32;
		if ((c === 119 || c === 104 || c === 102) && isAutolinkSchemeAt(src, i)) return i;
	}
	return undefined;
}
const VALID_AUTOLINK_LEFT_BOUNDARY = /[\s*_~(]/;
const boundedAutolinkExtension: TokenizerAndRendererExtension = {
	name: "boundedAutolink",
	level: "inline",
	start(src) {
		return autolinkSchemeScanIndex(src);
	},
	tokenizer(src, tokens) {
		const match = AUTOLINK_SCHEME_REGEX.exec(src);
		if (!match) return undefined;
		const prevChar = tokens.at(-1)?.raw?.at(-1);
		// Start of line or a legal delimiter → let marked autolink it.
		if (prevChar === undefined || VALID_AUTOLINK_LEFT_BOUNDARY.test(prevChar)) return undefined;
		// Glued to an invalid character (e.g. `/`, a letter, `.`): consume only
		// the scheme prefix as text so the built-in `url` tokenizer cannot match.
		const raw = match[0];
		return { type: "text", raw, text: raw };
	},
};
markdownParser.use({
	extensions: [customHrExtension, mathBlockExtension, mathEnvBlockExtension, mathExtension, boundedAutolinkExtension],
});

// ---------------------------------------------------------------------------
// GFM `url` tokenizer gate
// ---------------------------------------------------------------------------
// marked tries the bundled GFM `url` tokenizer at every inline tokenization
// step, and its regex is expensive to FAIL: the email alternative
// `^[A-Za-z0-9._+-]+(@)…` linearly consumes an identifier run, then backtracks
// it one character at a time when no `@` follows. A 71414-sample / 1ms CPU
// profile of the TUI put 73.3% of total CPU (74.9s of a 102s capture) inside
// this single regex. The override below runs an O(bounded) charCode gate first
// and only falls through to the built-in tokenizer — by returning `false`,
// marked's tokenizer-override fallback contract — when a match is possible.
//
// Conservativeness argument. The built-in rule (no flags) is
//   /^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*
//    |^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/
// Both alternatives are anchored, so any match constrains the head of src:
//  • Branch 1 requires src to start with `http:/`, `https:/`, `ftp:/`
//    (scheme letters in any case) or lowercase `www.`. The gate accepts all of
//    these via isAutolinkSchemeAt(src, 0); it also over-accepts `WWW.`, a
//    harmless false positive (the built-in regex simply fails to match).
//  • Branch 2 requires src to start with one-or-more chars from
//    `[A-Za-z0-9._+-]` immediately followed by `@`. The gate scans that exact
//    class: if the run ends within URL_GATE_EMAIL_SCAN_LIMIT chars it accepts
//    iff the terminator is `@`; a run reaching the limit is accepted
//    unconditionally. Every src branch 2 can match is therefore accepted —
//    the gate never rejects a src the built-in regex would match.
const URL_GATE_EMAIL_SCAN_LIMIT = 320;

/** @internal exported for tests — must never return false for a src the built-in url regex matches. */
export function urlTokenPossible(src: string): boolean {
	if (isAutolinkSchemeAt(src, 0)) return true;
	let i = 0;
	while (i < URL_GATE_EMAIL_SCAN_LIMIT) {
		const c = src.charCodeAt(i);
		const isLocalChar =
			(c >= 97 && c <= 122) /* a-z */ ||
			(c >= 65 && c <= 90) /* A-Z */ ||
			(c >= 48 && c <= 57) /* 0-9 */ ||
			c === 46 /* . */ ||
			c === 95 /* _ */ ||
			c === 43 /* + */ ||
			c === 45; /* - */
		if (!isLocalChar) break;
		i++;
	}
	if (i === 0) return false;
	if (i >= URL_GATE_EMAIL_SCAN_LIMIT) return true; // over-long run: give up conservatively
	return src.charCodeAt(i) === 64; /* @ */
}

// Setext-underline pre-gate for marked's `lheading` rule. The rule's lazy body
// `((?:.|\n(?!<block-start>))+?)` re-runs its block-start lookahead while
// expanding character by character, so even a FAILING attempt at offset 0
// costs O(len × lookahead) — ~26µs per 200-char list-item body, and marked's
// list tokenizer block-tokenizes every item's content (47.8% of a streaming
// bench profile). A match REQUIRES the setext underline `\n {0,3}(=+|-+)`
// somewhere in src, so this O(n) charCode scan never rejects a src the
// built-in rule would match; single-line srcs (every tight list item) reject
// on the first indexOf.
function lheadingPossible(src: string): boolean {
	let i = src.indexOf("\n");
	while (i !== -1) {
		let j = i + 1;
		const limit = j + 3; // underline allows up to 3 leading spaces
		while (j < limit && src.charCodeAt(j) === 0x20 /* space */) j++;
		const c = src.charCodeAt(j); // NaN past the end fails both comparisons
		if (c === 0x3d /* = */ || c === 0x2d /* - */) return true;
		i = src.indexOf("\n", j);
	}
	return false;
}

markdownParser.use({
	tokenizer: {
		// `false` → marked falls back to the built-in tokenizer;
		// `undefined` → no token here, built-in never runs.
		url(src: string): Tokens.Link | undefined | false {
			return urlTokenPossible(src) ? false : undefined;
		},
		lheading(src: string): Tokens.Heading | undefined | false {
			return lheadingPossible(src) ? false : undefined;
		},
	},
});

// ---------------------------------------------------------------------------
// Sticky clones of marked's pathological block rules
// ---------------------------------------------------------------------------
// Bun's (JSC) regex engine skips the start-anchor fast-fail for several of
// marked's `^`-anchored block rules — `hr`, `lheading`, `table` and `html` are
// anchored alternations of quantified branches, and a failing `exec`/`test`
// rescans the entire remaining source instead of stopping after offset 0.
// marked's list tokenizer runs `hr.test` and `lheading` per list line against
// the remaining source, so lexing a long list is quadratic (66% of a streaming
// bench profile sat in these two regexes). A sticky (`y`) clone with
// `lastIndex` pinned to 0 attempts the match at offset 0 only.
//
// Equivalence: for a flagless rule whose source is `^`-anchored, a sticky
// clone at `lastIndex = 0` matches exactly when the original matches (same
// match object, same captures) — `^` already restricted matches to offset 0
// (no `m` flag), and stickiness only removes the futile later attempts. The
// flags/anchor guard below skips any rule a future marked version changes.
class AnchoredAtZero extends RegExp {
	override exec(str: string): RegExpExecArray | null {
		this.lastIndex = 0; // sticky matches set lastIndex; rules are shared
		return super.exec(str);
	}
	override test(str: string): boolean {
		this.lastIndex = 0;
		return super.test(str);
	}
}

for (const table of [Lexer.rules.block.normal, Lexer.rules.block.gfm]) {
	for (const name of ["hr", "lheading", "table", "html"] as const) {
		const rule = table[name];
		if (rule.flags === "" && rule.source.startsWith("^")) {
			table[name] = new AnchoredAtZero(rule.source, "y");
		}
	}
}

// ---------------------------------------------------------------------------
// Native paint signature invalidation
// ---------------------------------------------------------------------------
// Resource/theme refreshes invalidate native markdown paint signatures across roots.

let renderCacheEpoch = 0;

// A reference-link definition (`[label]: dest`) resolves across the whole
// document, so a split lex cannot reproduce it — disable the streaming fast path
// when one is present (rare in streamed output). The label may contain
// backslash-escaped characters (`[a\]b]: x`), so escapes are matched explicitly;
// over-matching is safe (it only costs the fast path), under-matching is not.
const REF_DEF_LINE_RE = /^ {0,3}\[(?:\\.|[^\]\\])+\]:/;
const HAS_REF_DEF = new RegExp(REF_DEF_LINE_RE.source, "m");

// marked's list tokenizer (Tokenizer.list, marked v18) continues a list across
// blank lines only when the remaining source matches
// `listItemRegex(marker)` = `^( {0,3}${marker})((?:[\t ][^\n]*)?(?:\n|$))`,
// where `marker` is the exact bullet char for unordered lists (`\${char}`) or
// 1-9 digits plus the exact delimiter for ordered lists (`\d{1,9}\${delim}`).
// The marker is derived from the list's FIRST item (`n = t[1].trim()`), which
// sits at the start of a top-level list token's raw:
const LIST_MARKER_RE = /^ {0,3}(?:([*+-])|\d{1,9}([.)]))/;

// Streaming-freeze equivalence invariant: lex(prefix) ++ lex(tail) must equal
// lex(full text) — for the CURRENT text and for every append-only extension of
// it, because a frozen prefix is sticky (it keeps being reused while the text
// grows). At a blank-line (`\n\n`) cut directly after a top-level `list`
// token, the only construct that can straddle the cut is a continuation item
// of that list: marked consumed the blank line into the last item's raw and
// re-ran `listItemRegex` at exactly `tailStart`, merging a same-marker item
// into one renumbered loose list. The cut is safe only when that regex can
// NEVER match at `tailStart`, no matter what is appended later.
//
// Append-only growth means existing characters are immutable while new ones
// may appear after them, so "closed" may only be concluded from a present
// character that contradicts every possible continuation (e.g. tail "1x" can
// never grow into an ordered item, but tail "1" can become "1. c"). Running
// out of text mid-marker therefore answers "may continue".
//
// Returns true when the tail could still continue the list (or the list's
// marker is unrecognizable) — the conservative "don't freeze" answer. marked
// may break the list anyway when the matching line is also an hr (`- - -`);
// treating that as "may continue" merely skips a freeze, never corrupts one.
function listMayContinueAt(text: string, tailStart: number, listRaw: string): boolean {
	const marker = LIST_MARKER_RE.exec(listRaw);
	if (marker === null) return true; // unrecognized list shape — stay conservative
	const n = text.length;
	let i = tailStart;
	// `listItemRegex` allows up to 3 leading spaces (the caller's next-char
	// guard rejects whitespace at the final cut, but mirror the rule exactly).
	while (i < n && i - tailStart < 3 && text.charCodeAt(i) === 0x20 /* space */) i++;
	if (i >= n) return true;
	const bullet = marker[1];
	if (bullet !== undefined) {
		if (text[i] !== bullet) return false; // wrong marker char — closed forever
		i++;
	} else {
		// Ordered: 1-9 digits, then the same `.`/`)` delimiter.
		let digits = 0;
		while (i < n && digits < 10) {
			const c = text.charCodeAt(i);
			if (c < 0x30 /* 0 */ || c > 0x39 /* 9 */) break;
			digits++;
			i++;
		}
		if (digits === 0 || digits > 9) return false; // no digit run / too long — closed forever
		if (i >= n) return true; // delimiter (or more digits) may still arrive
		if (text[i] !== marker[2]) return false; // wrong delimiter — closed forever
		i++;
	}
	// After the marker: `(?:[\t ][^\n]*)?(?:\n|$)` — tab/space + anything, a
	// bare newline, or end-of-input (which appends can still extend).
	if (i >= n) return true;
	const after = text.charCodeAt(i);
	return after === 0x20 /* space */ || after === 0x09 /* tab */ || after === 0x0a; /* \n */
}

const NO_BLOCK_BOUNDARY = { end: 0, count: 0 } as const;

/**
 * Offset just past the last token in `tokens` that closes a block on a hard
 * `"\n\n"` break, together with the number of tokens up to and including it.
 * `count === 0` means the run holds no usable boundary.
 *
 * `base` is where `tokens[0]` starts inside `text`. A boundary qualifies only
 * when splitting there is invisible to the lexer, i.e. `lex(head) ++ lex(tail)
 * === lex(text)`:
 *  - The break must sit inside `text`. At end-of-text the next character is
 *    unknown (and, while streaming, may still arrive), so the cut is deferred.
 *  - The next character must start real block content. Whitespace means the
 *    block separator straddles the cut — e.g. a fence followed by
 *    `"\n\n\n- list"` — and the two lexes desync.
 *  - A preceding `list` must be provably closed: CommonMark lets a same-marker
 *    item continue the list across the blank line, and marked merges both into
 *    one renumbered loose list (`listMayContinueAt`).
 *
 * `startIndex` resumes the scan at `tokens[startIndex]` (positions still
 * accumulate from `base`). The streaming freeze passes the frozen-prefix
 * token count: that prefix's boundary is permanent under append-only growth
 * (re-verified when frozen), so only the mutable tail can hold a new one.
 */
function stableBlockBoundary(
	text: string,
	base: number,
	tokens: Token[],
	startIndex = 0,
): { end: number; count: number } {
	let pos = base;
	let end = 0;
	let count = 0;
	for (let i = startIndex; i < tokens.length; i++) {
		const raw = tokens[i].raw;
		const tokenEnd = pos + raw.length;
		if (raw.endsWith("\n\n")) {
			const prev = i > 0 ? tokens[i - 1] : undefined;
			if (prev === undefined || prev.type !== "list" || !listMayContinueAt(text, tokenEnd, prev.raw)) {
				end = tokenEnd;
				count = i + 1;
			}
		}
		pos = tokenEnd;
	}
	if (count === 0 || end >= text.length) return NO_BLOCK_BOUNDARY;
	const next = text.charCodeAt(end);
	if (next === 0x20 /* space */ || next === 0x0a /* \n */) return NO_BLOCK_BOUNDARY;
	return { end, count };
}

// Bun's regex engine skips the start-anchor optimization for several of marked's
// block rules — `hr`, `lheading`, `table` and `html` are `^`-anchored
// alternations of quantified branches — so each failing `exec` rescans the whole
// remaining source instead of stopping at offset 0. Lexing is then quadratic in
// document length: an 800 KB message costs ~41 s under Bun where Node/V8 needs
// ~60 ms, and it runs on the render path, freezing the UI. Bounded windows keep
// every scan short and restore linear behavior (~0.7 s for that same message).
const LEX_WINDOW_BYTES = 2 * 1024;
// Under this size a single pass beats probing for window boundaries; the
// crossover measured on pathological Markdown sits around 16 KB.
const WINDOWED_LEX_MIN_BYTES = 16 * 1024;

/**
 * Lex `text` in bounded windows, producing the exact token stream
 * `markdownParser.lexer(text)` would.
 *
 * Window cuts come from marked itself: a throwaway BLOCK-ONLY probe lex of the
 * window reports its last stable block boundary ({@link stableBlockBoundary})
 * and only that confirmed segment is handed to the real lexer; a window
 * holding no boundary doubles until it finds one or reaches the end. Probes
 * never run inline tokenization (their inlineQueue is discarded) — a boundary
 * is a property of block structure alone, and probe inline passes were the
 * dominant cost of an earlier revision. Block tokenization runs per window
 * while inline tokenization is deferred to the end — mirroring `Lexer.lex` —
 * so a `[label]: dest` definition anywhere in the document still resolves for
 * every inline span.
 *
 * A boundary requires some top-level token whose raw ends in `"\n\n"`, so a
 * window that contains no blank line cannot cut: each round starts at the next
 * `"\n\n"` (skipping straight to the end when there is none — e.g. a tail
 * that is one long tight list) instead of probing sizes that cannot succeed.
 */
function lexWindowed(text: string): Token[] {
	const lexer = new Lexer(markdownParser.defaults);
	let offset = 0;
	while (offset < text.length) {
		let segment = "";
		const nextBlank = text.indexOf("\n\n", offset);
		if (nextBlank === -1) {
			segment = text.slice(offset);
		} else {
			const minSize = Math.max(LEX_WINDOW_BYTES, nextBlank + 2 - offset);
			for (let size = minSize; segment.length === 0; size *= 2) {
				if (offset + size >= text.length) {
					segment = text.slice(offset);
					break;
				}
				const probe = new Lexer(markdownParser.defaults);
				probe.blockTokens(text.slice(offset, offset + size), probe.tokens);
				const boundary = stableBlockBoundary(text, offset, probe.tokens);
				if (boundary.count > 0) segment = text.slice(offset, boundary.end);
			}
		}
		lexer.blockTokens(segment, lexer.tokens);
		offset += segment.length;
	}
	for (const queued of lexer.inlineQueue) lexer.inlineTokens(queued.src, queued.tokens);
	lexer.inlineQueue = [];
	return lexer.tokens;
}

/** Lex a whole document, windowing anything large enough for the quadratic scan to bite. */
function lexDocument(text: string): Token[] {
	// A CR shifts every `raw` span (marked normalizes CRLF before tokenizing), so
	// window offsets would address the wrong characters — lex those in one pass.
	if (text.length < WINDOWED_LEX_MIN_BYTES || text.includes("\r")) return markdownParser.lexer(text);
	return lexWindowed(text);
}

/** A hyperlink as the renderer sees it: inline `[text](href)`, `<autolink>`, bare GFM URL, or reference link. */
export interface MarkdownLink {
	/** Flattened visible label with whitespace collapsed to one row; falls back to `href` when empty. */
	text: string;
	/** Destination exactly as marked resolved it (references resolved, no normalization). */
	href: string;
}

/**
 * Every link token in `text`, in document order, from the same configured
 * lexer the renderer uses — so fenced code, code spans, escapes, reference
 * definitions and the GFM autolink rules agree with what is drawn on screen.
 * Duplicate hrefs are kept; callers decide how to fold them.
 */
export function extractMarkdownLinks(text: string): MarkdownLink[] {
	const links: MarkdownLink[] = [];
	const walk = (tokens: readonly Token[] | undefined): void => {
		if (!tokens) return;
		for (const token of tokens) {
			if (token.type === "link") {
				const link = token as Tokens.Link;
				if (typeof link.href === "string" && link.href.length > 0) {
					const label = plainInlineTokens(link.tokens).replace(/\s+/g, " ").trim();
					links.push({ text: label || link.href, href: link.href });
				}
				continue;
			}
			// Containers: paragraphs, emphasis, lists, blockquotes, table cells.
			const any = token as {
				tokens?: Token[];
				items?: Token[];
				header?: Array<{ tokens?: Token[] }>;
				rows?: Array<Array<{ tokens?: Token[] }>>;
			};
			walk(any.tokens);
			walk(any.items);
			if (any.header) for (const cell of any.header) walk(cell.tokens);
			if (any.rows) for (const row of any.rows) for (const cell of row) walk(cell.tokens);
		}
	};
	walk(lexDocument(text));
	return links;
}

/** Invalidate cached render signatures after a mutable theme change. */
export function clearRenderCache(): void {
	renderCacheEpoch++;
}

// Stable numeric IDs for structural theme/style objects (no ID field on type).
// WeakMap-keyed so the ID matches strict object identity and doesn't get copied by spread/cloning.
const themeObjectIds = new WeakMap<object, number>();
let nextObjectId = 0;
function objectId(o: object): number {
	let id = themeObjectIds.get(o);
	if (id === undefined) {
		id = nextObjectId++;
		themeObjectIds.set(o, id);
	}
	return id;
}

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Run-native base style for all Markdown text. */
	style?: Style;
	/** Background fill composed beneath token styles. */
	backgroundStyle?: Style;
	/**
	 * Paint plain prose tokens directly into the run pipeline. Markdown invokes
	 * this for paragraph/list/blockquote/heading text, after resolving the base
	 * style, but never for code spans/fences, link labels, or table cells.
	 */
	paintProse?: (out: Out, text: string, base: Style) => void;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Stateful incremental code highlighter carrying parser state across pushes.
 * Produced per streaming fence by {@link MarkdownTheme.createHighlightStream}.
 */
export interface HighlightStreamSession {
	/** Highlight the next chunk and advance parser state. */
	push(chunk: string): string;
}

/** Collect distinct hyperlink destinations using the renderer's Markdown grammar, excluding images and code. */
export function getMarkdownLinkUrls(text: string): string[] {
	const urls = new Set<string>();
	markdownParser.walkTokens(markdownParser.lexer(text), token => {
		if (token.type === "link" && typeof token.href === "string") urls.add(token.href);
	});
	return [...urls];
}

/** Run styles for Markdown elements. */
export interface MarkdownTheme {
	heading: Style;
	link: Style;
	linkUrl: Style;
	/** Resolve the OSC 8 destination without changing visible text; undefined preserves the authored URL. */
	resolveLink?: (href: string) => string | undefined;
	code: Style;
	codeBlock: Style;
	codeBlockBorder: Style;
	quote: Style;
	quoteBorder: Style;
	hr: Style;
	listBullet: Style;
	bold: Style;
	italic: Style;
	strikethrough: Style;
	underline: Style;
	highlightCode?: (code: string, lang?: string) => string[];
	/**
	 * Create a stateful incremental highlighter for one streaming code fence.
	 * `push` receives newline-terminated complete lines (only the final push
	 * may omit the trailing newline) and must return highlighted ANSI text for
	 * exactly the pushed chunk, byte-identical to highlighting the concatenated
	 * text through `highlightCode`. Return null when `lang` is unsupported.
	 */
	createHighlightStream?: (lang?: string) => HighlightStreamSession | null;
	/**
	 * Resolve a mermaid ASCII rendering by fenced block source text.
	 * Return null to fall back to fenced code rendering.
	 */
	resolveMermaidAscii?: (source: string, maxWidth?: number) => string | null;
	symbols: SymbolTheme;
}

type ListToken = Token & { items: Array<{ tokens?: Token[] }>; ordered: boolean; start?: number };
type TableCellToken = { tokens?: Token[] };
type TableToken = Token & { header: TableCellToken[]; rows: TableCellToken[][]; raw?: string };

function isAsciiTextSizingPayload(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

function encodeTextSizedHeading(text: string, scale: 1 | 2 | 3): string {
	let out = "";
	let asciiRun = "";
	const flushAscii = () => {
		if (asciiRun === "") return;
		out += encodeTextSized(asciiRun, { scale });
		asciiRun = "";
	};

	for (const { segment } of getSegmenter().segment(text)) {
		if (isAsciiTextSizingPayload(segment)) {
			asciiRun += segment;
			continue;
		}
		flushAscii();
		out += encodeTextSized(segment, { scale, widthCells: visibleWidth(segment) });
	}
	flushAscii();
	return out;
}

const MATH_NEWLINES = /\n+/g;

/** True for the custom inline `math` token produced by the math extension. */
function isMathToken(token: Token): token is Token & { text: string; display: boolean } {
	return (token as { type: string }).type === "math";
}

/** Convert a `math` token's LaTeX to single-line Unicode for inline rendering. */
function renderMathToken(text: string): string {
	return latexToUnicode(text).replace(MATH_NEWLINES, " ");
}

/**
 * When a paragraph's only meaningful content is a single display math token
 * (`$$…$$` / `\[…\]`), return it so the paragraph can be stacked multi-line
 * instead of flattened inline. Models routinely write display math on one line,
 * which marked captures as an inline `display:true` math token inside a
 * paragraph; without this it would flatten through `renderMathToken`.
 */
function soleDisplayMath(tokens?: Token[]): (Token & { text: string }) | null {
	if (!tokens) return null;
	let math: (Token & { text: string; display: boolean }) | null = null;
	for (const token of tokens) {
		if (isMathToken(token) && token.display) {
			if (math) return null;
			math = token;
		} else if (!(token.type === "text" && typeof token.text === "string" && token.text.trim() === "")) {
			return null;
		}
	}
	return math;
}

function plainInlineTokens(tokens: Token[]): string {
	let result = "";
	for (const token of tokens) {
		if (isMathToken(token)) {
			result += renderMathToken(token.text);
			continue;
		}
		switch (token.type) {
			case "text":
				result += token.tokens && token.tokens.length > 0 ? plainInlineTokens(token.tokens) : token.text;
				break;
			case "strong":
			case "em":
			case "del":
			case "link":
				result += plainInlineTokens(token.tokens || []);
				break;
			case "codespan":
				result += token.text;
				break;
			case "br":
				result += "\n";
				break;
			default:
				if ("text" in token && typeof token.text === "string") result += token.text;
				break;
		}
	}
	return result;
}

/**
 * Classify an inline `html` token by tag name and whether it is a closing tag.
 * Returns null for non-html tokens or raw that isn't a recognizable HTML tag.
 */
function inlineHtmlTag(token: Token): { name: string; closing: boolean } | null {
	if ((token as { type: string }).type !== "html") return null;
	const raw = (token as { raw?: unknown }).raw;
	if (typeof raw !== "string") return null;
	const name = htmlTagName(raw);
	if (!name) return null;
	return { name, closing: /^<\s*\//.test(raw) };
}

/**
 * Collapse inline `<code>…</code>` runs — which marked emits as separate `html`
 * open/close tokens around the literal content — into a single synthetic
 * `codespan` token, so they render with the theme's inline-code styling instead
 * of leaking the raw tags. HTML entities inside the run are decoded. Stray or
 * unmatched code tags are dropped; other inline html tokens pass through for the
 * `html` render path to normalize. Returns the original array when no `<code>`
 * tag is present (the common case).
 */
function collapseInlineHtml(tokens: Token[]): Token[] {
	let hasCode = false;
	for (const token of tokens) {
		if (inlineHtmlTag(token)?.name === "code") {
			hasCode = true;
			break;
		}
	}
	if (!hasCode) return tokens;

	const out: Token[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const tag = inlineHtmlTag(tokens[i]);
		if (tag?.name === "code") {
			if (tag.closing) continue; // stray `</code>` — drop it
			let j = i + 1;
			for (; j < tokens.length; j++) {
				const close = inlineHtmlTag(tokens[j]);
				if (close?.name === "code" && close.closing) break;
			}
			if (j >= tokens.length) continue; // unmatched `<code>` — drop it, render the rest normally
			const text = normalizeHtmlEntitiesForTerminal(plainInlineTokens(tokens.slice(i + 1, j)));
			out.push({ type: "codespan", raw: text, text } as Token);
			i = j;
			continue;
		}
		out.push(tokens[i]);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Inline hex-color swatches
// ---------------------------------------------------------------------------
// When prose/thinking mentions a CSS hex color (e.g. #C5FFD6 or `#C5FFD6`),
// render a small chip painted with that color just before the code. The chip
// glyph comes from the theme's symbol set (ASCII → Unicode → Nerd Font), so it
// degrades gracefully; the color itself is exact 24-bit on truecolor terminals
// and the nearest 256-color cell otherwise (Bun.color quantizes for us).

/** Fallback chip when the theme supplies no `colorSwatch` symbol (Unicode default). */
const DEFAULT_COLOR_SWATCH_GLYPH = "■";

// `#` + 3-8 hex digits, not glued to a surrounding word/`#`/`&` (avoids HTML
// entities like &#9731; and paths like foo#fff), not the start of a canonical
// UUID, and not trailed by another word char (over-long runs and word
// fragments like the "#eac" of "#each" never produce a misleading swatch).
// Length/letter rules are enforced in classifyHexColor since the alternation
// can't express "exactly 3, 6, or 8".
const HEX_COLOR_REGEX = /(?<![\w#&])#(?![0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})([0-9a-fA-F]{3,8})(?!\w)/g;
const HEX_COLOR_EXACT_REGEX = /^#([0-9a-fA-F]{3,8})$/;

/**
 * Decide whether a run of hex digits denotes a renderable CSS color.
 *
 * Only the canonical CSS lengths (#RGB, #RRGGBB, #RRGGBBAA) qualify. The 4-digit
 * #RGBA form is deliberately excluded: it collides with hashline `#TAG` snapshot
 * tags (4 hex digits, e.g. #6C5E), which would otherwise sprout spurious swatches.
 * In `strict` mode (bare prose) a 3-digit run must contain a hex letter, so the
 * far more common short issue/PR references (#123, #1011) don't sprout swatches.
 * Codespans opt out of strictness — the backticks already signal "this is a color".
 */
function classifyHexColor(hex: string, strict: boolean): boolean {
	const n = hex.length;
	if (n !== 3 && n !== 6 && n !== 8) return false;
	if (strict && n === 3 && !/[a-fA-F]/.test(hex)) return false;
	return true;
}

interface RenderSignature {
	width: number;
	paddingX: number;
	paddingY: number;
	codeBlockIndent: number;
	themeId: number;
	defaultTextStyleId: number;
	defaultTextStyleSignature: string;
	imageProtocol: string;
	hyperlinks: boolean;
	textSizing: boolean;
}

interface StreamingHighlightCache extends RenderSignature {
	lang: string | undefined;
	text: string;
	lines: readonly string[];
	stream: HighlightStreamSession;
}

/**
 * Split a highlight-stream push result (newline-terminated lines) into
 * per-line strings, dropping the empty tail produced by the final newline.
 */
function splitPushedHighlightLines(pushed: string): string[] {
	const lines = pushed.split("\n");
	lines.pop();
	return lines;
}

interface MarkdownStyles {
	base: Style;
	background: Style;
	proseAttributes: Style;
	paintProse?: (out: Out, text: string, base: Style) => void;
	heading: Style;
	link: Style;
	linkUrl: Style;
	code: Style;
	codeBlock: Style;
	codeBlockBorder: Style;
	quote: Style;
	quoteBorder: Style;
	hr: Style;
	listBullet: Style;
	bold: Style;
	italic: Style;
	strike: Style;
	underline: Style;
}

interface PaintedBlock {
	rich: RichText;
	literalRows: Set<number>;
	/** Rows that continue a soft wrap from the preceding physical row. */
	continuedRows: Set<number>;
}

interface TokenPaintCache {
	signature: string;
	type: string;
	raw: string;
	nextType?: string;
	block: PaintedBlock;
}

/** Exact native rows emitted by a MarkdownEngine paint. */
export interface MarkdownLayout {
	readonly width: number;
	readonly rows: readonly string[];
}

/** Fully resolved configuration for a retained Markdown engine. */
export interface MarkdownConfiguration {
	/** Horizontal padding in terminal cells. */
	readonly paddingX: number;
	/** Blank rows above and below the document. */
	readonly paddingY: number;
	/** Markdown token theme. */
	readonly theme: MarkdownTheme;
	/** Base style applied before Markdown token styling. */
	readonly defaultTextStyle?: DefaultTextStyle;
	/** Indentation in terminal cells for fenced code blocks. */
	readonly codeBlockIndent: number;
	/** Whether narrow rendering omits the normal horizontal inset. */
	readonly ignoreTight: boolean;
}

/** Layout and base-style options for the generic Markdown host. */
export interface MarkdownOptions {
	/** Resolve a link destination while preserving its visible Markdown label. */
	readonly resolveLink?: (href: string) => string | undefined;
	/** Horizontal padding in terminal cells. */
	readonly paddingX?: number;
	/** Blank rows above and below the document. */
	readonly paddingY?: number;
	/** Base style applied before Markdown token styling. */
	readonly defaultTextStyle?: DefaultTextStyle;
	/** Indentation in terminal cells for fenced code blocks. */
	readonly codeBlockIndent?: number;
	/** Whether narrow rendering omits the normal horizontal inset. */
	readonly ignoreTight?: boolean;
}

/** Props for the generic Markdown host. */
export interface MarkdownProps {
	/** Markdown source text; ignored when a retained engine is supplied. */
	readonly source?: string;
	/** Retained parser and painter used by compatibility facades. */
	readonly engine?: MarkdownEngine;
	/** Layout and base-style options for source-owned engines. */
	readonly options?: MarkdownOptions;
	/** Markdown token theme; defaults to the active application theme. */
	readonly theme?: MarkdownTheme;
}

export type MarkdownViewProps = MarkdownProps;

function mergeStyle(outer: Style, inner: Style): Style {
	return inner.over(outer);
}

function markdownStyles(theme: MarkdownTheme, defaults: DefaultTextStyle | undefined): MarkdownStyles {
	let proseAttributes = Style.NONE;
	if (defaults?.bold) proseAttributes = proseAttributes.plus(theme.bold.attrs);
	if (defaults?.italic) proseAttributes = proseAttributes.plus(theme.italic.attrs);
	if (defaults?.strikethrough) proseAttributes = proseAttributes.plus(theme.strikethrough.attrs);
	if (defaults?.underline) proseAttributes = proseAttributes.plus(theme.underline.attrs);
	return {
		base: defaults?.style ?? Style.NONE,
		background: defaults?.backgroundStyle ?? Style.NONE,
		proseAttributes,
		paintProse: defaults?.paintProse,
		heading: theme.heading,
		link: theme.link,
		linkUrl: theme.linkUrl,
		code: theme.code,
		codeBlock: theme.codeBlock,
		codeBlockBorder: theme.codeBlockBorder,
		quote: theme.quote,
		quoteBorder: theme.quoteBorder,
		hr: theme.hr,
		listBullet: theme.listBullet,
		bold: theme.bold,
		italic: theme.italic,
		strike: theme.strikethrough,
		underline: theme.underline,
	};
}

function pushText(out: Out, style: Style, text: string): void {
	let start = 0;
	for (;;) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline;
		if (end > start) {
			const segment = text.slice(start, end);
			if (segment.includes("\x1b")) {
				const external = new RichText();
				parseAnsiRow(segment, external);
				external.br();
				external.replayRow(over(out, style), 0);
			} else {
				out.push(style, segment);
			}
		}
		if (newline === -1) return;
		out.br();
		start = newline + 1;
	}
}

interface InlineControlState {
	external: Style;
}

function pushInlineText(out: Out, base: Style, text: string, state: InlineControlState): void {
	if (!text.includes("\x1b")) {
		pushText(out, state.external.over(base), text);
		return;
	}
	let start = 0;
	for (;;) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline;
		const segment = text.slice(start, end);
		const prefix =
			(state.external.link === 0 ? "" : `\x1b]8;;${linkUrl(state.external.link)}\x07`) +
			sgrFull(state.external.withLink(0), "truecolor");
		const sentinel = "\u0000";
		const parsed = new RichText();
		parseAnsiRow(`${prefix}${segment}${sentinel}`, parsed);
		parsed.br();
		for (let run = 0; run < parsed.runs; run++) {
			const runText = parsed.text[run]!;
			const visible = runText.endsWith(sentinel) ? runText.slice(0, -sentinel.length) : runText;
			if (visible) out.push(parsed.style[run]!.over(base), visible);
			if (runText.endsWith(sentinel)) state.external = parsed.style[run]!;
		}
		if (newline === -1) return;
		out.br();
		start = newline + 1;
	}
}

function paintSwatchedText(
	out: Out,
	text: string,
	style: Style,
	glyph: string,
	controlState: InlineControlState,
): void {
	HEX_COLOR_REGEX.lastIndex = 0;
	let last = 0;
	for (;;) {
		const match = HEX_COLOR_REGEX.exec(text);
		if (match === null) break;
		const hex = match[1]!;
		if (!classifyHexColor(hex, true)) continue;
		let color: Color;
		try {
			color = parseColor(`#${hex}`);
		} catch {
			continue;
		}
		if (match.index > last) pushInlineText(out, style, text.slice(last, match.index), controlState);
		out.push(Style.of({ fg: color }), glyph);
		out.push(Style.NONE, " ");
		const rgba = Bun.color(`#${hex}`, "{rgba}");
		const contrast =
			rgba && (rgba.r * 299 + rgba.g * 587 + rgba.b * 114) / 1000 >= 128 ? rgb(0, 0, 0) : rgb(255, 255, 255);
		out.push(Style.of({ fg: contrast, bg: color }), match[0]);
		last = match.index + match[0].length;
	}
	if (last === 0) {
		pushInlineText(out, style, text, controlState);
	} else if (last < text.length) {
		pushInlineText(out, style, text.slice(last), controlState);
	}
}

function paintInlineTokensRun(
	out: Out,
	tokens: readonly Token[],
	theme: MarkdownTheme,
	styles: MarkdownStyles,
	base: Style,
	htmlState: HtmlNormalizationState = createHtmlNormalizationState(),
	controlState: InlineControlState = { external: Style.NONE },
	allowPaintProse = true,
): void {
	const swatchGlyph = theme.symbols.colorSwatch || DEFAULT_COLOR_SWATCH_GLYPH;
	let trimLeadingWhitespace = false;
	for (const token of collapseInlineHtml(tokens as Token[])) {
		if (isMathToken(token)) {
			pushInlineText(out, base, latexToUnicode(token.text).replace(MATH_NEWLINES, " "), controlState);
			continue;
		}
		switch (token.type) {
			case "text": {
				const raw = trimLeadingWhitespace ? token.text.replace(/^\s+/, "") : token.text;
				trimLeadingWhitespace = false;
				if (token.tokens?.length) {
					paintInlineTokensRun(out, token.tokens, theme, styles, base, htmlState, controlState, allowPaintProse);
				} else {
					const text = normalizeHtmlEntitiesForTerminal(raw);
					const proseBase = allowPaintProse ? base.plus(styles.proseAttributes.attrs) : base;
					if (allowPaintProse && styles.paintProse) {
						styles.paintProse(out, text, controlState.external.over(proseBase));
					} else {
						paintSwatchedText(out, text, proseBase, swatchGlyph, controlState);
					}
				}
				break;
			}
			case "paragraph":
				paintInlineTokensRun(
					out,
					token.tokens || [],
					theme,
					styles,
					base,
					htmlState,
					controlState,
					allowPaintProse,
				);
				break;
			case "strong":
				paintInlineTokensRun(
					out,
					token.tokens || [],
					theme,
					styles,
					mergeStyle(base, styles.bold),
					htmlState,
					controlState,
					allowPaintProse,
				);
				break;
			case "em":
				paintInlineTokensRun(
					out,
					token.tokens || [],
					theme,
					styles,
					mergeStyle(base, styles.italic),
					htmlState,
					controlState,
					allowPaintProse,
				);
				break;
			case "del":
				paintInlineTokensRun(
					out,
					token.tokens || [],
					theme,
					styles,
					mergeStyle(base, styles.strike),
					htmlState,
					controlState,
					allowPaintProse,
				);
				break;
			case "codespan": {
				const code = token.text;
				const match = HEX_COLOR_EXACT_REGEX.exec(code.trim());
				if (match && classifyHexColor(match[1]!, false)) {
					let color: Color | undefined;
					try {
						color = parseColor(`#${match[1]}`);
					} catch {
						color = undefined;
					}
					if (color !== undefined) {
						out.push(Style.of({ fg: color }), swatchGlyph);
						out.push(Style.NONE, " ");
						const rgba = Bun.color(`#${match[1]}`, "{rgba}");
						const contrast =
							rgba && (rgba.r * 299 + rgba.g * 587 + rgba.b * 114) / 1000 >= 128
								? rgb(0, 0, 0)
								: rgb(255, 255, 255);
						out.push(Style.of({ fg: contrast, bg: color }), match[0]);
						break;
					}
				}
				pushInlineText(out, mergeStyle(base, styles.code), code, controlState);
				break;
			}
			case "link": {
				const href = typeof token.href === "string" ? token.href : "";
				const target = ((href && theme.resolveLink?.(href)) || href).replaceAll("\x1b", "").replaceAll("\x07", "");
				const linkBase = mergeStyle(base, styles.link).withAttrs(
					mergeStyle(base, styles.link).attrs | styles.underline.attrs,
				);
				const clickable = TERMINAL.hyperlinks && target ? linkBase.withLink(linkId(target)) : linkBase;
				paintInlineTokensRun(out, token.tokens || [], theme, styles, clickable, htmlState, controlState, false);
				const comparable = href.startsWith("mailto:") ? href.slice(7) : href;
				if (href && token.text !== href && token.text !== comparable) {
					out.push(base, " ");
					pushInlineText(
						out,
						TERMINAL.hyperlinks && target
							? mergeStyle(base, styles.linkUrl).withLink(linkId(target))
							: mergeStyle(base, styles.linkUrl),
						`(${href})`,
						controlState,
					);
				}
				break;
			}
			case "image": {
				const image = token as Token & { href?: string; text?: string };
				out.push(base, image.text || image.href || "image");
				break;
			}
			case "br":
				out.br();
				trimLeadingWhitespace = true;
				break;
			case "html": {
				const raw = "raw" in token && typeof token.raw === "string" ? token.raw : "";
				const cleaned = normalizeHtmlForTerminal(raw, htmlState);
				pushText(out, base, cleaned);
				trimLeadingWhitespace = cleaned.endsWith("\n");
				break;
			}
			default:
				if ("text" in token && typeof token.text === "string") {
					const text = trimLeadingWhitespace ? token.text.replace(/^\s+/, "") : token.text;
					trimLeadingWhitespace = false;
					pushInlineText(out, base, normalizeHtmlEntitiesForTerminal(text), controlState);
				}
		}
	}
}

function replayRowRange(source: RichText, row: number, from: number, to: number, out: Out): void {
	let offset = 0;
	const end = source.rowEnd[row]!;
	for (let i = source.rowStart(row); i < end; i++) {
		const flags = source.flags[i]!;
		if (flags !== RunFlag.None) continue;
		const text = source.text[i]!;
		const next = offset + text.length;
		const localFrom = Math.max(0, from - offset);
		const localTo = Math.min(text.length, to - offset);
		if (localFrom < localTo) out.push(source.style[i]!, text.slice(localFrom, localTo));
		offset = next;
		if (offset >= to) break;
	}
}

function wrappedRich(source: RichText, width: number): RichText {
	const result = new RichText();
	const wrap = new Wrap(result, Math.max(1, width));
	source.replay(wrap);
	result.finish();
	return result;
}

function paintTreeAwareParagraph(source: RichText, out: RichText, width: number, continuedRows: Set<number>): void {
	for (let row = 0; row < source.rows; row++) {
		const plain = source.rowText(row);
		const prefix =
			width >= MIN_TREE_CONTENT_WIDTH && TREE_GUIDE_ANCHOR_RE.test(plain) ? matchTreeGuidePrefix(plain) : undefined;
		const prefixWidth = prefix ? visibleWidth(prefix.guides) : 0;
		if (!prefix || source.rowWidth[row]! <= width || width - prefixWidth < MIN_TREE_CONTENT_WIDTH) {
			const one = new RichText();
			source.replayRow(one, row);
			one.br();
			const wrapped = wrappedRich(one, width);
			const start = out.rows;
			wrapped.replay(out);
			for (let wrappedRow = 1; wrappedRow < wrapped.rows; wrappedRow++) continuedRows.add(start + wrappedRow);
			continue;
		}
		const body = new RichText();
		replayRowRange(source, row, prefix.end, plain.length, body);
		body.br();
		const wrapped = wrappedRich(body, width - prefixWidth);
		let hang = "";
		for (const guide of prefix.guides) hang += TREE_GUIDE_CONTINUATION[guide] ?? " ";
		for (let bodyRow = 0; bodyRow < wrapped.rows; bodyRow++) {
			if (bodyRow === 0) replayRowRange(source, row, 0, prefix.end, out);
			else {
				continuedRows.add(out.rows);
				out.push(stylesForRow(source, row), hang);
			}
			wrapped.replayRow(out, bodyRow);
			out.br();
		}
	}
}

function stylesForRow(source: RichText, row: number): Style {
	const start = source.rowStart(row);
	return start < source.rowEnd[row]! ? source.style[start]! : Style.NONE;
}

function rowHasFlag(source: RichText, row: number, flag: RunFlag): boolean {
	for (let i = source.rowStart(row); i < source.rowEnd[row]!; i++) {
		if ((source.flags[i]! & flag) !== 0) return true;
	}
	return false;
}

function paintFramedBlock(
	out: Out,
	block: PaintedBlock,
	width: number,
	paddingX: number,
	background: Style,
	base: Style,
): void {
	for (let row = 0; row < block.rich.rows; row++) {
		if (
			block.literalRows.has(row) ||
			rowHasFlag(block.rich, row, RunFlag.Image) ||
			rowHasFlag(block.rich, row, RunFlag.Sized)
		) {
			block.rich.replayRow(out, row);
			out.br();
			continue;
		}
		// Legacy Markdown styled one logical block before wrapping: its default
		// foreground therefore remains active across intermediate wrapped rows
		// and resets only on the block's final row. Preserve that terminal-cell
		// state for trailing margins/padding while keeping the leading margin on
		// the line background.
		const inherited = base.over(background);
		const fill = block.continuedRows.has(row + 1) ? inherited : background;
		const leading = block.continuedRows.has(row) ? inherited : background;
		const padded = new Pad(out, width, fill);
		if (paddingX > 0) padded.push(leading, spaces(paddingX));
		block.rich.replayRow(over(padded, background), row);
		if (paddingX > 0) padded.push(fill, spaces(paddingX));
		padded.br();
	}
}

function paintBlankRow(out: Out, width: number, background: Style): void {
	if (width > 0) out.push(background, spaces(width));
	out.br();
}

function finishInline(
	tokens: readonly Token[],
	theme: MarkdownTheme,
	styles: MarkdownStyles,
	base = styles.base,
	allowPaintProse = true,
): RichText {
	const rich = new RichText();
	paintInlineTokensRun(rich, tokens, theme, styles, base, undefined, undefined, allowPaintProse);
	rich.finish();
	return rich;
}

export class MarkdownEngine {
	private text: string;
	private oscPartialEscape?: string;
	private config: MarkdownConfiguration;
	private transient = false;
	private streamPrefixText?: string;
	private streamPrefixTokens?: Token[];
	private lastScanLength = -1;
	private lastScanCanStream = false;
	private lastScanValid = false;
	private appendOnlySinceLastScan = true;
	private tokenCache: TokenPaintCache[] = [];
	private streamingHighlightCache?: StreamingHighlightCache;
	private highlightedLineCache = new Map<string, RichText>();
	private highlightedLineEpoch = -1;
	private activeSignature?: RenderSignature;

	constructor(text: string, config: MarkdownConfiguration) {
		this.text = normalizeOsc8Terminators(text);
		this.oscPartialEscape = trailingOsc8Partial(this.text);
		this.config = config;
	}

	configure(text: string, config: MarkdownConfiguration, transient = this.transient): void {
		this.config = config;
		this.setText(text);
		this.setTransient(transient);
	}

	setText(nextText: string): boolean {
		if (nextText === this.text) return false;
		if (nextText.length > this.text.length && nextText.startsWith(this.text)) {
			const memoized = this.oscPartialEscape;
			const pending = (memoized ?? "") + nextText.slice(this.text.length);
			const normalized = normalizeOsc8Terminators(pending);
			if (normalized !== pending) {
				nextText = this.text.slice(0, this.text.length - (memoized?.length ?? 0)) + normalized;
			}
			this.oscPartialEscape = trailingOsc8Partial(normalized);
			this.text = nextText;
			return true;
		}
		nextText = normalizeOsc8Terminators(nextText);
		this.oscPartialEscape = trailingOsc8Partial(nextText);
		if (nextText === this.text) return false;
		if (!nextText.startsWith(this.text)) this.appendOnlySinceLastScan = false;
		this.text = nextText;
		if (!nextText.trim()) this.resetStreamingState();
		return true;
	}

	appendText(delta: string): boolean {
		if (delta.length === 0) return false;
		return this.setText(this.text + delta);
	}

	setTransient(value: boolean): boolean {
		const next = value === true;
		if (next === this.transient) return false;
		this.transient = next;
		this.appendOnlySinceLastScan = false;
		this.lastScanValid = false;
		this.tokenCache = [];
		this.streamingHighlightCache = undefined;
		return true;
	}

	get transientRenderCache(): boolean {
		return this.transient;
	}

	get stableText(): string {
		return this.transient ? (this.streamPrefixText ?? "") : "";
	}

	get sourceText(): string {
		return this.text;
	}

	setIgnoreTight(ignore: boolean): boolean {
		if (this.config.ignoreTight === ignore) return false;
		this.config = { ...this.config, ignoreTight: ignore };
		this.invalidate();
		return true;
	}

	invalidate(): void {
		this.tokenCache = [];
		this.streamingHighlightCache = undefined;
	}

	debugState(): Record<string, unknown> {
		return {
			textPreview: this.text.slice(0, 120),
			textLength: this.text.length,
			previewTruncated: this.text.length > 120,
			paddingX: this.config.paddingX,
			paddingY: this.config.paddingY,
			codeBlockIndent: this.config.codeBlockIndent,
			ignoreTight: this.config.ignoreTight,
		};
	}

	private resetStreamingState(): void {
		this.streamPrefixText = undefined;
		this.streamPrefixTokens = undefined;
		this.lastScanValid = false;
		this.tokenCache = [];
		this.streamingHighlightCache = undefined;
	}

	private lexTokens(text: string): Token[] {
		const prefix = this.streamPrefixText;
		const prefixTokens = this.streamPrefixTokens;
		const hasPrefix =
			prefix !== undefined && prefixTokens !== undefined && text.length > prefix.length && text.startsWith(prefix);
		const refDefText = hasPrefix ? text.slice(prefix.length) : text;
		let canStream: boolean;
		if (this.lastScanValid && this.appendOnlySinceLastScan && text.length > this.lastScanLength) {
			const delta = text.slice(this.lastScanLength);
			if (
				!delta.includes("[") &&
				!delta.includes("]") &&
				!delta.includes(":") &&
				!delta.includes("\n") &&
				!delta.includes("\r")
			) {
				canStream = this.lastScanCanStream;
			} else if (this.lastScanCanStream) {
				canStream = !HAS_REF_DEF.test(refDefText) && !refDefText.includes("\r");
			} else {
				canStream = false;
			}
		} else {
			canStream = !HAS_REF_DEF.test(refDefText) && !refDefText.includes("\r");
		}
		this.lastScanLength = text.length;
		this.lastScanCanStream = canStream;
		this.lastScanValid = true;
		this.appendOnlySinceLastScan = true;
		if (canStream && hasPrefix) {
			const tokens = [...prefixTokens, ...lexDocument(refDefText)];
			this.freezeStablePrefix(text, tokens, true);
			return tokens;
		}
		const tokens = lexDocument(text);
		if (canStream) this.freezeStablePrefix(text, tokens, false);
		else {
			this.streamPrefixText = undefined;
			this.streamPrefixTokens = undefined;
			this.tokenCache = [];
		}
		return tokens;
	}

	private freezeStablePrefix(text: string, tokens: Token[], preserveExisting: boolean): void {
		const skip = preserveExisting ? (this.streamPrefixTokens?.length ?? 0) : 0;
		const frozen = stableBlockBoundary(text, skip > 0 ? (this.streamPrefixText?.length ?? 0) : 0, tokens, skip);
		if (frozen.count > 0) {
			this.streamPrefixText = text.slice(0, frozen.end);
			this.streamPrefixTokens = tokens.slice(0, frozen.count);
		} else if (!preserveExisting) {
			this.streamPrefixText = undefined;
			this.streamPrefixTokens = undefined;
		}
	}

	private signature(width: number, paddingX: number): RenderSignature {
		const defaults = this.config.defaultTextStyle;
		return {
			width,
			paddingX,
			paddingY: this.config.paddingY,
			codeBlockIndent: this.config.codeBlockIndent,
			themeId: objectId(this.config.theme),
			defaultTextStyleId: defaults ? objectId(defaults) : -1,
			defaultTextStyleSignature: defaults
				? `${defaults.style?.id ?? -1}:${defaults.backgroundStyle?.id ?? -1}:${defaults.bold ? 1 : 0}:${defaults.italic ? 1 : 0}:${defaults.strikethrough ? 1 : 0}:${defaults.underline ? 1 : 0}:${defaults.paintProse ? objectId(defaults.paintProse) : -1}`
				: "",
			imageProtocol: `${TERMINAL.imageProtocol ?? ""}:${getWidthConfigEpoch()}:${this.transient ? 1 : 0}`,
			hyperlinks: TERMINAL.hyperlinks,
			textSizing: TERMINAL.textSizing,
		};
	}

	private signatureKey(signature: RenderSignature): string {
		return `${renderCacheEpoch}\x00${signature.width}\x00${signature.paddingX}\x00${signature.paddingY}\x00${signature.codeBlockIndent}\x00${signature.themeId}\x00${signature.defaultTextStyleId}\x00${signature.defaultTextStyleSignature}\x00${signature.imageProtocol}\x00${signature.hyperlinks ? 1 : 0}\x00${signature.textSizing ? 1 : 0}`;
	}

	paint(out: Out, width: number, onLayout?: (layout: MarkdownLayout) => void): void {
		if (onLayout) {
			const layout = new RichText();
			this.paint(layout, width);
			layout.finish();
			const rows: string[] = [];
			for (let row = 0; row < layout.rows; row++) rows.push(layout.rowText(row));
			layout.replay(out);
			onLayout({ width, rows });
			return;
		}
		if (!this.text || this.text.trim() === "") return;
		const paddingX = this.config.ignoreTight ? this.config.paddingX : getPaddingX(this.config.paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const tabbed = this.text.includes("\t") ? replaceTabs(this.text) : this.text;
		const normalized = this.transient ? tabbed : repairOrphanClosingFence(tabbed);
		if (!this.transient && normalized.length < tabbed.length) this.lastScanValid = false;
		const tokens = this.lexTokens(normalized);
		const signature = this.signature(width, paddingX);
		const signatureKey = this.signatureKey(signature);
		const styles = markdownStyles(this.config.theme, this.config.defaultTextStyle);
		this.activeSignature = signature;
		for (let i = 0; i < this.config.paddingY; i++) paintBlankRow(out, width, styles.background);
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index]!;
			const nextType = tokens[index + 1]?.type;
			let cached = this.tokenCache[index];
			if (
				!cached ||
				cached.signature !== signatureKey ||
				cached.type !== token.type ||
				cached.raw !== token.raw ||
				cached.nextType !== nextType
			) {
				cached = {
					signature: signatureKey,
					type: token.type,
					raw: token.raw,
					nextType,
					block: this.paintToken(token, nextType, contentWidth, styles),
				};
				this.tokenCache[index] = cached;
			}
			paintFramedBlock(out, cached.block, width, paddingX, styles.background, styles.base);
		}
		this.tokenCache.length = tokens.length;
		for (let i = 0; i < this.config.paddingY; i++) paintBlankRow(out, width, styles.background);
		this.activeSignature = undefined;
	}

	private paintToken(token: Token, nextType: string | undefined, width: number, styles: MarkdownStyles): PaintedBlock {
		const rich = new RichText();
		const literalRows = new Set<number>();
		const continuedRows = new Set<number>();
		const theme = this.config.theme;
		if (isMathToken(token)) {
			paintLatexBlock(rich, token.text, styles.base);
			if (nextType && nextType !== "space") rich.br();
			return { rich, literalRows, continuedRows };
		}
		switch (token.type) {
			case "heading": {
				const depth = token.depth;
				const plain = plainInlineTokens(token.tokens || []);
				let headingStyle = mergeStyle(styles.base, styles.heading);
				headingStyle = mergeStyle(headingStyle, styles.bold);
				if (depth === 1) headingStyle = mergeStyle(headingStyle, styles.underline);
				if (depth === 1 && TERMINAL.textSizing && visibleWidth(plain) > 0 && visibleWidth(plain) * 2 <= width) {
					const payload = encodeTextSizedHeading(plain, 2);
					rich.raw(headingStyle, payload, visibleWidth(plain) * 2, RunFlag.Sized);
					rich.br();
					const reservedRow = rich.rows;
					rich.br();
					literalRows.add(reservedRow);
				} else {
					if (depth >= 3) rich.push(headingStyle, `${"#".repeat(depth)} `);
					paintInlineTokensRun(rich, token.tokens || [], theme, styles, headingStyle);
					rich.finish();
				}
				if (nextType && nextType !== "space") rich.br();
				break;
			}
			case "paragraph": {
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) paintLatexBlock(rich, displayMath.text, styles.base);
				else {
					const inline = finishInline(token.tokens || [], theme, styles);
					paintTreeAwareParagraph(inline, rich, width, continuedRows);
				}
				if (nextType && nextType !== "list" && nextType !== "space") rich.br();
				break;
			}
			case "code":
				this.paintCodeBlock(rich, literalRows, token, width, styles);
				if (nextType && nextType !== "space") rich.br();
				break;
			case "list":
				this.paintList(rich, literalRows, continuedRows, token as ListToken, 0, width, styles);
				break;
			case "table":
				this.paintTable(rich, token as TableToken, width, styles);
				if (nextType && nextType !== "space") rich.br();
				break;
			case "blockquote": {
				const inner = new RichText();
				const innerLiteralRows = new Set<number>();
				const innerContinuedRows = new Set<number>();
				const quoteTokens = token.tokens || [];
				const quoteStyles = { ...styles, base: Style.NONE };
				for (let i = 0; i < quoteTokens.length; i++) {
					const block = this.paintToken(
						quoteTokens[i]!,
						quoteTokens[i + 1]?.type,
						Math.max(1, width - 2),
						quoteStyles,
					);
					const rowOffset = inner.rows;
					block.rich.replay(inner);
					for (const row of block.literalRows) innerLiteralRows.add(rowOffset + row);
					for (const row of block.continuedRows) innerContinuedRows.add(rowOffset + row);
				}
				let rows = inner.rows;
				while (rows > 0 && inner.rowWidth[rows - 1] === 0) rows--;
				const quoteBase = mergeStyle(styles.quote, styles.italic);
				for (let row = 0; row < rows; row++) {
					const outputRow = rich.rows;
					if (innerContinuedRows.has(row)) continuedRows.add(outputRow);
					if (innerLiteralRows.has(row)) {
						inner.replayRow(rich, row);
						literalRows.add(outputRow);
					} else {
						rich.push(styles.quoteBorder, `${theme.symbols.quoteBorder} `);
						inner.replayRow(over(rich, quoteBase), row);
					}
					rich.br();
				}
				if (nextType && nextType !== "space") rich.br();
				break;
			}
			case "hr": {
				const raw = typeof token.raw === "string" ? token.raw.trim() : "";
				const fill = getHrChar(raw[0] || "", theme.symbols.hrChar);
				rich.push(styles.hr, fill.repeat(Math.min(width, 80)));
				rich.br();
				if (nextType && nextType !== "space") rich.br();
				break;
			}
			case "html":
				this.paintHtmlBlock(rich, typeof token.raw === "string" ? token.raw : "", width, styles);
				break;
			case "space":
				rich.br();
				break;
			default:
				if ("text" in token && typeof token.text === "string") {
					pushText(rich, styles.base, token.text);
					rich.finish();
				}
		}
		rich.finish();
		return { rich, literalRows, continuedRows };
	}

	private codeTokenHasClosingFence(token: Token): boolean {
		const raw = typeof token.raw === "string" ? token.raw : "";
		const firstEnd = raw.indexOf("\n");
		if (firstEnd < 0) return false;
		const opening = raw.slice(0, firstEnd).trimStart();
		const fence = opening[0];
		if (fence !== "`" && fence !== "~") return false;
		let count = 0;
		while (opening[count] === fence) count++;
		if (count < 3) return false;
		for (const line of raw.slice(firstEnd + 1).split("\n")) {
			const trimmed = line.trimStart();
			let close = 0;
			while (trimmed[close] === fence) close++;
			if (line.length - trimmed.length <= 3 && close >= count && trimmed.slice(close).trim() === "") return true;
		}
		return false;
	}

	private highlightedCodeLines(token: Token, styles: MarkdownStyles): RichText {
		const epoch = getWidthConfigEpoch();
		if (epoch !== this.highlightedLineEpoch) {
			this.highlightedLineEpoch = epoch;
			this.highlightedLineCache.clear();
		}
		const output = new RichText();
		const text = "text" in token && typeof token.text === "string" ? token.text : "";
		const lang = "lang" in token && typeof token.lang === "string" ? token.lang : undefined;
		const theme = this.config.theme;
		const streaming = this.transient;
		if (theme.highlightCode && (!streaming || this.codeTokenHasClosingFence(token))) {
			for (const line of theme.highlightCode(text, lang)) this.cachedHighlightedLine(line).replay(output);
			return output;
		}
		if (streaming && theme.highlightCode) {
			const end = text.lastIndexOf("\n");
			const completed = end >= 0 ? this.highlightStreamingLines(text.slice(0, end), lang) : null;
			if (completed) {
				for (const line of completed) this.cachedHighlightedLine(line).replay(output);
				for (const line of text.slice(end + 1).split("\n")) {
					output.push(styles.codeBlock, line);
					output.br();
				}
				return output;
			}
		}
		for (const line of text.split("\n")) {
			output.push(styles.codeBlock, line);
			output.br();
		}
		return output;
	}

	private cachedHighlightedLine(line: string): RichText {
		let cached = this.highlightedLineCache.get(line);
		if (cached !== undefined) return cached;
		cached = new RichText();
		parseAnsiRow(line, cached);
		cached.br();
		this.highlightedLineCache.set(line, cached);
		return cached;
	}

	private highlightStreamingLines(completedText: string, lang: string | undefined): readonly string[] | null {
		const signature = this.activeSignature;
		const cache = this.streamingHighlightCache;
		if (
			signature &&
			cache &&
			completedText.startsWith(cache.text) &&
			cache.lang === lang &&
			this.signatureKey(cache) === this.signatureKey(signature)
		) {
			if (completedText.length === cache.text.length) return cache.lines;
			if (completedText.charCodeAt(cache.text.length) === 0x0a) {
				const added = completedText.slice(cache.text.length + 1);
				const lines = cache.lines.concat(splitPushedHighlightLines(cache.stream.push(`${added}\n`)));
				this.streamingHighlightCache = { ...signature, lang, text: completedText, lines, stream: cache.stream };
				return lines;
			}
		}
		let stream: HighlightStreamSession | null = null;
		try {
			stream = this.config.theme.createHighlightStream?.(lang) ?? null;
		} catch {
			stream = null;
		}
		if (!stream) {
			const normalized = lang?.toLowerCase();
			const highlight = this.config.theme.highlightCode;
			if (highlight && (normalized === "diff" || normalized === "patch" || normalized === "udiff")) {
				stream = {
					push: chunk => {
						const parts = chunk.split("\n");
						const trailing = parts.pop() ?? "";
						let rendered = "";
						for (const line of parts) rendered += `${highlight(line, lang).join("\n")}\n`;
						return trailing ? rendered + highlight(trailing, lang).join("\n") : rendered;
					},
				};
			}
		}
		if (!stream) return null;
		const lines = splitPushedHighlightLines(stream.push(`${completedText}\n`));
		if (signature) this.streamingHighlightCache = { ...signature, lang, text: completedText, lines, stream };
		return lines;
	}

	private paintCodeBlock(
		out: RichText,
		literalRows: Set<number>,
		token: Token,
		width: number,
		styles: MarkdownStyles,
	): void {
		const lang = "lang" in token && typeof token.lang === "string" ? token.lang : undefined;
		const text = "text" in token && typeof token.text === "string" ? token.text : "";
		if (lang === "mermaid" && this.config.theme.resolveMermaidAscii) {
			const ascii = this.config.theme.resolveMermaidAscii(text, width);
			if (ascii) {
				for (const line of ascii.split("\n")) {
					const clipped = new Clip(out, width, Ellipsis.Omit);
					parseAnsiRow(line, clipped);
					clipped.br();
				}
				return;
			}
		}
		out.push(styles.codeBlockBorder, `\`\`\`${lang || ""}`);
		out.br();
		const highlighted = this.highlightedCodeLines(token, styles);
		for (let row = 0; row < highlighted.rows; row++) {
			const source = new RichText();
			if (this.config.codeBlockIndent > 0) source.push(Style.NONE, spaces(this.config.codeBlockIndent));
			highlighted.replayRow(source, row);
			source.br();
			const wrapped = wrappedRich(source, width);
			const rowStart = out.rows;
			wrapped.replay(out);
			if (this.config.codeBlockIndent === 0) {
				for (let wrappedRow = 0; wrappedRow < wrapped.rows; wrappedRow++) literalRows.add(rowStart + wrappedRow);
			}
		}
		out.push(styles.codeBlockBorder, "```");
		out.br();
	}

	private paintList(
		out: RichText,
		literalRows: Set<number>,
		continuedRows: Set<number>,
		token: ListToken,
		depth: number,
		width: number,
		styles: MarkdownStyles,
	): void {
		const start = token.start ?? 1;
		for (let index = 0; index < token.items.length; index++) {
			const item = token.items[index] as Token & {
				tokens?: Token[];
				task?: boolean;
				checked?: boolean;
				loose?: boolean;
			};
			const bullet = token.ordered ? `${start + index}. ` : "- ";
			const indent = spaces(depth * 2);
			const prefix = `${indent}${bullet}`;
			const prefixWidth = visibleWidth(prefix);
			const continuation = spaces(prefixWidth);
			const markerConsumesRow = prefixWidth >= width;
			const bodyWidth = markerConsumesRow ? width : Math.max(1, width - prefixWidth);
			const itemRows = new RichText();
			const itemLiteralRows = new Set<number>();
			const itemContinuedRows = new Set<number>();
			const nested: ListToken[] = [];
			for (const child of item.tokens || []) {
				if (child.type === "list") {
					nested.push(child as ListToken);
					continue;
				}
				if (child.type === "text" || child.type === "paragraph") {
					const display = soleDisplayMath(child.tokens);
					if (display) paintLatexBlock(itemRows, display.text, styles.base);
					else {
						const inline = finishInline(child.tokens || [child], this.config.theme, styles);
						const wrapped = wrappedRich(inline, bodyWidth);
						const rowStart = itemRows.rows;
						wrapped.replay(itemRows);
						for (let wrappedRow = 1; wrappedRow < wrapped.rows; wrappedRow++) {
							itemContinuedRows.add(rowStart + wrappedRow);
						}
					}
				} else if (child.type === "code") {
					const childLiteral = new Set<number>();
					this.paintCodeBlock(itemRows, childLiteral, child, bodyWidth, styles);
					for (const row of childLiteral) itemLiteralRows.add(row);
				} else if (isMathToken(child)) {
					paintLatexBlock(itemRows, child.text, styles.base);
				} else {
					const inline = finishInline([child], this.config.theme, styles);
					const wrapped = wrappedRich(inline, bodyWidth);
					const rowStart = itemRows.rows;
					wrapped.replay(itemRows);
					for (let wrappedRow = 1; wrappedRow < wrapped.rows; wrappedRow++) {
						itemContinuedRows.add(rowStart + wrappedRow);
					}
				}
			}
			if (itemRows.rows === 0) itemRows.br();
			if (markerConsumesRow) {
				const clipped = new Clip(out, width, Ellipsis.Omit);
				if (indent) clipped.push(Style.NONE, indent);
				clipped.push(styles.listBullet, bullet);
				clipped.br();
			}
			for (let row = 0; row < itemRows.rows; row++) {
				const outputRow = out.rows;
				if (itemContinuedRows.has(row)) continuedRows.add(outputRow);
				if (itemLiteralRows.has(row)) {
					itemRows.replayRow(out, row);
					literalRows.add(outputRow);
				} else {
					if (!markerConsumesRow && row === 0) {
						if (indent) out.push(Style.NONE, indent);
						out.push(styles.listBullet, bullet);
					} else if (!markerConsumesRow) {
						out.push(Style.NONE, continuation);
					}
					itemRows.replayRow(out, row);
				}
				out.br();
			}
			for (const child of nested) this.paintList(out, literalRows, continuedRows, child, depth + 1, width, styles);
			if (item.loose && index < token.items.length - 1) out.br();
		}
	}

	private terminalWidths(rich: RichText): number[] {
		const widths: number[] = [];
		for (let row = 0; row < rich.rows; row++) widths.push(rich.rowWidth[row]!);
		return widths;
	}

	private longestWord(rich: RichText): number {
		let longest = 1;
		for (let row = 0; row < rich.rows; row++) {
			for (const word of rich.rowText(row).split(/\s+/)) {
				if (word) longest = Math.max(longest, Math.min(30, visibleWidth(word)));
			}
		}
		return longest;
	}

	private paintTable(out: RichText, token: TableToken, availableWidth: number, styles: MarkdownStyles): void {
		const columns = token.header.length;
		if (columns === 0) return;
		const overhead = columns * 3 + 1;
		const cellBudget = availableWidth - overhead;
		if (cellBudget < columns) {
			const fallback = new RichText();
			fallback.push(styles.base, token.raw ?? "");
			fallback.br();
			wrappedRich(fallback, availableWidth).replay(out);
			return;
		}
		const cells: RichText[][] = [
			token.header.map(cell => finishInline(cell.tokens || [], this.config.theme, styles, undefined, false)),
			...token.rows.map(row =>
				row.map(cell => finishInline(cell.tokens || [], this.config.theme, styles, undefined, false)),
			),
		];
		const natural = new Array<number>(columns).fill(0);
		const minimum = new Array<number>(columns).fill(1);
		for (const row of cells) {
			for (let column = 0; column < columns; column++) {
				const cell = row[column] ?? new RichText();
				for (const width of this.terminalWidths(cell)) natural[column] = Math.max(natural[column]!, width);
				minimum[column] = Math.max(minimum[column]!, this.longestWord(cell));
			}
		}
		const widths = minimum.slice();
		let used = widths.reduce((sum, value) => sum + value, 0);
		if (used > cellBudget) {
			widths.fill(1);
			used = columns;
		}
		let remaining = cellBudget - used;
		while (remaining > 0) {
			let grew = false;
			for (let column = 0; column < columns && remaining > 0; column++) {
				if (widths[column]! < natural[column]!) {
					widths[column] = widths[column]! + 1;
					remaining--;
					grew = true;
				}
			}
			if (!grew) break;
		}
		const table = this.config.theme.symbols.table;
		const horizontal = table.horizontal;
		const border = (left: string, joint: string, right: string): void => {
			out.push(styles.base, left + horizontal);
			for (let column = 0; column < columns; column++) {
				out.push(styles.base, horizontal.repeat(widths[column]!));
				out.push(styles.base, column === columns - 1 ? horizontal + right : horizontal + joint + horizontal);
			}
			out.br();
		};
		border(table.topLeft, table.teeDown ?? table.cross ?? "+", table.topRight);
		const wrappedRows = cells.map(row => row.map((cell, column) => wrappedRich(cell, widths[column]!)));
		const paintCells = (row: RichText[], header: boolean): void => {
			let height = 1;
			for (const cell of row) height = Math.max(height, cell.rows);
			for (let line = 0; line < height; line++) {
				out.push(styles.base, `${table.vertical} `);
				for (let column = 0; column < columns; column++) {
					const cell = row[column];
					const before = out.openWidth;
					if (cell && line < cell.rows) cell.replayRow(header ? over(out, styles.bold) : out, line);
					const occupied = out.openWidth - before;
					const fillStyle = header ? styles.bold : styles.base;
					if (occupied < widths[column]!) out.push(fillStyle, spaces(widths[column]! - occupied));
					out.push(styles.base, column === columns - 1 ? ` ${table.vertical}` : ` ${table.vertical} `);
				}
				out.br();
			}
		};
		paintCells(wrappedRows[0]!, true);
		const separator = (): void =>
			border(table.teeRight ?? table.cross ?? "+", table.cross ?? "+", table.teeLeft ?? table.cross ?? "+");
		separator();
		for (let row = 1; row < wrappedRows.length; row++) {
			paintCells(wrappedRows[row]!, false);
			if (row < wrappedRows.length - 1) separator();
		}
		border(table.bottomLeft, table.teeUp ?? table.cross ?? "+", table.bottomRight);
	}

	private paintHtmlBlock(out: RichText, raw: string, width: number, styles: MarkdownStyles): void {
		let last = 0;
		BLOCK_HTML_REGEX.lastIndex = 0;
		for (let match = BLOCK_HTML_REGEX.exec(raw); match !== null; match = BLOCK_HTML_REGEX.exec(raw)) {
			this.paintHtmlText(out, raw.slice(last, match.index), styles);
			last = match.index + match[0].length;
			if (match[1] !== undefined) {
				const inner = new RichText();
				this.paintHtmlText(inner, match[1], styles);
				const quoteBase = mergeStyle(styles.quote, styles.italic);
				for (let row = 0; row < inner.rows; row++) {
					out.push(styles.quoteBorder, `${this.config.theme.symbols.quoteBorder} `);
					inner.replayRow(over(out, quoteBase), row);
					out.br();
				}
			} else {
				out.push(styles.hr, this.config.theme.symbols.hrChar.repeat(Math.min(width, 80)));
				out.br();
			}
		}
		this.paintHtmlText(out, raw.slice(last), styles);
	}

	private paintHtmlText(out: RichText, raw: string, styles: MarkdownStyles): void {
		const cleaned = normalizeHtmlForTerminal(raw);
		if (cleaned.trim() === "") return;
		for (const line of splitTerminalLines(cleaned)) {
			pushText(out, styles.base, line.trimEnd());
			out.br();
		}
	}
}

/** Paint inline Markdown into an existing run sink. */
export function paintInlineMarkdown(
	out: Out,
	text: string,
	mdTheme: MarkdownTheme = getMarkdownTheme(),
	baseStyle: Style = Style.NONE,
): void {
	const safe = typeof text === "string" ? text : text == null ? "" : String(text);
	const styles = markdownStyles(mdTheme, undefined);
	const tokens = markdownParser.lexer(normalizeOsc8Terminators(safe));
	for (const token of tokens) {
		if (isMathToken(token)) pushText(out, baseStyle, renderMathToken(token.text));
		else if (token.type === "paragraph" && token.tokens)
			paintInlineTokensRun(out, token.tokens, mdTheme, styles, baseStyle);
		else if (token.type === "list") {
			const list = token as Tokens.List;
			for (let index = 0; index < list.items.length; index++) {
				if (index > 0) out.push(baseStyle, " ");
				out.push(baseStyle, list.ordered ? `${(list.start || 1) + index}. ` : "• ");
				const item = list.items[index]!;
				if (item.tokens) paintInlineTokensRun(out, item.tokens, mdTheme, styles, baseStyle);
				else pushText(out, baseStyle, item.text);
			}
		} else if ("text" in token && typeof token.text === "string") {
			pushText(out, baseStyle, normalizeHtmlEntitiesForTerminal(token.text));
		}
	}
}
