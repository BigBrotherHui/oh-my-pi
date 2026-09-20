/**
 * Shared utilities and constants for tool renderers.
 *
 * Provides consistent formatting, truncation, and display patterns across all
 * tool renderers to ensure a unified TUI experience.
 */

import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Ellipsis } from "@oh-my-pi/pi-natives";
import { pluralize, sanitizeText } from "@oh-my-pi/pi-utils";
import { formatKeyHints, type KeyId } from "../app-keybindings";
import { getKeybindings } from "../keybindings";
import type { Theme } from "../theme/theme";
import { replaceTabs, truncateToWidth } from "../utils";

export { Ellipsis } from "@oh-my-pi/pi-natives";
export { replaceTabs, truncateToWidth, wrapTextWithAnsi } from "../utils";

/** A thinking selector configured as a concrete level or automatic selection. */
export type ConfiguredThinkingLevel = ThinkingLevel | "auto";

/**
 * Normalize stray carriage returns in model-authored display text. Some models
 * (observed with GLM via OpenRouter) degenerate into injecting `\r` runs between
 * words inside JSON string values; CommonMark treats a lone `\r` as a line
 * ending, which splatters the text one word per row. CRLF becomes LF, CR runs
 * collapse to a single space — word separators in prose, one indent unit in
 * mangled code previews.
 */
export function sanitizeCarriageReturns(text: string): string {
	if (!text.includes("\r")) return text;
	return text.replaceAll("\r\n", "\n").replace(/\r+/g, " ");
}

/**
 * Sanitize raw ask option labels into unique, action-safe display copies.
 * Degenerate input can sanitize alike (`Retry\rnow`/`Retry now`) or match a
 * runtime action row (`Other (type your own)`); both would answer the wrong
 * row, so colliding entries take a numeric suffix. Order and length are
 * preserved, so indices still align with the original labels for mapping
 * answers and dialog state back. Every ask race participant (local dialog,
 * guest selector) must call this with the same `reservedLabels` so a
 * question renders identically wherever it is answered.
 */
export function disambiguateDisplayLabels(rawLabels: string[], reservedLabels: readonly string[]): string[] {
	const taken = new Set<string>(reservedLabels);
	return rawLabels.map(raw => {
		const base = sanitizeCarriageReturns(raw);
		let candidate = base;
		for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base} (${suffix})`;
		taken.add(candidate);
		return candidate;
	});
}

// =============================================================================
// Standardized Display Constants
// =============================================================================

/** Defaults for the host's tui.maxInlineImageColumns and tui.maxInlineImageRows settings. */
let inlineImageMaxColumns = 100;
let inlineImageMaxRows = 20;

/** Set the maximum inline image width in terminal columns; zero leaves it uncapped. */
export function setInlineImageMaxColumns(maxColumns: number): void {
	inlineImageMaxColumns = maxColumns;
}

/** Set the maximum inline image height in terminal rows; zero uses the viewport limit. */
export function setInlineImageMaxRows(maxRows: number): void {
	inlineImageMaxRows = maxRows;
}

/** Resolve inline image dimension caps from the configured limits and viewport. */
export function resolveImageOptions(): { maxWidthCells: number; maxHeightCells?: number } {
	const maxWidthCells = inlineImageMaxColumns;
	const rowSetting = Math.max(0, inlineImageMaxRows);
	const viewportRows = process.stdout.rows;
	const viewportFraction = viewportRows ? Math.floor(viewportRows * 0.6) : 0;
	let maxHeightCells: number | undefined;
	if (rowSetting === 0) {
		// No explicit cap — use viewport fraction as safety bound
		maxHeightCells = viewportFraction || undefined;
	} else if (viewportFraction > 0) {
		maxHeightCells = Math.min(rowSetting, viewportFraction);
	} else {
		// Viewport size unknown (transitional state) — honor explicit setting
		maxHeightCells = rowSetting;
	}
	return { maxWidthCells, maxHeightCells };
}

/** Preview limits for collapsed/expanded views */
export const PREVIEW_LIMITS = {
	/** Lines shown in collapsed view */
	COLLAPSED_LINES: 3,
	/** Lines shown in expanded view */
	EXPANDED_LINES: 12,
	/** Items (files, results) shown in collapsed view */
	COLLAPSED_ITEMS: 8,
	/** Output preview lines in collapsed view */
	OUTPUT_COLLAPSED: 3,
	/** Output preview lines in expanded view */
	OUTPUT_EXPANDED: 10,
	/** Computer script lines shown in collapsed view */
	COMPUTER_CODE_COLLAPSED: 10,
	/** Max hunks shown when collapsed (edit tool) */
	DIFF_COLLAPSED_HUNKS: 8,
	/** Max diff lines shown when collapsed (edit tool) */
	DIFF_COLLAPSED_LINES: 40,
} as const;

/** Default number of terminal output rows shown before expansion. */
export const DEFAULT_TERMINAL_PREVIEW_LINES = 10;

/** Match a Markdown fenced-code opener and capture its indentation and marker. */
export const FENCE_RE = /^( {0,3})([`~]{3,})/;

