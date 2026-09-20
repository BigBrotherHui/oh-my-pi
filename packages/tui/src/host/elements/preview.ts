import { sanitizeText } from "@oh-my-pi/pi-utils";
import { Ellipsis } from "@oh-my-pi/pi-natives";
import { Clip, Wrap, pipe } from "../../core/out";
import { type Out, RichText, RunFlag } from "../../core/richtext";
import { Style } from "../../core/style";
import { parseAnsiRow } from "../../core/ansi";
import { replayCells } from "../../core/frame";
import type { TextDocument } from "../../document/types";
import {
	containsSixelSequence,
	hasCompleteSixelPayload,
	getSixelLineMask,
	isSixelPassthroughEnabled,
} from "../../render/sixel";
import type { StyleProps } from "../../style/types";
import { replaceTabs } from "../../utils";
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

/** Unit counted and reported by a bounded preview. */
export type PreviewUnit = "rows" | "lines" | "items";

/** Props for a head/tail preview whose summary uses the same declared unit. */
export interface PreviewProps extends LayoutProps, StyleProps {
	readonly document?: TextDocument;
	readonly items?: readonly string[];
	readonly groups?: readonly (readonly string[])[];
	readonly edge?: "head" | "tail";
	/** Total body-row budget; see {@link reserveSummary}. */
	readonly limit: number;
	readonly unit: PreviewUnit;
	/** Parse styling SGR sequences while dropping cursor-moving terminal controls. */
	readonly ansi?: boolean;
	/** Preserve complete SIXEL payloads only when the terminal safety gates allow it. */
	readonly preserveSixel?: boolean;
	/** Cap only plain or ANSI-styled external text lines; raw SIXEL/Kitty payloads remain unchanged. */
	readonly maxLineCells?: number;
	/** Wrap the hidden-item summary instead of clipping it at the available width. */
	readonly summaryWrap?: boolean;
	/** Remove terminal trailing whitespace and blank rows before capping. */
	readonly trimEnd?: boolean;
	/** Inclusive/exclusive document line bounds, applied before trim and capping. */
	readonly startLine?: number;
	readonly endLine?: number;
	/**
	 * True keeps the historical total-row budget (the summary consumes one row).
	 * False caps body rows first, then prepends/appends the summary.
	 */
	readonly reserveSummary?: boolean;
	readonly hiddenLabel?: (hidden: number, unit: PreviewUnit, shown: number, total: number) => string;
}

interface PreviewProjection {
	unit: PreviewUnit;
	document?: TextDocument;
	version?: number;
	items?: readonly string[];
	groups?: readonly (readonly string[])[];
	width: number;
	startLine?: number;
	endLine?: number;
	ansi: boolean;
	preserveSixel: boolean;
	maxLineCells?: number;
	trimEnd: boolean;
	logical: RichText;
	visual: RichText;
	sixelUncapped: boolean;
}

interface PreviewState {
	document?: TextDocument;
	context?: HostContext;
	unsubscribe?: () => void;
	projection?: PreviewProjection;
}

function propsOf(node: HostElement): PreviewProps {
	return node.props as unknown as PreviewProps;
}

function stateOf(node: HostElement): PreviewState {
	let state = node.state as PreviewState | undefined;
	if (state === undefined) {
		state = {};
		node.state = state;
	}
	return state;
}

function bindDocument(node: HostElement, document: TextDocument | undefined): void {
	const state = stateOf(node);
	if (state.document === document) return;
	state.unsubscribe?.();
	state.document = document;
	state.projection = undefined;
	state.unsubscribe =
		document === undefined || state.context === undefined
			? undefined
			: document.subscribe(() => state.context?.invalidate(node, Damage.Layout));
}

function itemCount(props: PreviewProps): number {
	if (props.groups !== undefined) {
		let total = 0;
		for (const group of props.groups) total += group.length;
		return total;
	}
	return props.items?.length ?? 0;
}

function collectItems(props: PreviewProps, count: number, edge: "head" | "tail"): string[] {
	const groups = props.groups ?? (props.items === undefined ? [] : [props.items]);
	const result: string[] = [];
	if (edge === "head") {
		for (const group of groups) {
			for (const item of group) {
				if (result.length >= count) return result;
				result.push(item);
			}
		}
		return result;
	}
	for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex--) {
		const group = groups[groupIndex]!;
		for (let itemIndex = group.length - 1; itemIndex >= 0; itemIndex--) {
			if (result.length >= count) {
				result.reverse();
				return result;
			}
			result.push(group[itemIndex]!);
		}
	}
	result.reverse();
	return result;
}

function clampLine(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(maximum, Math.trunc(value)));
}

