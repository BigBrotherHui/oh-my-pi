/** JSON tree formatting helpers. */
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";

export const JSON_TREE_MAX_DEPTH_COLLAPSED = 2;
export const JSON_TREE_MAX_DEPTH_EXPANDED = 6;
export const JSON_TREE_MAX_LINES_COLLAPSED = 6;
export const JSON_TREE_MAX_LINES_EXPANDED = 200;
export const JSON_TREE_SCALAR_LEN_COLLAPSED = 60;
export const JSON_TREE_SCALAR_LEN_EXPANDED = 2000;

const HIDDEN_ARG_KEYS = { [INTENT_FIELD]: 1, __partialJson: 1 };
const ARGS_INLINE_PAIR_SEP = ", ";
const ARGS_INLINE_PAIR_SEP_WIDTH = Bun.stringWidth(ARGS_INLINE_PAIR_SEP);
const ARGS_INLINE_MORE = "…";
const ARGS_INLINE_MORE_WIDTH = Bun.stringWidth(ARGS_INLINE_MORE);
const ARGS_INLINE_TAIL_VALUE_RESERVE = 4;

export type JsonTextSanitizer = (value: string) => string;

export interface InlineFormatOptions {
	readonly sanitizeText?: JsonTextSanitizer;
	readonly multilineSummary?: boolean;
	readonly characterBudget?: boolean;
}

function truncateInline(value: string, maxWidth: number): string {
	if (Bun.stringWidth(value) <= maxWidth) return value;
	if (maxWidth < 1) return "";
	const ellipsis = "…";
	if (maxWidth === 1) return ellipsis;
	let result = "";
	let width = 0;
	for (const grapheme of Array.from(value)) {
		const next = Bun.stringWidth(grapheme);
		if (width + next > maxWidth - 1) break;
		result += grapheme;
		width += next;
	}
	return `${result}${ellipsis}`;
}

export function formatScalar(value: unknown, maxLen: number, options: InlineFormatOptions = {}): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (typeof value === "string") {
		const text = options.sanitizeText?.(value) ?? value;
		if (options.multilineSummary) {
			const lines = text.split("\n");
			const firstLine = lines[0]!.trim();
			if (!firstLine) return `"" (${lines.length} lines)`;
			const preview = truncateInline(firstLine, maxLen);
			return lines.length > 1 ? `"${preview}…" (${lines.length} lines)` : `"${preview}"`;
		}
		return `"${truncateInline(text.replace(/\n/g, "\\n").replace(/\t/g, "\\t"), maxLen)}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (isRecord(value)) return `{${Object.keys(value).length} keys}`;
	const text = String(value);
	return options.sanitizeText?.(text) ?? text;
}

export function formatArgsInline(
	args: Record<string, unknown>,
	maxWidth: number,
	options: InlineFormatOptions = {},
): string {
	if (options.characterBudget) {
		const pairs: string[] = [];
		let length = 0;
		for (const key in args) {
			if (!Object.hasOwn(args, key)) continue;
			const pair = `${options.sanitizeText?.(key) ?? key}=${formatScalar(args[key], 24, options)}`;
			const added = pair.length + (pairs.length > 0 ? 2 : 0);
			if (length + added > maxWidth && pairs.length > 0) {
				pairs.push("…");
				break;
			}
			pairs.push(pair);
			length += added;
		}
		return pairs.join(", ");
	}
	const keys: string[] = [];
	for (const key in args) if (!(key in HIDDEN_ARG_KEYS)) keys.push(key);
	let result = "";
	let width = 0;
	for (let index = 0; index < keys.length; index++) {
		const rawKey = keys[index]!;
		const key = options.sanitizeText?.(rawKey) ?? rawKey;
		const separator = width > 0 ? ARGS_INLINE_PAIR_SEP : "";
		const separatorWidth = width > 0 ? ARGS_INLINE_PAIR_SEP_WIDTH : 0;
		const current = width + separatorWidth;
		const cap = maxWidth - current - ARGS_INLINE_MORE_WIDTH;
		if (cap <= 0) return `${result}${ARGS_INLINE_MORE}`;
		let tailReserve = 0;
		for (let tail = index + 1; tail < keys.length; tail++) {
			const tailKey = options.sanitizeText?.(keys[tail]!) ?? keys[tail]!;
			tailReserve += ARGS_INLINE_PAIR_SEP_WIDTH + Bun.stringWidth(tailKey) + 1 + ARGS_INLINE_TAIL_VALUE_RESERVE;
		}
		const pieceBudget = Math.min(cap, maxWidth - current - tailReserve);
		const valueMaxLen = Math.max(1, pieceBudget - Bun.stringWidth(key) - 3);
		const piece = `${key}=${formatScalar(args[rawKey], valueMaxLen, options)}`;
		const pieceWidth = Bun.stringWidth(piece);
		if (pieceWidth > pieceBudget) return `${result}${separator}${truncateInline(piece, cap)}`;
		result += separator + piece;
		width = current + pieceWidth;
	}
	return result;
}

const OUTPUT_INLINE_OPTIONS: InlineFormatOptions = { sanitizeText, multilineSummary: true, characterBudget: true };

export function formatOutputInline(data: unknown, maxWidth = 80): string {
	const options = OUTPUT_INLINE_OPTIONS;
	if (data === null || data === undefined) return "Output: none";
	if (typeof data !== "object") return `Output: ${formatScalar(data, 60, options)}`;
	if (Array.isArray(data)) {
		if (data.length === 0) return "Output: []";
		return `Output: [${data.length} items] ${formatScalar(data[0], 40, options)}${data.length > 1 ? "…" : ""}`;
	}
	return `Output: ${formatArgsInline(data as Record<string, unknown>, maxWidth - "Output: ".length, options) || "{}"}`;
}

export interface JsonTreeRenderOptions {
	readonly maxDepth: number;
	readonly maxLines: number;
	readonly maxScalarLen: number;
	readonly sanitizeText?: JsonTextSanitizer;
	readonly hiddenRootKeys?: readonly string[];
	readonly multilineStrings?: boolean;
	readonly escapeStringWhitespace?: boolean;
	readonly rootConnectors?: "hooked" | "siblings";
}
