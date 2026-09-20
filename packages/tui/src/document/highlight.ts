import { sanitizeText } from "@oh-my-pi/pi-utils";
import { parseAnsiRow } from "../core/ansi";
import { RichText, RunFlag } from "../core/richtext";
import { ansi256, type Color, DEFAULT_COLOR } from "../core/style";
import { instrument } from "../instrumentation";
import type { SyntaxRole } from "../style/resolve";
import { highlightCode, type Theme } from "../theme/theme";
import type { ThemeColor } from "../theme/schema";
import type { TextDocument } from "./types";

/** A semantic syntax role over UTF-16 offsets in a highlighted display line. */
export interface HighlightRoleRange {
	readonly start: number;
	readonly end: number;
	readonly role: SyntaxRole;
}

/** One syntax-highlighted display line with palette-independent role ranges. */
export interface HighlightedDocumentLine {
	readonly text: string;
	readonly roles: readonly HighlightRoleRange[];
}

/** Cached highlighted projection for a document version and logical line range. */
export interface HighlightedDocumentRange {
	readonly version: number;
	readonly startLine: number;
	readonly endLine: number;
	readonly lines: readonly HighlightedDocumentLine[];
}

const ROLE_CODE: Record<SyntaxRole, number> = {
	text: 240,
	comment: 241,
	keyword: 242,
	function: 243,
	variable: 244,
	string: 245,
	number: 246,
	type: 247,
	operator: 248,
	punctuation: 249,
	added: 250,
	removed: 251,
	context: 252,
};

const ROLE_BY_TOKEN: Partial<Record<ThemeColor, SyntaxRole>> = {
	toolOutput: "text",
	syntaxComment: "comment",
	syntaxKeyword: "keyword",
	syntaxFunction: "function",
	syntaxVariable: "variable",
	syntaxString: "string",
	syntaxNumber: "number",
	syntaxType: "type",
	syntaxOperator: "operator",
	syntaxPunctuation: "punctuation",
	toolDiffAdded: "added",
	toolDiffRemoved: "removed",
	toolDiffContext: "context",
};

const ROLE_BY_COLOR = new Map<Color, SyntaxRole>();
for (const name in ROLE_CODE) {
	const role = name as SyntaxRole;
	if (role !== "text") ROLE_BY_COLOR.set(ansi256(ROLE_CODE[role]), role);
}

// The existing native highlighter only exposes ANSI. Supplying stable sentinel
// colours turns that one external parse into semantic roles independent of the
// active palette; subsequent theme changes only resolve the roles again.
const ROLE_THEME = {
	getFgAnsi(color: ThemeColor): string {
		const role = ROLE_BY_TOKEN[color];
		return role === undefined || role === "text" ? "\x1b[39m" : `\x1b[38;5;${ROLE_CODE[role]}m`;
	},
} as unknown as Theme;

interface VersionCache {
	version: number;
	ranges: Map<string, HighlightedDocumentRange>;
}

const kHighlightCache = Symbol("document.highlightCache");

interface CachedTextDocument extends TextDocument {
	[kHighlightCache]?: Map<string, VersionCache>;
}
let tokenizeCount = 0;
let ansiParseCount = 0;

/** Return the number of native tokenization calls, for cache instrumentation tests. */
export function getHighlightTokenizeCount(): number {
	return tokenizeCount;
}

/** Return the number of external ANSI rows parsed into semantic roles. */
export function getHighlightAnsiParseCount(): number {
	return ansiParseCount;
}

/** Reset role-highlighting instrumentation counters without changing caches. */
export function resetHighlightCounters(): void {
	tokenizeCount = 0;
	ansiParseCount = 0;
}

function parseRoleLine(ansi: string): HighlightedDocumentLine {
	ansiParseCount++;
	const rich = new RichText();
	parseAnsiRow(ansi, rich);
	let text = "";
	const roles: HighlightRoleRange[] = [];
	for (let run = 0; run < rich.runs; run++) {
		if ((rich.flags[run]! & RunFlag.Raw) !== 0) continue;
		const value = rich.text[run]!;
		if (value.length === 0) continue;
		const start = text.length;
		text += value;
		const fg = rich.style[run]?.fg ?? DEFAULT_COLOR;
		const role = ROLE_BY_COLOR.get(fg) ?? "text";
		const previous = roles[roles.length - 1];
		if (previous?.role === role && previous.end === start) {
			roles[roles.length - 1] = { start: previous.start, end: text.length, role };
		} else {
			roles.push({ start, end: text.length, role });
		}
	}
	return { text, roles };
}

function versionCache(document: TextDocument, language: string, version: number): VersionCache {
	const cachedDocument = document as CachedTextDocument;
	let languages = cachedDocument[kHighlightCache];
	if (languages === undefined) {
		languages = new Map();
		cachedDocument[kHighlightCache] = languages;
	}
	let cache = languages.get(language);
	if (cache === undefined || cache.version !== version) {
		cache = { version, ranges: new Map() };
		languages.set(language, cache);
	}
	return cache;
}

/** Tokenize already-partitioned source lines into palette-independent semantic roles. */
export function highlightTextLines(
	sourceLines: readonly string[],
	language: string | undefined,
): readonly HighlightedDocumentLine[] {
	const safeLines = new Array<string>(sourceLines.length);
	for (let line = 0; line < sourceLines.length; line++) safeLines[line] = sanitizeText(sourceLines[line]!);
	instrument.parse();
	tokenizeCount++;
	const highlighted = highlightCode(safeLines.join("\n"), language, ROLE_THEME);
	const lines = new Array<HighlightedDocumentLine>(safeLines.length);
	for (let line = 0; line < safeLines.length; line++) {
		lines[line] = parseRoleLine(highlighted[line] ?? safeLines[line]!);
	}
	return lines;
}

/** Highlight a logical line range once per document version, retaining roles rather than palette colors. */
export function highlightDocumentRange(
	document: TextDocument,
	language: string | undefined,
	startLine = 0,
	endLine = document.lineCount(),
): HighlightedDocumentRange {
	const lineCount = document.lineCount();
	const start = Math.max(0, Math.min(lineCount, Math.trunc(startLine)));
	const end = Math.max(start, Math.min(lineCount, Math.trunc(endLine)));
	const version = document.version();
	const languageKey = language ?? "";
	const cache = versionCache(document, languageKey, version);
	const key = `${start}:${end}`;
	const hit = cache.ranges.get(key);
	if (hit !== undefined) return hit;

	const fullKey = `0:${lineCount}`;
	let full = cache.ranges.get(fullKey);
	if (!full) {
		const sourceLines = new Array<string>(lineCount);
		for (let line = 0; line < lineCount; line++) sourceLines[line] = document.line(line);
		full = { version, startLine: 0, endLine: lineCount, lines: highlightTextLines(sourceLines, language) };
		cache.ranges.set(fullKey, full);
	}
	const lines = start === 0 && end === lineCount ? full.lines : full.lines.slice(start, end);
	const result: HighlightedDocumentRange = { version, startLine: start, endLine: end, lines };
	cache.ranges.set(key, result);
	return result;
}