/** Shared empty link-target lookup for renderers without interactive links. */
export const EMPTY_LINK_TARGETS: ReadonlyMap<string, string> = new Map();

/** Default display width reserved for a resolved model badge. */
export const FEED_MODEL_BADGE_WIDTH = 30;

let feedModelBadgeEnabled = false;

/** Set whether feed rows display their resolved model badge. */
export function setFeedModelBadgeEnabled(enabled: boolean): void {
	feedModelBadgeEnabled = enabled;
}

/** Return whether resolved model badges are enabled. */
export function isFeedModelBadgeEnabled(): boolean {
	return feedModelBadgeEnabled;
}

/** Compact glyph for a configured thinking level; empty for `inherit` (nothing to show). */
export function thinkingLevelGlyph(level: ConfiguredThinkingLevel, uiTheme: Theme): string {
	if (level === ThinkingLevel.Inherit) return "";
	if (level === ThinkingLevel.Off) return uiTheme.status.disabled;
	const symbol = uiTheme.thinking[level === "auto" ? "autoPending" : level];
	if (typeof symbol !== "string") return "";
	const space = symbol.indexOf(" ");
	return space < 0 ? symbol : symbol.slice(0, space);
}

/** Truncation lengths for different content types */
export const TRUNCATE_LENGTHS = {
	/** Short titles, labels */
	TITLE: 60,
	/** Medium-length content (messages, previews) */
	CONTENT: 80,
	/** Longer content (code, explanations) */
	LONG: 100,
	/** Full line content */
	LINE: 110,
	/** Very short (task previews, badges) */
	SHORT: 40,
	/** Idle recap status line (~40-word LLM reply) */
	RECAP: 280,
} as const;

/** Keybinding action that toggles tool-output expansion. */
const EXPAND_ACTION = "app.tools.expand";
/** Fallback key when no binding is resolvable (e.g. outside an interactive session). */
const DEFAULT_EXPAND_KEY: KeyId = "ctrl+o";

/** Human-readable key currently bound to tool-output expansion, e.g. `Ctrl+O`. */
export function expandKeyHint(): string {
	const keys = getKeybindings().getKeys(EXPAND_ACTION);
	return formatKeyHints(keys.length > 0 ? keys : [DEFAULT_EXPAND_KEY]);
}

// =============================================================================
// Text Truncation Utilities
// =============================================================================

/** Select a leading line window and count the lines hidden after it. */
export function cappedHeadLines(lines: readonly string[], max: number): { lines: readonly string[]; hidden: number } {
	const count = Math.max(0, Math.min(lines.length, Math.floor(max)));
	return { lines: count === lines.length ? lines : lines.slice(0, count), hidden: lines.length - count };
}

/** Get the first nonblank preview lines, trimmed and width-capped. */
export function getPreviewLines(text: string, maxLines: number, maxLineLen: number, ellipsis?: Ellipsis): string[] {
	const lines = text.split("\n").filter(l => l.trim());
	return lines.slice(0, maxLines).map(l => truncateToWidth(l.trim(), maxLineLen, ellipsis));
}

