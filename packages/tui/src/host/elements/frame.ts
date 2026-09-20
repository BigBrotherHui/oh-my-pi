import { Ellipsis } from "@oh-my-pi/pi-natives";
import type { JSX } from "solid-js";
import { LayoutRowFitter } from "../../components/layout/geometry";
import { Clip, over, pipe, skipCells, spaces, takeCells } from "../../core/out";
import { type Out, RichText, RunFlag, cellWidth } from "../../core/richtext";
import { Attr, type Color, Style } from "../../core/style";
import type { StyleProps } from "../../style/types";
import type { ThemeColor } from "../../theme/schema";
import {
	PAINT_PLACEMENTS,
	Damage,
	type ElementImpl,
	type HostElement,
	type LayoutHeight,
	type PaintContext,
} from "../types";
import { paintVerticalChildren, resolveLayoutHeight } from "../layout";
import { registerElement } from "../registry";
import type { HrProps } from "./hr";
import { paintInlineValue } from "./rail";
import { textPropDamage } from "./text";

/** Border glyphs used by a `frame`. */
export interface FrameBorderChars {
	readonly topLeft: string;
	readonly topRight: string;
	readonly bottomLeft: string;
	readonly bottomRight: string;
	readonly horizontal: string;
	readonly vertical: string;
	readonly teeLeft: string;
	readonly teeRight: string;
	readonly teeDown?: string;
	readonly teeUp?: string;
}

/** One footer key hint rendered inside the bottom border. */
export interface FrameFooterHint {
	readonly key: string;
	readonly description?: string;
}

/** Props for bordered, tinted content with a retained JSX title slot. */
export interface FrameProps extends StyleProps {
	readonly children?: JSX.Element;
	readonly height?: LayoutHeight;
	readonly title?: JSX.Element;
	readonly titleInset?: number;
	readonly subtitle?: string;
	readonly topDividerCols?: readonly number[];
	/** Bottom junctions; defaults to the top junctions unless explicitly provided. */
	readonly bottomDividerCols?: readonly number[];
	/** Column junctions where vertical pane dividers meet an internal frame rule. */
	readonly dividerCols?: readonly number[];
	readonly footer?: string;
	readonly footerHints?: readonly FrameFooterHint[];
	readonly paddingX?: number;
	readonly paddingY?: number;
	readonly border?: boolean;
	readonly borderPolicy?: "always" | "content";
	readonly borderColor?: ThemeColor | Color;
	readonly titleColor?: ThemeColor | Color;
	/** Whether the frame adds bold styling to the retained title slot. */
	readonly titleBold?: boolean;
	readonly chars?: FrameBorderChars;
	readonly contentStyle?: Style;
	readonly backgroundBorder?: boolean;
	readonly fitContent?: boolean;
	readonly renderEmpty?: boolean;
}

interface FrameState {
	readonly body: RichText;
	readonly result: RichText;
	readonly title: RichText;
	readonly fitted: RichText;
	readonly border: RichText;
	readonly bodyFitter: LayoutRowFitter;
	readonly titleFitter: LayoutRowFitter;
}

function count(value: number | undefined, fallback = 0): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.trunc(value));
}

function colorStyle(value: ThemeColor | Color | undefined, fallback: ThemeColor, ctx: PaintContext): Style {
	return typeof value === "number" ? Style.of({ fg: value }) : ctx.theme.style(value ?? fallback);
}

function frameState(node: HostElement): FrameState {
	if (node.state === undefined || node.state === null) {
		node.state = {
			body: new RichText(),
			result: new RichText(),
			title: new RichText(),
			fitted: new RichText(),
			border: new RichText(),
			bodyFitter: new LayoutRowFitter(0),
			titleFitter: new LayoutRowFitter(0),
		} satisfies FrameState;
	}
	return node.state as FrameState;
}

function titleRuns(props: FrameProps, state: FrameState, ctx: PaintContext, width: number): RichText {
	state.title.clear();
	const title = props.title;
	const adaptive = typeof title === "object" && title !== null && "tag" in title && title.tag === "row";
	paintInlineValue(title, state.title, Style.NONE, ctx, adaptive ? width : undefined);
	if (props.subtitle) {
		if (state.title.openWidth > 0) state.title.push(Style.NONE, " · ");
		state.title.push(Style.NONE, props.subtitle);
	}
	state.title.br();
	return state.title;
}

