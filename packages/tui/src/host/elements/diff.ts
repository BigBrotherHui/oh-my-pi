import { diffWords } from "@oh-my-pi/pi-natives";
import { DEFAULT_TAB_WIDTH, sanitizeText } from "@oh-my-pi/pi-utils";
import { Clip, Indent, Wrap, pipe, spaces } from "../../core/out";
import { cellWidth, type Out } from "../../core/richtext";
import { Attr, Style } from "../../core/style";
import { highlightTextLines, type HighlightedDocumentLine } from "../../document/highlight";
import type { TextDocument } from "../../document/types";
import { getLanguageFromPath } from "../../lang-from-path";
import { resolveSyntaxRole } from "../../style/resolve";
import type { StyleProps } from "../../style/types";
import { replaceTabs } from "../../render/render-utils";
import { registerElement } from "../registry";
import {
	Damage,
	type ElementImpl,
	type HostContext,
	type HostElement,
	type LayoutProps,
	type PaintContext,
} from "../types";
import { textPropDamage } from "./text";

/** Props for a retained unified-diff document. */
export interface DiffProps extends LayoutProps, StyleProps {
	readonly document: TextDocument;
	readonly filePath?: string;
	readonly wrap?: boolean;
	/** Optional base style for unchanged/context lines. */
	readonly contextStyle?: Style;
}

type DiffMarker = "+" | "-" | " ";

interface ParsedDiffLine {
	prefix: DiffMarker;
	lineNumber: string;
	content: string;
}

interface DiffPiece {
	text: string;
}

interface DiffProjection {
	version: number;
	filePath?: string;
	lines: readonly string[];
	parsed: readonly (ParsedDiffLine | null)[];
	highlights: ReadonlyMap<number, HighlightedDocumentLine>;
}

interface DiffState {
	document?: TextDocument;
	context?: HostContext;
	unsubscribe?: () => void;
	projection?: DiffProjection;
}

function propsOf(node: HostElement): DiffProps {
	return node.props as unknown as DiffProps;
}

function stateOf(node: HostElement): DiffState {
	let state = node.state as DiffState | undefined;
	if (state === undefined) {
		state = {};
		node.state = state;
	}
	return state;
}

function bindDocument(node: HostElement, document: TextDocument): void {
	const state = stateOf(node);
	if (state.document === document) return;
	state.unsubscribe?.();
	state.document = document;
	state.projection = undefined;
	state.unsubscribe =
		state.context === undefined
			? undefined
			: document.subscribe(() => {
					state.projection = undefined;
					state.context?.invalidate(node, Damage.Layout);
				});
}

function parseDiffLine(line: string): ParsedDiffLine | null {
	const canonical = /^([+\- ])(\s*\d+)\|(.*)$/u.exec(line);
	if (canonical !== null) {
		return {
			prefix: canonical[1] as DiffMarker,
			lineNumber: canonical[2] ?? "",
			content: canonical[3] ?? "",
		};
	}
	const legacy = /^([+\- ])(?:(\s*\d+)\s)?(.*)$/u.exec(line);
	if (legacy === null) return null;
	return {
		prefix: legacy[1] as DiffMarker,
		lineNumber: legacy[2] ?? "",
		content: legacy[3] ?? "",
	};
}

/** Preserve native word-diff whitespace normalization in paired replacement rows. */
function intraLinePieces(oldContent: string, newContent: string): { removed: DiffPiece[]; added: DiffPiece[] } {
	const removed: DiffPiece[] = [];
	const added: DiffPiece[] = [];
	let firstRemoved = true;
	let firstAdded = true;
	for (const part of diffWords(oldContent, newContent)) {
		if (part.removed) {
			let value = part.value;
			if (firstRemoved) {
				const leading = /^(\s*)/u.exec(value)?.[1] ?? "";
				if (leading.length > 0) removed.push({ text: leading });
				value = value.slice(leading.length);
				firstRemoved = false;
			}
			if (value.length > 0) removed.push({ text: value });
		} else if (part.added) {
			let value = part.value;
			if (firstAdded) {
				const leading = /^(\s*)/u.exec(value)?.[1] ?? "";
				if (leading.length > 0) added.push({ text: leading });
				value = value.slice(leading.length);
				firstAdded = false;
			}
			if (value.length > 0) added.push({ text: value });
		} else {
			removed.push({ text: part.value });
			added.push({ text: part.value });
		}
	}
	return { removed, added };
}