/**
 * Collapse a possibly multi-line string into a single line, then truncate it to
 * `maxWidth` display cells. {@link truncateToWidth} alone caps width but
 * newlines are zero-width, so multi-line content (markdown briefs, tool args,
 * provider errors) would otherwise spill a single status row across several
 * visual lines. Whitespace runs collapse to one space, so tabs are handled too.
 */
export function previewLine(text: string, maxWidth: number, ellipsis?: Ellipsis): string {
	return truncateToWidth(text.replace(/\s+/g, " ").trim(), maxWidth, ellipsis);
}

// =============================================================================
// URL Utilities
// =============================================================================

/**
 * Extract domain from URL, stripping www. prefix.
 */
export function getDomain(url: string): string {
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

// =============================================================================
// Formatting Utilities
// =============================================================================

export { formatAge, formatBytes, formatCount, formatDuration, formatNumber, pluralize } from "@oh-my-pi/pi-utils";

// =============================================================================
// Theme Helper Utilities
// =============================================================================

/**
 * Format the expand hint with proper theming.
 * Returns empty string if already expanded or there is nothing more to show.
 */
export function formatExpandHint(theme: Theme, expanded?: boolean, hasMore?: boolean): string {
	return expanded || hasMore === false ? "" : wrapBrackets(`${expandKeyHint()}: Expand`, theme);
}

/** Build a conventional "more items" suffix for truncated lists. */
export function formatMoreItems(remaining: number, itemType: string): string {
	return `… ${remaining} more ${pluralize(itemType, remaining)}`;
}

/**
 * Collapsed command/code previews render a tail window sized from the live
 * viewport: terminal rows minus a reserve for the rest of the block (frame,
 * Output section, stats line) and the editor/status area below the
 * transcript. This keeps a volatile streaming block from growing past the
 * viewport and stranding its top, while letting tall terminals show more.
 */
const PREVIEW_WINDOW_RESERVED_ROWS = 20;
/** Floor so tiny or unknown viewports still show a useful window. */
const PREVIEW_WINDOW_MIN_LINES = 6;
/** Assumed viewport when rows are unknown (non-TTY, tests). */
const PREVIEW_WINDOW_FALLBACK_ROWS = 30;

/** Tail-window height for collapsed command/code previews. */
export function previewWindowRows(rows = process.stdout.rows || PREVIEW_WINDOW_FALLBACK_ROWS): number {
	return Math.max(PREVIEW_WINDOW_MIN_LINES, rows - PREVIEW_WINDOW_RESERVED_ROWS);
}

/**
 * Split multi-line tool text into TUI-safe display lines.
 * Splits CRLF/LF, collapses stray `\r` progress overwrites to the final
 * segment (mirroring terminal rendering), and expands tabs — so raw
 * subprocess or fetched output (e.g. Windows ssh emitting CRLF, tab-indented
 * web content) can't corrupt the framed block layout with cursor-moving
 * control characters or tab-stop width mismatches.
 */
export function sanitizeDisplayLines(text: string): string[] {
	return text.split(/\r?\n/).map(line => {
		const idx = line.lastIndexOf("\r");
		return replaceTabs(sanitizeText(idx < 0 ? line : line.slice(idx + 1)));
	});
}

// =============================================================================
// Code Frame Formatting
// =============================================================================

/** Marker displayed in the gutter of a code frame. */
export type CodeFrameMarker = "" | " " | "*" | "+" | "-" | ">";

/** Format a code-frame row with a padded line-number gutter. */
export function formatCodeFrameLine(
	marker: CodeFrameMarker,
	lineNumber: string | number,
	content: string,
	lineNumberWidth: number,
): string {
	const markerText = marker.trim();
	const lineNumberText = String(lineNumber).trim();
	const gutterText = markerText && lineNumberText ? `${markerText}${lineNumberText}` : lineNumberText || markerText;
	return `${gutterText.padStart(lineNumberWidth + 1, " ")}│${content}`;
}

// =============================================================================
// Diagnostic Formatting
// =============================================================================

/** Parsed diagnostic location, severity, and optional source and code metadata. */
export interface ParsedDiagnostic {
	filePath: string;
	line: number;
	col: number;
	severity: "error" | "warning" | "info" | "hint";
	source?: string;
	message: string;
	code?: string;
}

/** Normalize diagnostic tabs and carriage returns while preserving message line breaks. */
export function sanitizeDiagnosticDisplayText(text: string): string {
	return replaceTabs(text.replace(/\r/g, ""));
}

/** Parse a diagnostic location and message, including optional source and code. */
export function parseDiagnosticMessage(msg: string): ParsedDiagnostic | null {
	const match = msg.match(/^(.+?):(\d+):(\d+)\s+\[(\w+)\]\s+(?:\[([^\]]+)\]\s+)?([\s\S]+?)(?:\s+\(([^)]+)\))?$/);
	if (!match) return null;
	return {
		filePath: sanitizeDiagnosticDisplayText(match[1]),
		line: parseInt(match[2], 10),
		col: parseInt(match[3], 10),
		severity: match[4] as ParsedDiagnostic["severity"],
		source: match[5] ? sanitizeDiagnosticDisplayText(match[5]) : undefined,
		message: sanitizeDiagnosticDisplayText(match[6]),
		code: match[7] ? sanitizeDiagnosticDisplayText(match[7]) : undefined,
	};
}