function replayWithJunctions(
	source: RichText,
	out: Out,
	width: number,
	columns: readonly number[] | undefined,
	glyph: string,
	style: Style,
): void {
	const junctions = [...new Set(columns ?? [])]
		.map(column => Math.trunc(column))
		.filter(column => column > 0 && column < width - 1)
		.sort((left, right) => left - right);
	if (junctions.length === 0) {
		source.replayRow(out, 0);
		out.br();
		return;
	}
	let cell = 0;
	let junctionIndex = 0;
	const end = source.rowEnd[0] ?? 0;
	for (let index = source.rowStart(0); index < end; index++) {
		const runStyle = source.style[index]!;
		const flags = source.flags[index]!;
		const runWidth = source.width[index]!;
		let text = source.text[index]!;
		if (flags !== RunFlag.None || runWidth === 0) {
			if (flags === RunFlag.None) out.push(runStyle, text);
			else if (flags & RunFlag.Cursor) out.cursor();
			else out.raw(runStyle, text, runWidth, flags);
			cell += runWidth;
			continue;
		}
		let remaining = runWidth;
		while (junctionIndex < junctions.length) {
			const junction = junctions[junctionIndex]!;
			if (junction < cell) {
				junctionIndex++;
				continue;
			}
			if (junction >= cell + remaining) break;
			const before = junction - cell;
			const prefix = takeCells(text, before);
			if (prefix) out.push(runStyle, prefix);
			text = skipCells(skipCells(text, before), 1);
			out.push(style, glyph);
			remaining -= before + 1;
			cell = junction + 1;
			junctionIndex++;
		}
		if (text) out.push(runStyle, text);
		cell += remaining;
	}
	out.br();
}

function pushTopBorder(
	out: RichText,
	width: number,
	props: FrameProps,
	chars: FrameBorderChars,
	base: Style,
	border: Style,
	state: FrameState,
	ctx: PaintContext,
): void {
	const inner = Math.max(0, width - 2);
	const inset = Math.min(inner, count(props.titleInset, 1));
	const budget = Math.max(0, inner - inset);
	const title = titleRuns(props, state, ctx, Math.max(0, budget - 2));
	const titleWidth = title.rowWidth[0] ?? 0;
	if (titleWidth === 0) {
		state.border.clear();
		state.border.push(border, chars.topLeft + chars.horizontal.repeat(inner) + chars.topRight);
		state.border.br();
		replayWithJunctions(
			state.border,
			out,
			width,
			props.topDividerCols,
			chars.teeDown ?? ctx.theme.boxRound.teeDown ?? "┬",
			border,
		);
		return;
	}
	state.border.clear();
	state.border.push(base, " ");
	title.replayRow(state.border, 0);
	state.border.push(base, " ");
	state.border.br();
	state.fitted.clear();
	state.titleFitter.configure(budget, Ellipsis.Unicode, false);
	state.titleFitter.paint(state.border, 0, state.fitted);
	state.fitted.br();
	const shownWidth = state.fitted.rowWidth[0] ?? 0;
	state.border.clear();
	state.border.push(border, chars.topLeft + chars.horizontal.repeat(inset));
	const titleStyle = colorStyle(
		props.titleColor ?? props.borderColor,
		props.borderColor === undefined ? "accent" : "border",
		ctx,
	);
	const titleBase =
		props.titleBold === false
			? props.titleColor === undefined
				? base
				: titleStyle.over(base)
			: titleStyle.plus(Attr.Bold).over(base);
	state.fitted.replayRow(over(state.border, titleBase), 0);
	const used = inset + shownWidth;
	if (used < inner) state.border.push(border, chars.horizontal.repeat(inner - used));
	state.border.push(border, chars.topRight);
	state.border.br();
	replayWithJunctions(
		state.border,
		out,
		width,
		props.topDividerCols,
		chars.teeDown ?? ctx.theme.boxRound.teeDown ?? "┬",
		border,
	);
}

