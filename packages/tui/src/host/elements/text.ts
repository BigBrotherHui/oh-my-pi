import { Ellipsis } from "@oh-my-pi/pi-natives";
import type { JSX } from "solid-js";
import { Clip, Pad, Wrap, over, pipe, skipCells, spaces, takeCells } from "../../core/out";
import { type Out, RichText, RunFlag, cellWidth } from "../../core/richtext";
import { Style } from "../../core/style";
import type { StyleProps } from "../../style/types";
import type { ThemeColor } from "../../theme/schema";
import { INTRINSIC_WIDTH, Damage, type ElementImpl, type HostElement, type PaintContext } from "../types";
import { registerElement } from "../registry";

/** Props for styled text layout and overflow. */
export interface TextProps extends StyleProps {
	readonly children?: JSX.Element;
	/** Native styled rows supplied by internal chrome; never stringify them or round-trip through ANSI. */
	readonly runs?: RichText;
	readonly wrap?: "word" | "none" | "clip" | "overflow";
	readonly overflow?: "clip" | "ellipsis" | "middle";
	readonly ellipsis?: Ellipsis;
	/** Semantic foreground for an overflow marker that belongs to the displayed content. */
	readonly ellipsisColor?: ThemeColor;
	/** Explicit overflow chrome style; RESET prevents enclosing card tints from filling it. */
	readonly ellipsisStyle?: Style;
	/**
	 * Retained prefix and suffix slots for native inline fitting. The suffix retains
	 * its natural flow while the prefix is clipped to the allocation left for it.
	 */
	readonly fit?: "prefix";
	/** Structural inline lead that participates in final flow but not prefix fitting. */
	readonly leading?: JSX.Element;
	readonly prefix?: JSX.Element;
	readonly suffix?: JSX.Element;
	/** Semantic floor for a fitted prefix before the suffix naturally wraps. */
	readonly fitMinWidth?: number;
	readonly pad?: boolean;
	readonly align?: "left" | "center" | "right";
}

const PAINT_PROPS: Readonly<Record<string, true>> = {
	color: true,
	background: true,
	bold: true,
	dim: true,
	italic: true,
	underline: true,
	undercurl: true,
	strike: true,
	inverse: true,
	blink: true,
	recipe: true,
	style: true,
};

/** Classify the shared text/style props for retained-host invalidation. */
export function textPropDamage(name: string): Damage {
	if (name === "link" || name === "href" || name === "target") return Damage.Link;
	if (PAINT_PROPS[name]) return Damage.Paint;
	return Damage.Layout;
}

function replayRun(out: Out, source: RichText, index: number, text: string, width: number): void {
	const flags = source.flags[index]!;
	const style = source.style[index]!;
	if (flags === RunFlag.None) out.push(style, text);
	else if (flags & RunFlag.Cursor) out.cursor();
	else out.raw(style, text, width, flags);
}

function replayCellRange(source: RichText, out: Out, row: number, from: number, count: number): void {
	if (count <= 0) return;
	const until = from + count;
	let cell = 0;
	const end = source.rowEnd[row]!;
	for (let index = source.rowStart(row); index < end && cell < until; index++) {
		const runWidth = source.width[index]!;
		const runEnd = cell + runWidth;
		if (runEnd <= from) {
			cell = runEnd;
			continue;
		}
		const flags = source.flags[index]!;
		if (flags & RunFlag.Cursor) {
			if (cell >= from && cell <= until) out.cursor();
			continue;
		}
		const localStart = Math.max(0, from - cell);
		const localCount = Math.min(runWidth - localStart, until - Math.max(cell, from));
		if (localCount > 0) {
			if (flags === RunFlag.None) {
				const selected = skipCells(source.text[index]!, localStart);
				const text = takeCells(selected, localCount);
				replayRun(out, source, index, text, cellWidth(text));
			} else if (localStart === 0 && localCount === runWidth) {
				replayRun(out, source, index, source.text[index]!, runWidth);
			}
		}
		cell = runEnd;
	}
}

function replayMiddle(source: RichText, out: Out, width: number, pad: boolean, fill: Style): void {
	const ellipsis = "…";
	for (let row = 0; row < source.rows; row++) {
		const total = source.rowWidth[row]!;
		if (total <= width) {
			source.replayRow(out, row);
			if (pad && total < width) out.push(fill, spaces(width - total));
			out.br();
			continue;
		}
		if (width > 0) {
			const content = Math.max(0, width - 1);
			const left = Math.ceil(content / 2);
			const right = content - left;
			replayCellRange(source, out, row, 0, left);
			out.push(Style.NONE, ellipsis);
			replayCellRange(source, out, row, total - right, right);
		}
		out.br();
	}
}

const textSource = Symbol("text.source");
const fitSource = Symbol("text.fitSource");

interface FitSource {
	readonly leading: RichText;
	readonly prefix: RichText;
	readonly suffix: RichText;
	readonly clipped: RichText;
	readonly composed: RichText;
}