// =============================================================================
// Diff Utilities
// =============================================================================

/** Added and removed line counts and hunk metadata for a diff. */
export interface DiffStats {
	added: number;
	removed: number;
	hunks: number;
	lines: number;
}

/** Count added lines, removed lines, and hunks in a unified diff. */
export function getDiffStats(diffText: string): DiffStats {
	const lines = diffText ? diffText.split("\n") : [];
	let added = 0;
	let removed = 0;
	let hunks = 0;
	let inHunk = false;

	for (const line of lines) {
		const isAdded = line.startsWith("+");
		const isRemoved = line.startsWith("-");
		const isChange = isAdded || isRemoved;

		if (isAdded) added++;
		if (isRemoved) removed++;

		if (isChange && !inHunk) {
			hunks++;
			inHunk = true;
		} else if (!isChange) {
			inHunk = false;
		}
	}

	return { added, removed, hunks, lines: lines.length };
}

interface DiffSegment {
	lines: string[];
	isChange: boolean;
	isEllipsis: boolean;
}

function parseDiffSegments(lines: string[]): DiffSegment[] {
	const segments: DiffSegment[] = [];
	let current: DiffSegment | null = null;

	for (const line of lines) {
		const isChange = line.startsWith("+") || line.startsWith("-");
		const isEllipsis = line.trimStart().startsWith("...") || line.trim().length === 0;

		if (isEllipsis) {
			if (current) segments.push(current);
			segments.push({ lines: [line], isChange: false, isEllipsis: true });
			current = null;
		} else if (!current || current.isChange !== isChange) {
			if (current) segments.push(current);
			current = { lines: [line], isChange, isEllipsis: false };
		} else {
			current.lines.push(line);
		}
	}

	if (current) segments.push(current);
	return segments;
}