function footerText(props: FrameProps): string {
	const hints = props.footerHints
		?.map(hint => (hint.description ? `${hint.key} ${hint.description}` : hint.key))
		.join("  ");
	return [props.footer, hints].filter((value): value is string => Boolean(value)).join("  ");
}

function pushBottomBorder(
	out: RichText,
	width: number,
	props: FrameProps,
	chars: FrameBorderChars,
	base: Style,
	border: Style,
	state: FrameState,
	ctx: PaintContext,
): void {
	const inner = Math.max(0, width - 2);
	const footer = footerText(props);
	state.border.clear();
	if (footer.length === 0) {
		state.border.push(border, chars.bottomLeft + chars.horizontal.repeat(inner) + chars.bottomRight);
	} else {
		const shown =
			cellWidth(footer) <= Math.max(0, inner - 2) ? ` ${footer} ` : ` ${takeCells(footer, Math.max(0, inner - 3))}…`;
		const shownWidth = cellWidth(shown);
		state.border.push(border, chars.bottomLeft + chars.horizontal.repeat(Math.max(0, inner - shownWidth - 1)));
		state.border.push(colorStyle(props.borderColor, "border", ctx).plus(Attr.Bold).over(base), shown);
		state.border.push(border, chars.horizontal + chars.bottomRight);
	}
	state.border.br();
	replayWithJunctions(
		state.border,
		out,
		width,
		props.bottomDividerCols ?? props.topDividerCols,
		chars.teeUp ?? ctx.theme.boxRound.teeUp ?? "┴",
		border,
	);
}

function pushDivider(
	out: RichText,
	width: number,
	section: HrProps,
	chars: FrameBorderChars,
	base: Style,
	border: Style,
	ctx: PaintContext,
): void {
	const label = section.label;
	const labelStyle = colorStyle(section.labelColor, "toolTitle", ctx).over(base);
	const inner = Math.max(0, width - 2);
	if (!label) {
		out.push(border, chars.teeRight + chars.horizontal.repeat(inner) + chars.teeLeft);
		out.br();
		return;
	}
	const budget = Math.max(0, inner - 5);
	const shown = cellWidth(label) <= budget ? label : budget > 0 ? `${takeCells(label, Math.max(0, budget - 1))}…` : "";
	out.push(border, chars.teeRight + chars.horizontal.repeat(Math.min(3, inner)));
	if (shown) {
		out.push(base, " ");
		out.push(labelStyle, shown);
		out.push(base, " ");
	}
	const used = Math.min(3, inner) + cellWidth(shown) + (shown ? 2 : 0);
	out.push(border, chars.horizontal.repeat(Math.max(0, inner - used)) + chars.teeLeft);
	out.br();
}