function sourceLines(props: PreviewProps): { lines: string[]; version?: number } {
	const document = props.document;
	if (document === undefined) {
		const lines = collectItems(props, itemCount(props), "head");
		if (!props.trimEnd) return { lines };
		let end = lines.length;
		while (end > 0 && lines[end - 1]!.trimEnd().length === 0) end--;
		if (end > 0) lines[end - 1] = lines[end - 1]!.trimEnd();
		lines.length = end;
		return { lines };
	}

	const count = document.lineCount();
	const start = clampLine(props.startLine, 0, count);
	let end = clampLine(props.endLine, count, count);
	if (end < start) end = start;
	if (props.trimEnd) {
		while (end > start && document.line(end - 1).trimEnd().length === 0) end--;
	}
	const lines = new Array<string>(end - start);
	for (let line = start; line < end; line++) {
		const text = document.line(line);
		lines[line - start] = props.trimEnd && line === end - 1 ? text.trimEnd() : text;
	}
	return { lines, version: document.version() };
}

function csiEnd(line: string, start: number): number {
	for (let index = start; index < line.length; index++) {
		const code = line.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) return index + 1;
	}
	return line.length;
}

function controlEnd(line: string, start: number, allowBell: boolean): number {
	for (let index = start; index < line.length; index++) {
		const code = line.charCodeAt(index);
		if (allowBell && code === 0x07) return index + 1;
		if (code === 0x1b && line.charCodeAt(index + 1) === 0x5c) return index + 2;
	}
	return line.length;
}

/** A bare carriage return overwrites the current terminal row; only its final segment remains visible. */
function collapseCarriageReturn(line: string): string {
	const index = line.lastIndexOf("\r");
	return index < 0 ? line : line.slice(index + 1);
}

/** Retain SGR only; all cursor and clipboard-like controls are removed before parsing. */
function sanitizeAnsiLine(line: string): string {
	line = collapseCarriageReturn(line);
	if (!line.includes("\x1b")) return replaceTabs(sanitizeText(line));
	let output = "";
	let plainStart = 0;
	let index = 0;
	while (index < line.length) {
		if (line.charCodeAt(index) !== 0x1b) {
			index++;
			continue;
		}
		output += replaceTabs(sanitizeText(line.slice(plainStart, index)));
		const kind = line.charCodeAt(index + 1);
		let end = Math.min(index + 2, line.length);
		if (kind === 0x5b) {
			end = csiEnd(line, index + 2);
			if (end > index + 2 && line.charCodeAt(end - 1) === 0x6d) output += line.slice(index, end);
		} else if (kind === 0x5d || kind === 0x5f || kind === 0x50 || kind === 0x5e) {
			end = controlEnd(line, index + 2, kind !== 0x50);
		}
		index = end;
		plainStart = end;
	}
	return output + replaceTabs(sanitizeText(line.slice(plainStart)));
}

function emitSourceRow(
	out: Out,
	line: string,
	ansi: boolean,
	preserveSixel: boolean,
	sixelLine: boolean,
	maxLineCells: number | undefined,
): void {
	if (preserveSixel && sixelLine) {
		out.raw(Style.NONE, line, 0, RunFlag.Raw | RunFlag.Image);
		out.br();
		return;
	}
	if (maxLineCells === undefined) {
		if (ansi) parseAnsiRow(sanitizeAnsiLine(line), out);
		else out.push(Style.NONE, replaceTabs(sanitizeText(collapseCarriageReturn(line))));
		out.br();
		return;
	}
	const source = new RichText();
	if (ansi) parseAnsiRow(sanitizeAnsiLine(line), source);
	else source.push(Style.NONE, replaceTabs(sanitizeText(collapseCarriageReturn(line))));
	source.br();
	source.finish();
	const cap = maxLineCells === undefined ? undefined : Math.max(0, Math.trunc(maxLineCells));
	const width = source.rowWidth[0] ?? 0;
	if (cap === undefined || width <= cap) {
		replayRow(source, out, 0, Style.NONE);
		return;
	}
	replayCells(out, source, 0, 0, cap);
	out.push(Style.NONE, `… [${width - cap} visible columns omitted]`);
	out.br();
}

function replayRow(source: RichText, out: Out, row: number, base: Style): void {
	const end = source.rowEnd[row]!;
	for (let run = source.rowStart(row); run < end; run++) {
		const flags = source.flags[run]!;
		const style = source.style[run]!;
		if (flags === RunFlag.None) out.push(style.over(base), source.text[run]!);
		else if (flags & RunFlag.Cursor) out.cursor();
		else if (flags & RunFlag.Image) out.raw(style, source.text[run]!, source.width[run]!, flags);
		else out.raw(style.over(base), source.text[run]!, source.width[run]!, flags);
	}
	out.br();
}