/** Truncate a unified diff at hunk boundaries within the supplied preview limits. */
export function truncateDiffByHunk(
	diffText: string,
	maxHunks: number,
	maxLines: number,
	options?: { fromTail?: boolean },
): { text: string; hiddenHunks: number; hiddenLines: number } {
	if (options?.fromTail) {
		// Streaming previews want to track the tail of the diff as new hunks
		// arrive. Reversing the line buffer reuses the head-mode logic without
		// duplicating the segment-budget bookkeeping: hunk runs survive
		// reversal (a continuous `+`/`-` block stays contiguous) and so do the
		// per-line `+`/`-` markers, so getDiffStats yields identical counts.
		const reversed = (diffText ?? "").split("\n").reverse().join("\n");
		const result = truncateDiffByHunk(reversed, maxHunks, maxLines);
		return {
			text: result.text.split("\n").reverse().join("\n"),
			hiddenHunks: result.hiddenHunks,
			hiddenLines: result.hiddenLines,
		};
	}
	const lines = diffText ? diffText.split("\n") : [];
	const totalStats = getDiffStats(diffText);

	if (lines.length <= maxLines && totalStats.hunks <= maxHunks) {
		return { text: diffText, hiddenHunks: 0, hiddenLines: 0 };
	}

	const segments = parseDiffSegments(lines);

	const changeSegments = segments.filter(s => s.isChange);
	const changeLineCount = changeSegments.reduce((sum, s) => sum + s.lines.length, 0);

	if (changeLineCount > maxLines) {
		const kept: string[] = [];
		let keptHunks = 0;

		for (const seg of segments) {
			if (kept.length >= maxLines) break;
			if (seg.isChange) {
				if (keptHunks >= maxHunks) break;
				keptHunks++;
			}
			const take = Math.min(seg.lines.length, maxLines - kept.length);
			for (let i = 0; i < take; i++) {
				kept.push(seg.lines[i]!);
			}
		}

		return {
			text: kept.join("\n"),
			hiddenHunks: Math.max(0, totalStats.hunks - keptHunks),
			hiddenLines: Math.max(0, lines.length - kept.length),
		};
	}

	const contextBudget = maxLines - changeLineCount;
	const contextSegments = segments.filter(s => !s.isChange);
	const totalContextLines = contextSegments.reduce((sum, s) => sum + s.lines.length, 0);

	const kept: string[] = [];
	let keptHunks = 0;
	let keptSourceLines = 0;

	if (totalContextLines <= contextBudget) {
		for (const seg of segments) {
			if (seg.isChange) {
				if (keptHunks >= maxHunks) break;
				keptHunks++;
			}
			kept.push(...seg.lines);
			keptSourceLines += seg.lines.length;
		}
	} else {
		const contextRatio = totalContextLines > 0 ? contextBudget / totalContextLines : 0;
		let remainingContextBudget = contextBudget;

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];

			if (seg.isChange) {
				if (keptHunks >= maxHunks) break;
				keptHunks++;
				kept.push(...seg.lines);
				keptSourceLines += seg.lines.length;
				continue;
			}
			if (remainingContextBudget <= 0) continue;

			const allowedLines = Math.min(
				remainingContextBudget,
				Math.max(1, Math.floor(seg.lines.length * contextRatio)),
			);
			const outputStart = kept.length;
			let sourceLinesAdded = 0;

			if (seg.isEllipsis || seg.lines.length <= allowedLines) {
				for (let j = 0; j < allowedLines; j++) {
					kept.push(seg.lines[j]!);
				}
				sourceLinesAdded = allowedLines;
			} else {
				const isBeforeChange = segments[i + 1]?.isChange;
				const isAfterChange = segments[i - 1]?.isChange;

				if (isBeforeChange && isAfterChange) {
					if (allowedLines >= 3) {
						const sourceBudget = allowedLines - 1;
						const firstCount = Math.ceil(sourceBudget / 2);
						const lastCount = sourceBudget - firstCount;
						kept.push(...seg.lines.slice(0, firstCount));
						kept.push("");
						if (lastCount > 0) kept.push(...seg.lines.slice(-lastCount));
						sourceLinesAdded = sourceBudget;
					} else {
						const firstCount = Math.ceil(allowedLines / 2);
						const lastCount = allowedLines - firstCount;
						kept.push(...seg.lines.slice(0, firstCount));
						if (lastCount > 0) kept.push(...seg.lines.slice(-lastCount));
						sourceLinesAdded = allowedLines;
					}
				} else if (isBeforeChange) {
					kept.push(...seg.lines.slice(-allowedLines));
					sourceLinesAdded = allowedLines;
				} else if (isAfterChange) {
					kept.push(...seg.lines.slice(0, allowedLines));
					sourceLinesAdded = allowedLines;
				} else {
					const take = Math.min(allowedLines, 2);
					kept.push(...seg.lines.slice(0, take));
					sourceLinesAdded = take;
				}
			}

			keptSourceLines += sourceLinesAdded;
			remainingContextBudget -= kept.length - outputStart;
		}
	}

	return {
		text: kept.join("\n"),
		hiddenHunks: Math.max(0, totalStats.hunks - keptHunks),
		hiddenLines: Math.max(0, lines.length - keptSourceLines),
	};
}