function paintFrame(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = node.props as FrameProps;
	const safeWidth = Math.max(0, Math.trunc(width));
	const paddingX = count(props.paddingX, 1);
	const paddingY = count(props.paddingY, 1);
	const chars = props.chars ?? ctx.theme.boxRound;
	const borderRequested = props.border !== false;
	const drawBorder =
		borderRequested && safeWidth >= 2 && (props.borderPolicy === "always" || safeWidth - 2 >= paddingX * 2 + 1);
	const innerWidth = Math.max(0, safeWidth - (drawBorder ? 2 : 0));
	const contentWidth = Math.max(0, innerWidth - paddingX * 2);
	const state = frameState(node);
	state.body.clear();
	const height = resolveLayoutHeight(props.height, ctx.availableHeight);
	const bodyHeight = height === undefined ? undefined : Math.max(0, height - (drawBorder ? 2 : 0) - paddingY * 2);
	const sections = new Map<number, HrProps>();
	paintVerticalChildren(node, state.body, contentWidth, ctx, bodyHeight);
	state.body.finish();
	const collectSections = (parent: HostElement, offset: number): void => {
		for (const [child, placement] of parent[PAINT_PLACEMENTS] ?? []) {
			if (child.kind !== "element" || placement.col !== 0 || placement.width !== contentWidth) continue;
			const row = offset + placement.row;
			if (row < 0 || row >= state.body.rows) continue;
			if (child.tag === "hr" && (child.props as HrProps).variant === "frame") {
				sections.set(row, child.props as HrProps);
			} else if (child.tag !== "frame" && !(child.tag === "box" && child.props.border)) {
				collectSections(child, row);
			}
		}
	};
	collectSections(node, 0);
	for (const child of node.children) {
		ctx.placeChild(child, {
			row: (drawBorder ? 1 : 0) + paddingY + (node[PAINT_PLACEMENTS]?.get(child)?.row ?? 0),
			col: (drawBorder ? 1 : 0) + paddingX,
			width: contentWidth,
			...(bodyHeight === undefined
				? {}
				: {
						clip: {
							row: (drawBorder ? 1 : 0) + paddingY,
							col: (drawBorder ? 1 : 0) + paddingX,
							width: contentWidth,
							height: bodyHeight,
						},
					}),
		});
	}
	if (state.body.rows === 0 && props.renderEmpty !== true && props.title == null && !props.subtitle) return;

	const cascade = ctx.styleOf(node);
	const base = props.contentStyle?.over(cascade) ?? cascade;
	const chromeBase = props.backgroundBorder ? base : Style.NONE;
	const border = colorStyle(props.borderColor, "border", ctx).over(chromeBase);
	state.result.clear();
	if (drawBorder) pushTopBorder(state.result, safeWidth, props, chars, chromeBase, border, state, ctx);
	for (let row = 0; row < paddingY; row++) {
		if (drawBorder) state.result.push(border, chars.vertical);
		if (innerWidth > 0) state.result.push(base, spaces(innerWidth));
		if (drawBorder) state.result.push(border, chars.vertical);
		state.result.br();
	}
	for (let row = 0; row <= state.body.rows; row++) {
		const section = sections.get(row);
		if (section) {
			if (drawBorder) {
				state.border.clear();
				pushDivider(state.border, safeWidth, section, chars, chromeBase, border, ctx);
				replayWithJunctions(
					state.border,
					state.result,
					safeWidth,
					props.dividerCols,
					chars.teeUp ?? ctx.theme.boxRound.teeUp ?? "┴",
					border,
				);
			} else {
				state.result.push(border, chars.horizontal.repeat(safeWidth));
				state.result.br();
			}
		}
		if (row === state.body.rows) break;
		if (section) continue;
		if (drawBorder) state.result.push(border, chars.vertical);
		if (paddingX > 0) state.result.push(base, spaces(paddingX));
		state.bodyFitter.configure(
			contentWidth,
			props.fitContent === false ? Ellipsis.Omit : Ellipsis.Unicode,
			true,
			base,
		);
		state.bodyFitter.paint(state.body, row, over(state.result, base));
		if (paddingX > 0) {
			const fill = state.body.style[state.body.rowEnd[row]! - 1] === Style.RESET ? Style.RESET : base;
			state.result.push(fill, spaces(paddingX));
		}
		if (drawBorder) state.result.push(border, chars.vertical);
		state.result.br();
	}
	for (let row = 0; row < paddingY; row++) {
		if (drawBorder) state.result.push(border, chars.vertical);
		if (innerWidth > 0) state.result.push(base, spaces(innerWidth));
		if (drawBorder) state.result.push(border, chars.vertical);
		state.result.br();
	}
	if (drawBorder) pushBottomBorder(state.result, safeWidth, props, chars, chromeBase, border, state, ctx);
	state.result.finish();
	pipe(new Clip(out, safeWidth, Ellipsis.Omit), sink =>
		state.result.replay(sink, 0, height === undefined ? state.result.rows : Math.min(height, state.result.rows)),
	);
}

function frameDamage(name: string): Damage {
	if (name === "borderColor" || name === "titleColor" || name === "contentStyle" || name === "backgroundBorder")
		return Damage.Paint;
	return textPropDamage(name);
}

/** Retained implementation of the titled, tinted `frame` intrinsic. */
export const frameElement: ElementImpl = {
	tag: "frame",
	slots: ["title"],
	propDamage: frameDamage,
	paint: paintFrame,
};

registerElement(frameElement);
