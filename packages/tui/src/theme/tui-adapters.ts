import {
	type HighlightColors as NativeHighlightColors,
	HighlightStream as NativeHighlightStream,
	highlightCode as nativeHighlightCode,
	supportsLanguage as nativeSupportsLanguage,
	warmHighlighter as nativeWarmHighlighter,
} from "@oh-my-pi/pi-natives";
import type { EditorTheme } from "../components/editor";
import type { MarkdownTheme } from "../components/markdown-engine";
import type { SymbolTheme } from "../symbols";
import { Attr, Style } from "../core/style";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { resolveMermaidAscii } from "./mermaid-cache";
import type { SlashCommandIconName } from "./symbols";
import { ensureThemeSync, theme } from "./theme";
import type { Theme } from "./theme-class";

// ============================================================================
// TUI Helpers
// ============================================================================

let cachedHighlightColorsFor: Theme | undefined;
let cachedHighlightColors: NativeHighlightColors | undefined;

function getHighlightColors(t: Theme): NativeHighlightColors {
	if (cachedHighlightColorsFor !== t || !cachedHighlightColors) {
		cachedHighlightColorsFor = t;
		cachedHighlightColors = {
			comment: t.getFgAnsi("syntaxComment"),
			keyword: t.getFgAnsi("syntaxKeyword"),
			function: t.getFgAnsi("syntaxFunction"),
			variable: t.getFgAnsi("syntaxVariable"),
			string: t.getFgAnsi("syntaxString"),
			number: t.getFgAnsi("syntaxNumber"),
			type: t.getFgAnsi("syntaxType"),
			operator: t.getFgAnsi("syntaxOperator"),
			punctuation: t.getFgAnsi("syntaxPunctuation"),
			inserted: t.getFgAnsi("toolDiffAdded"),
			deleted: t.getFgAnsi("toolDiffRemoved"),
		};
	}
	return cachedHighlightColors;
}

/**
 * Memoized native syntax highlight. Returns the joined ANSI string, or `null`
 * when the native tokenizer throws so callers can apply their own fallback.
 *
 * Keyed on `(lang, code)` and reset whenever the active `theme` instance
 * changes — the ANSI colors are baked into the highlighted output, so a theme
 * switch (which always reassigns `theme`) must invalidate every entry.
 *
 * Why this exists: animated tool blocks (eval/bash) repaint their box on every
 * ~33ms border-shimmer frame, and markdown re-lexes on every streamed delta.
 * Without memoization each frame can re-tokenize an unchanged code body through
 * the Rust FFI — ~26ms for 100 lines, ~40ms for 150 — consuming or overrunning
 * the 33ms frame budget and starving the spinner/render timers (the "TUI freeze").
 */
const HIGHLIGHT_CACHE_MAX = 256;
const highlightCache = new LRUCache<string, string>({ max: HIGHLIGHT_CACHE_MAX });
let highlightCacheTheme: Theme | undefined;

function highlightCached(code: string, validLang: string | undefined, highlightTheme: Theme): string | null {
	if (validLang === undefined) return code;
	if (highlightCacheTheme !== highlightTheme) {
		highlightCache.clear();
		highlightCacheTheme = highlightTheme;
	}
	const key = `${validLang ?? ""}\x00${code}`;
	const hit = highlightCache.get(key);
	if (hit !== undefined) {
		return hit;
	}
	let highlighted: string;
	try {
		highlighted = nativeHighlightCode(code, validLang, getHighlightColors(highlightTheme));
	} catch {
		return null;
	}
	highlightCache.set(key, highlighted);
	return highlighted;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string, highlightTheme: Theme = theme): string[] {
	const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
	const highlighted = highlightCached(code, validLang, highlightTheme);
	// Always return a fresh array: callers (e.g. renderCodeCell) push extra lines
	// onto the result, which would corrupt the cached string otherwise.
	return (highlighted ?? code).split("\n");
}

/** Create a stateful highlighter for progressive terminal rendering. */
export function createHighlightStream(lang?: string, highlightTheme: Theme = theme): NativeHighlightStream | null {
	const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
	if (!validLang) return null;
	// Workspace loads skip the natives version sentinel, so a stale local
	// `.node` can omit `HighlightStream` after a pull. Napi constructors can
	// also throw; callers degrade to plain text instead of aborting a render.
	try {
		if (typeof NativeHighlightStream !== "function") return null;
		return new NativeHighlightStream(validLang, getHighlightColors(highlightTheme));
	} catch {
		return null;
	}
}

let highlighterWarmup: Promise<void> | undefined;

/** Warm native syntax grammars off-thread once per process. */
export function warmHighlighter(): Promise<void> {
	if (!highlighterWarmup) {
		highlighterWarmup =
			typeof nativeWarmHighlighter === "function"
				? nativeWarmHighlighter().catch(() => undefined)
				: Promise.resolve();
	}
	return highlighterWarmup;
}