// =============================================================================
// Path Utilities
// =============================================================================

let cachedHomeDir: string | undefined;
let cachedHomedir: typeof os.homedir | undefined;

function defaultHomeDir(): string {
	const homedir = os.homedir;
	if (cachedHomeDir === undefined || cachedHomedir !== homedir) {
		cachedHomedir = homedir;
		cachedHomeDir = homedir();
	}
	return cachedHomeDir;
}

const homePatternCache = new Map<string, RegExp>();
function homePatternFor(homeDir: string, windowsStyle: boolean): RegExp {
	const key = `${windowsStyle ? 1 : 0} ${homeDir}`;
	let pattern = homePatternCache.get(key);
	if (pattern === undefined) {
		const escapedHome = windowsStyle
			? homeDir
					.replaceAll("/", "\\")
					.split("\\")
					.map(part => RegExp.escape(part))
					.join("[\\\\/]")
			: RegExp.escape(homeDir);
		pattern = new RegExp(
			`[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s"'<>]+|(^|[\\s"'\\x60([{=,:])(${escapedHome})(?=$|[\\\\/\\s"'\\x60)\\]},;:])`,
			windowsStyle ? "gi" : "g",
		);
		if (homePatternCache.size >= 16) homePatternCache.clear();
		homePatternCache.set(key, pattern);
	}
	return pattern;
}

/** Replace a leading home directory with a portable tilde prefix. */
export function shortenPath(filePath: unknown, homeDir?: string): string {
	if (typeof filePath !== "string") {
		return "";
	}
	const home = homeDir ?? defaultHomeDir();
	const windowsStyle = /^[A-Za-z]:[\\/]/.test(home) || home.startsWith("\\\\");
	const hasHomePrefix = windowsStyle
		? filePath.toLowerCase().startsWith(home.toLowerCase())
		: filePath.startsWith(home);
	if (home && hasHomePrefix) {
		const suffix = filePath.slice(home.length);
		if (suffix === "" || suffix.startsWith(path.posix.sep) || suffix.startsWith(path.win32.sep)) {
			return `~${suffix.replaceAll(path.win32.sep, path.posix.sep)}`;
		}
	}
	return filePath;
}