function projection(node: HostElement, props: PreviewProps, width: number): PreviewProjection {
	const state = stateOf(node);
	const boundedWidth = Math.max(1, Math.trunc(width));
	const ansi = props.ansi === true;
	const preserveSixel = props.preserveSixel === true && isSixelPassthroughEnabled();
	const version = props.document?.version();
	const cached = state.projection;
	if (
		cached !== undefined &&
		cached.unit === props.unit &&
		cached.document === props.document &&
		cached.version === version &&
		cached.items === props.items &&
		cached.groups === props.groups &&
		cached.width === boundedWidth &&
		cached.startLine === props.startLine &&
		cached.endLine === props.endLine &&
		cached.ansi === ansi &&
		cached.preserveSixel === preserveSixel &&
		cached.maxLineCells === props.maxLineCells &&
		cached.trimEnd === (props.trimEnd === true)
	) {
		return cached;
	}

	const source = sourceLines(props);
	const mask = getSixelLineMask(source.lines);
	const sixelUncapped = preserveSixel && hasCompleteSixelPayload(source.lines);
	const logical = new RichText();
	for (let line = 0; line < source.lines.length; line++) {
		const sourceLine = source.lines[line]!;
		if (mask[line] && !sixelUncapped && !containsSixelSequence(sourceLine)) continue;
		emitSourceRow(logical, sourceLine, ansi, sixelUncapped, mask[line] === true, props.maxLineCells);
	}
	logical.finish();

	const visual = props.unit === "rows" ? new RichText() : logical;
	if (visual !== logical) {
		for (let row = 0; row < logical.rows; row++) {
			pipe(new Wrap(visual, boundedWidth), out => replayRow(logical, out, row, Style.NONE));
		}
		visual.finish();
	}

	const next: PreviewProjection = {
		unit: props.unit,
		document: props.document,
		version: source.version,
		items: props.items,
		groups: props.groups,
		width: boundedWidth,
		startLine: props.startLine,
		endLine: props.endLine,
		ansi,
		preserveSixel,
		maxLineCells: props.maxLineCells,
		trimEnd: props.trimEnd === true,
		logical,
		visual,
		sixelUncapped,
	};
	state.projection = next;
	return next;
}

function summary(hidden: number, props: PreviewProps, shown: number, total: number): string {
	if (props.hiddenLabel !== undefined) return sanitizeText(props.hiddenLabel(hidden, props.unit, shown, total));
	const noun = hidden === 1 ? props.unit.slice(0, -1) : props.unit;
	return props.edge === "tail" ? `… ${hidden} earlier ${noun}` : `… ${hidden} more ${noun}`;
}

function paintSummary(
	node: HostElement,
	out: Out,
	hidden: number,
	shown: number,
	total: number,
	props: PreviewProps,
	ctx: PaintContext,
	width: number,
): void {
	const style = ctx.theme.style("dim").over(ctx.styleOf(node));
	const text = summary(hidden, props, shown, total);
	if (props.summaryWrap !== true) {
		out.push(style, text);
		out.br();
		return;
	}
	pipe(new Wrap(out, Math.max(1, Math.trunc(width))), sink => {
		sink.push(style, text);
		sink.br();
	});
}

function paintProjected(
	node: HostElement,
	out: Out,
	props: PreviewProps,
	ctx: PaintContext,
	projection: PreviewProjection,
	rows: RichText,
	width: number,
): void {
	const edge = props.edge ?? "head";
	const total = rows.rows;
	const limit = Math.max(0, Math.trunc(props.limit));
	const uncapped = projection.sixelUncapped;
	const truncated = !uncapped && total > limit;
	const reserveSummary = props.reserveSummary ?? true;
	const shown = truncated ? Math.max(0, limit - (reserveSummary ? 1 : 0)) : total;
	const hidden = total - shown;
	const start = edge === "head" ? 0 : total - shown;
	const base = ctx.styleOf(node);
	if (hidden > 0 && edge === "tail" && (limit > 0 || !reserveSummary)) {
		paintSummary(node, out, hidden, shown, total, props, ctx, width);
	}
	for (let row = start; row < start + shown; row++) {
		if (props.unit === "lines") {
			pipe(new Clip(out, Math.max(0, Math.trunc(width)), Ellipsis.Omit), sink => replayRow(rows, sink, row, base));
		} else replayRow(rows, out, row, base);
	}
	if (hidden > 0 && edge === "head" && (limit > 0 || !reserveSummary)) {
		paintSummary(node, out, hidden, shown, total, props, ctx, width);
	}
}

function paintPreview(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = propsOf(node);
	bindDocument(node, props.document);
	const cached = projection(node, props, width);
	const rows = props.unit === "rows" ? cached.visual : cached.logical;
	paintProjected(node, out, props, ctx, cached, rows, width);
}

/** Retained implementation of the `preview` intrinsic. */
export const previewElement: ElementImpl = {
	tag: "preview",
	propDamage(name) {
		if (name === "color" || name === "background" || name === "style" || name === "recipe") return Damage.Paint;
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
		state.projection = undefined;
	},
	paint: paintPreview,
};

registerElement(previewElement);