/** Resolve editor and Markdown glyphs from an explicit palette or the application theme. */
export function getSymbolTheme(palette: Theme | undefined = theme): SymbolTheme {
	if (palette === undefined) {
		const box = {
			topLeft: "+",
			topRight: "+",
			bottomLeft: "+",
			bottomRight: "+",
			horizontal: "-",
			vertical: "|",
			cross: "+",
			teeDown: "+",
			teeUp: "+",
			teeLeft: "+",
			teeRight: "+",
		};
		return {
			cursor: ">",
			inputCursor: "|",
			boxRound: box,
			boxSharp: box,
			table: box,
			quoteBorder: "|",
			hrChar: "-",
			colorSwatch: "[]",
			spinnerFrames: ["-", "\\", "|", "/"],
		};
	}
	const preset = palette.getSymbolPreset();

	return {
		cursor: palette.nav.cursor,
		inputCursor: preset === "ascii" ? "|" : "▏",
		boxRound: palette.boxRound,
		boxSharp: palette.boxSharp,
		table: palette.boxSharp,
		quoteBorder: palette.md.quoteBorder,
		hrChar: palette.md.hrChar,
		colorSwatch: palette.md.colorSwatch,
		spinnerFrames: palette.getSpinnerFrames("activity"),
	};
}

let cachedMarkdownTheme: MarkdownTheme | undefined;
let cachedMarkdownThemeRef: Theme | undefined;
let markdownMermaidRendering = true;

export function setMarkdownMermaidRendering(enabled: boolean): void {
	if (markdownMermaidRendering === enabled) return;
	markdownMermaidRendering = enabled;
	cachedMarkdownTheme = undefined;
}

export function getMarkdownTheme(): MarkdownTheme {
	ensureThemeSync();
	if (cachedMarkdownTheme !== undefined && cachedMarkdownThemeRef === theme) {
		return cachedMarkdownTheme;
	}
	const mermaid = markdownMermaidRendering
		? (() => {
				// Diagram geometry is content, so keep every structural stroke on the
				// theme's readable muted foreground instead of subtle UI chrome borders.
				const mermaidColorMode =
					theme.getColorMode() === "truecolor" ? ("truecolor" as const) : ("ansi256" as const);
				const mermaidTheme = {
					fg: theme.getColorHex("text"),
					border: theme.getColorHex("muted"),
					line: theme.getColorHex("muted"),
					arrow: theme.getColorHex("accent"),
					corner: theme.getColorHex("muted"),
					junction: theme.getColorHex("muted"),
				};
				return { mermaidColorMode, mermaidTheme };
			})()
		: undefined;
	const markdownTheme: MarkdownTheme = {
		heading: theme.style("mdHeading"),
		link: theme.style("mdLink"),
		linkUrl: theme.style("mdLinkUrl"),
		code: theme.style("mdCode"),
		codeBlock: theme.style("mdCodeBlock"),
		codeBlockBorder: theme.style("mdCodeBlockBorder"),
		quote: theme.style("mdQuote"),
		quoteBorder: theme.style("mdQuoteBorder"),
		hr: theme.style("mdHr"),
		listBullet: theme.style("mdListBullet"),
		bold: Style.NONE.plus(Attr.Bold),
		italic: Style.NONE.plus(Attr.Italic),
		underline: Style.NONE.plus(Attr.Underline),
		strikethrough: Style.NONE.plus(Attr.Strike),
		symbols: getSymbolTheme(),
		resolveMermaidAscii: mermaid
			? (source, maxWidth) =>
					resolveMermaidAscii(source, {
						maxWidth,
						theme: mermaid.mermaidTheme,
						colorMode: mermaid.mermaidColorMode,
					})
			: undefined,
		highlightCode: (code: string, lang?: string): string[] => {
			const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
			const highlighted = highlightCached(code, validLang, theme);
			if (highlighted !== null) return highlighted.split("\n");
			return code.split("\n").map(line => theme.fg("mdCodeBlock", line));
		},
		createHighlightStream: lang => createHighlightStream(lang, theme),
	};
	cachedMarkdownTheme = markdownTheme;
	cachedMarkdownThemeRef = theme;
	return markdownTheme;
}

/**
 * Resolve the autocomplete type-indicator glyph for a slash command.
 * Returns `undefined` when no theme is initialized or the active preset is
 * ASCII (shared `icon.*` glyphs have ASCII forms, but a partially lettered
 * icon column reads as noise), which collapses the column entirely.
 */
export function getSlashCommandTypeIcon(name: SlashCommandIconName): string | undefined {
	if (typeof theme === "undefined" || theme.getSymbolPreset() === "ascii") return undefined;
	const icon = theme.cmd[name];
	return icon.length > 0 ? icon : undefined;
}

/** Build native editor styles from a root palette, with a safe pre-initialization fallback. */
export function getEditorTheme(palette: Theme | undefined = theme): EditorTheme {
	if (palette === undefined) {
		return {
			borderStyle: Style.NONE,
			accentStyle: Style.NONE,
			surfaceStyle: Style.NONE,
			textStyle: Style.NONE,
			symbols: getSymbolTheme(palette),
			hintStyle: Style.NONE,
		};
	}
	return {
		borderStyle: palette.style("borderMuted"),
		accentStyle: palette.style("accent"),
		surfaceStyle: Style.of({
			fg: palette.fgOnBgColor("userMessageText", "userMessageBg"),
			bg: palette.bgColor("userMessageBg"),
		}),
		textStyle: palette.style("text"),
		symbols: getSymbolTheme(palette),
		hintStyle: palette.style("dim"),
	};
}