/** Shorten embedded home paths; normalize Windows separators unless the caller preserves native error text. */
export function shortenEmbeddedPaths(text: string, homeDir?: string, preserveSeparators = false): string {
	const resolvedHome = homeDir ?? defaultHomeDir();
	if (!resolvedHome || resolvedHome.length <= 1) return text;
	const windowsStyle = /^[A-Za-z]:[\\/]/.test(resolvedHome) || resolvedHome.startsWith("\\\\");
	const homePattern = homePatternFor(resolvedHome, windowsStyle);
	const textWithShortenedHome = text.replace(
		homePattern,
		(match, boundary: string | undefined, candidate: string | undefined) =>
			candidate === undefined ? match : `${boundary}~`,
	);
	if (preserveSeparators) return textWithShortenedHome;
	return textWithShortenedHome
		.split(" ")
		.map(segment => {
			const leading = segment.match(/^[("'`[]*/)?.[0] ?? "";
			const trailing = segment.match(/[)"'`,.;:\]]*$/)?.[0] ?? "";
			const end = segment.length - trailing.length;
			if (leading.length >= end) return segment;
			const shortened = shortenPath(segment.slice(leading.length, end), resolvedHome);
			const normalized = shortened.startsWith("~")
				? shortened.replaceAll(path.win32.sep, path.posix.sep)
				: shortened;
			return `${leading}${normalized}${trailing}`;
		})
		.join(" ");
}

/** Sanitize warning text before showing it in TUI, including embedded home paths. */
export function sanitizeDisplayWarning(text: string): string {
	return shortenEmbeddedPaths(
		replaceTabs(sanitizeText(text))
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
}

/** Sanitize and bound warning text before showing it in TUI. */
export function sanitizeDisplayWarnings(warnings: readonly string[]): string[] {
	const visible = warnings
		.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS)
		.map(warning => truncateToWidth(sanitizeDisplayWarning(warning), TRUNCATE_LENGTHS.LONG));
	const hidden = warnings.length - visible.length;
	if (hidden > 0) visible.push(`… ${hidden} more ${pluralize("warning", hidden)}`);
	return visible;
}

/** Format a tool working directory when it differs from the project directory. */
export function formatToolWorkingDirectory(workdir: string | undefined, projectDir: string): string | undefined {
	if (!workdir) return undefined;
	const resolvedProjectDir = path.resolve(projectDir);
	const resolvedWorkdir = path.resolve(projectDir, workdir);
	if (resolvedWorkdir === resolvedProjectDir) {
		return undefined;
	}
	const relativePath = path.relative(resolvedProjectDir, resolvedWorkdir);
	const isWithinProject =
		relativePath.length > 0 && !relativePath.startsWith("..") && !relativePath.startsWith(`..${path.sep}`);
	const displayWorkdir = isWithinProject ? relativePath : shortenPath(resolvedWorkdir);
	return replaceTabs(displayWorkdir);
}

/** Wrap text in the theme-specific bracket pair. */
export function wrapBrackets(text: string, theme: Theme): string {
	return `${theme.format.bracketLeft}${text}${theme.format.bracketRight}`;
}

/** Maximum number of parse errors displayed in expanded details. */
export const PARSE_ERRORS_LIMIT = 20;

/** Deduplicate parse errors while preserving their original order. */
export function dedupeParseErrors(errors: string[] | undefined): string[] {
	if (!errors || errors.length === 0) return [];
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const error of errors) {
		if (seen.has(error)) continue;
		seen.add(error);
		deduped.push(error);
	}
	return deduped;
}

/** Format deduplicated parse errors with a bounded detail list. */
export function formatParseErrors(errors: string[], total?: number): string[] {
	const deduped = dedupeParseErrors(errors);
	if (deduped.length === 0) return [];
	const fullCount = total ?? deduped.length;
	const capped = deduped.slice(0, PARSE_ERRORS_LIMIT);
	const header = fullCount > capped.length ? `Parse issues (${capped.length} / ${fullCount}):` : "Parse issues:";
	return [header, ...capped.map(err => `- ${err}`)];
}

/**
 * Cap an upstream parse-error list to {@link PARSE_ERRORS_LIMIT} unique entries,
 * preserving the original deduplicated total. Use this at the source so tool
 * details never carry thousands of per-file parse errors into traces or
 * renderers.
 */
export function capParseErrors(
	errors: string[] | undefined,
	limit: number = PARSE_ERRORS_LIMIT,
): { errors: string[]; total: number } {
	const deduped = dedupeParseErrors(errors);
	return { errors: deduped.slice(0, limit), total: deduped.length };
}

// =============================================================================
// Renderer helpers shared by search / find / ast tools
// =============================================================================

/**
 * Human-readable summary string for the parse-issues count, capped by
 * {@link PARSE_ERRORS_LIMIT}.
 */
export function formatParseErrorsCountLabel(parseErrors: readonly string[], total?: number): string {
	const fullCount = total ?? parseErrors.length;
	return fullCount > PARSE_ERRORS_LIMIT
		? `${PARSE_ERRORS_LIMIT} / ${fullCount} parse issues`
		: `${fullCount} parse issue${fullCount !== 1 ? "s" : ""}`;
}

/**
 * Parse a JSON-encoded array of path strings (e.g. `'["a.ts","b.ts"]'`).
 * Returns `null` when the input is not a bracketed JSON string array, so the
 * caller can fall back to treating the input as a single literal path.
 */
function parseStringEncodedPathArray(input: string): string[] | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}

	if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== "string")) {
		return null;
	}
	return parsed;
}

/**
 * Normalize a path argument that may arrive as a single string, a JSON-encoded
 * string array (`'["a.ts"]'`), or an actual array into a flat `string[]`.
 * Delimited single strings (`"a.ts b.ts"`) remain literal.
 */
export function toPathList(input: string | string[] | undefined): string[] {
	if (typeof input === "string") return parseStringEncodedPathArray(input) ?? [input];
	return input ?? [];
}