function buildProjection(props: DiffProps): DiffProjection {
	const lineCount = props.document.lineCount();
	const lines = new Array<string>(lineCount);
	const parsed = new Array<ParsedDiffLine | null>(lineCount);
	for (let index = 0; index < lineCount; index++) {
		const line = sanitizeText(props.document.line(index));
		lines[index] = line;
		parsed[index] = parseDiffLine(line);
	}
	const highlights = new Map<number, HighlightedDocumentLine>();
	const language = props.filePath === undefined ? undefined : getLanguageFromPath(props.filePath);
	if (language !== undefined) {
		let indices: number[] = [];
		let contents: string[] = [];
		const flush = (): void => {
			if (contents.length === 0) return;
			const highlighted = highlightTextLines(contents, language);
			for (let index = 0; index < indices.length; index++) highlights.set(indices[index]!, highlighted[index]!);
			indices = [];
			contents = [];
		};
		for (let index = 0; index < parsed.length; index++) {
			const item = parsed[index];
			const collapsed = item?.prefix === " " && (item.content === "..." || item.content === "…");
			if (item?.prefix === " " && !collapsed) {
				indices.push(index);
				contents.push(item.content);
			} else flush();
		}
		flush();
	}
	return { version: props.document.version(), filePath: props.filePath, lines, parsed, highlights };
}

function projection(node: HostElement, props: DiffProps): DiffProjection {
	const state = stateOf(node);
	const cached = state.projection;
	const version = props.document.version();
	if (cached !== undefined && cached.version === version && cached.filePath === props.filePath) return cached;
	const next = buildProjection(props);
	state.projection = next;
	return next;
}

function gutter(prefix: DiffMarker, lineNumber: string, width: number, previous: { value: string }): string {
	if (lineNumber.trim().length === 0) {
		previous.value = "";
		return prefix;
	}
	const trimmed = lineNumber.trim();
	const display = trimmed === previous.value ? "" : trimmed;
	previous.value = trimmed;
	const marker = prefix.trim();
	const value = marker.length > 0 && display.length > 0 ? `${marker}${display}` : display || marker;
	return value.padStart(width + 1, " ");
}

function continuation(first: string): string {
	return first.length <= 1 ? "" : spaces(cellWidth(first));
}

function paintPieces(out: Out, pieces: readonly DiffPiece[], base: Style): void {
	let leading = true;
	const dim = base.plus(Attr.Dim);
	const left = Math.floor(DEFAULT_TAB_WIDTH / 2);
	const tab = `${" ".repeat(left)}→${" ".repeat(Math.max(0, DEFAULT_TAB_WIDTH - left - 1))}`;
	for (const piece of pieces) {
		let start = 0;
		if (leading) {
			while (start < piece.text.length) {
				const character = piece.text[start];
				if (character === " ") out.push(dim, "·");
				else if (character === "\t") out.push(dim, tab);
				else break;
				start++;
			}
			if (start < piece.text.length) leading = false;
		}
		if (start < piece.text.length) out.push(base, replaceTabs(piece.text.slice(start)));
	}
}

function paintHighlighted(out: Out, line: HighlightedDocumentLine, base: Style, ctx: PaintContext): void {
	const syntaxBase = line.roles.some(range => range.role !== "text") ? base.withFg(Style.NONE.fg) : base;
	let offset = 0;
	for (const range of line.roles) {
		if (range.start > offset) out.push(base, line.text.slice(offset, range.start));
		const style = range.role === "text" ? syntaxBase : resolveSyntaxRole(ctx.theme, range.role).over(syntaxBase);
		out.push(style, line.text.slice(range.start, range.end));
		offset = range.end;
	}
	if (offset < line.text.length) out.push(base, line.text.slice(offset));
}