declare module "../types" {
	interface HostElement {
		[textSource]?: RichText;
		[fitSource]?: FitSource;
	}
}

function fitState(node: HostElement): FitSource {
	if (node[fitSource] === undefined) {
		node[fitSource] = {
			leading: new RichText(),
			prefix: new RichText(),
			suffix: new RichText(),
			clipped: new RichText(),
			composed: new RichText(),
		};
	}
	return node[fitSource];
}

function paintSlotInline(
	node: HostElement,
	name: "leading" | "prefix" | "suffix",
	out: Out,
	base: Style,
	ctx: PaintContext,
): void {
	for (const child of node.slots.get(name) ?? []) ctx.paintInlineChild(child, out, base);
}

function fitPrefixSource(node: HostElement, width: number, style: Style, ctx: PaintContext): RichText {
	const props = node.props as TextProps;
	const state = fitState(node);
	state.leading.clear();
	paintSlotInline(node, "leading", state.leading, style, ctx);
	state.leading.br();
	state.leading.finish();
	state.prefix.clear();
	paintSlotInline(node, "prefix", state.prefix, style, ctx);
	state.prefix.br();
	state.prefix.finish();
	state.suffix.clear();
	paintSlotInline(node, "suffix", state.suffix, style, ctx);
	state.suffix.br();
	state.suffix.finish();

	const leadingWidth = state.leading.rowWidth[0] ?? 0;
	const suffixWidth = state.suffix.rowWidth[0] ?? 0;
	const leadingGap = /^ +/.exec(state.suffix.rowText(0))?.[0].length ?? 0;
	const semanticMinimum = Math.max(0, Math.trunc(props.fitMinWidth ?? 0));
	const prefixWidth = Math.max(
		semanticMinimum,
		Math.max(0, Math.trunc(width)) - leadingWidth - suffixWidth + leadingGap,
	);
	state.clipped.clear();
	const clip = new Clip(state.clipped, prefixWidth, props.ellipsis ?? Ellipsis.Unicode);
	clip.preserveEllipsisLink = true;
	if (props.ellipsisStyle) clip.ellipsisStyle = props.ellipsisStyle;
	else if (props.ellipsisColor) clip.ellipsisStyle = ctx.theme.style(props.ellipsisColor);
	pipe(clip, target => state.prefix.replay(target));
	state.clipped.finish();

	state.composed.clear();
	if (state.leading.rows > 0) state.leading.replayRow(state.composed, 0);
	if (state.clipped.rows > 0) state.clipped.replayRow(state.composed, 0);
	if (state.suffix.rows > 0) state.suffix.replayRow(state.composed, 0);
	state.composed.br();
	state.composed.finish();
	return state.composed;
}

function paintText(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = node.props as TextProps;
	const style = ctx.styleOf(node);
	const safeWidth = Math.max(0, Math.trunc(width));
	const mode = props.wrap ?? "word";
	const overflow = props.overflow ?? (mode === "clip" ? "ellipsis" : "clip");
	let source = props.runs;
	if (!source) {
		source =
			props.fit === "prefix" ? fitPrefixSource(node, safeWidth, style, ctx) : (node[textSource] ??= new RichText());
		if (props.fit !== "prefix") {
			source.clear();
			ctx.paintInlineChildren(node, source, style);
			source.br();
			source.finish();
		}
	}
	let intrinsicWidth = 0;
	for (const rowWidth of source.rowWidth) intrinsicWidth = Math.max(intrinsicWidth, rowWidth);
	node[INTRINSIC_WIDTH] = intrinsicWidth;
	if (mode !== "word" && mode !== "overflow" && overflow === "middle") {
		replayMiddle(source, out, safeWidth, props.pad === true, style);
		return;
	}

	let sink: Out = out;
	if (props.pad || props.align !== undefined) sink = new Pad(sink, safeWidth, style, props.align ?? "left");
	if (mode === "word") {
		sink = new Wrap(sink, safeWidth);
	} else if (mode !== "overflow" && overflow === "ellipsis") {
		const clip = new Clip(sink, safeWidth, props.ellipsis ?? Ellipsis.Unicode);
		if (props.ellipsisStyle) clip.ellipsisStyle = props.ellipsisStyle;
		else if (props.ellipsisColor) clip.ellipsisStyle = ctx.theme.style(props.ellipsisColor);
		sink = clip;
	} else if (mode !== "overflow") {
		sink = new Clip(sink, safeWidth, Ellipsis.Omit);
	}
	pipe(sink, target => source.replay(target));
}

function paintTextInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	const style = ctx.styleOf(node).over(base);
	const runs = node.props.runs;
	if (runs instanceof RichText) runs.replay(over(out, style));
	else ctx.paintInlineChildren(node, out, style);
}

/** Retained implementation of the `text` intrinsic. */
export const textElement: ElementImpl = {
	tag: "text",
	inline: true,
	slots: ["leading", "prefix", "suffix"],
	propDamage: textPropDamage,
	paint: paintText,
	paintInline: paintTextInline,
};

registerElement(textElement);