function paintGutterRow(
	out: Out,
	width: number,
	wrap: boolean,
	first: string,
	style: Style,
	paint: (sink: Out) => void,
): void {
	if (wrap) {
		if (first.length <= 1) {
			pipe(new Wrap(out, Math.max(1, width)), sink => {
				sink.push(style, first);
				paint(sink);
				sink.br();
			});
			return;
		}
		pipe(
			new Wrap(new Indent(out, [style, first], [style, continuation(first)]), Math.max(1, width - cellWidth(first))),
			sink => {
				paint(sink);
				sink.br();
			},
		);
		return;
	}
	pipe(new Clip(out, Math.max(0, width)), sink => {
		sink.push(style, first);
		paint(sink);
		sink.br();
	});
}

function paintDiff(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = propsOf(node);
	bindDocument(node, props.document);
	const projected = projection(node, props);
	const base = ctx.styleOf(node);
	const contextStyle = (props.contextStyle ?? ctx.theme.style("toolDiffContext")).over(base);
	const removedStyle = ctx.theme.style("toolDiffRemoved").over(base);
	const addedStyle = ctx.theme.style("toolDiffAdded").over(base);
	const wrap = props.wrap !== false;
	const numberWidth = projected.parsed.reduce(
		(maximum, line) => Math.max(maximum, line?.lineNumber.trim().length ?? 0),
		3,
	);
	const previous = { value: "" };
	let index = 0;
	while (index < projected.lines.length) {
		const item = projected.parsed[index];
		if (item === null) {
			previous.value = "";
			const line = projected.lines[index]!;
			pipe(wrap ? new Wrap(out, Math.max(1, width)) : new Clip(out, Math.max(0, width)), sink => {
				sink.push(contextStyle, line.trim().length === 0 || line.trim() === "..." ? "…" : replaceTabs(line));
				sink.br();
			});
			index++;
			continue;
		}
		if (item.prefix === "-") {
			const removed: ParsedDiffLine[] = [];
			while (index < projected.lines.length && projected.parsed[index]?.prefix === "-")
				removed.push(projected.parsed[index++]!);
			const added: ParsedDiffLine[] = [];
			while (index < projected.lines.length && projected.parsed[index]?.prefix === "+")
				added.push(projected.parsed[index++]!);
			if (removed.length === 1 && added.length === 1) {
				const pieces = intraLinePieces(replaceTabs(removed[0]!.content), replaceTabs(added[0]!.content));
				const removedGutter = gutter("-", removed[0]!.lineNumber, numberWidth, previous);
				paintGutterRow(out, width, wrap, removedGutter, removedStyle, sink =>
					paintPieces(sink, pieces.removed, removedStyle),
				);
				const addedGutter = gutter("+", added[0]!.lineNumber, numberWidth, previous);
				paintGutterRow(out, width, wrap, addedGutter, addedStyle, sink =>
					paintPieces(sink, pieces.added, addedStyle),
				);
			} else {
				for (const row of removed) {
					const first = gutter("-", row.lineNumber, numberWidth, previous);
					paintGutterRow(out, width, wrap, first, removedStyle, sink =>
						paintPieces(sink, [{ text: row.content }], removedStyle),
					);
				}
				for (const row of added) {
					const first = gutter("+", row.lineNumber, numberWidth, previous);
					paintGutterRow(out, width, wrap, first, addedStyle, sink =>
						paintPieces(sink, [{ text: row.content }], addedStyle),
					);
				}
			}
			continue;
		}
		const first = gutter(item.prefix, item.lineNumber, numberWidth, previous);
		const highlighted = projected.highlights.get(index);
		const style = item.prefix === "+" ? addedStyle : contextStyle;
		paintGutterRow(out, width, wrap, first, style, sink => {
			if (highlighted === undefined) paintPieces(sink, [{ text: item.content }], style);
			else paintHighlighted(sink, highlighted, style, ctx);
		});
		index++;
	}
}

/** Retained implementation of the `diff` intrinsic. */
export const diffElement: ElementImpl = {
	tag: "diff",
	propDamage(name) {
		if (name === "contextStyle" || name === "filePath") return Damage.Paint;
		if (name === "document" || name === "wrap") return Damage.Layout;
		return textPropDamage(name);
	},
	onAttach(node, context) {
		const state = stateOf(node);
		state.context = context;
		bindDocument(node, propsOf(node).document);
	},
	onDetach(node) {
		const state = stateOf(node);
		state.unsubscribe?.();
		state.unsubscribe = undefined;
		state.context = undefined;
	},
	paint: paintDiff,
};

registerElement(diffElement);
