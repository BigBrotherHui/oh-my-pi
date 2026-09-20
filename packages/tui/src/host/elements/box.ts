import { Ellipsis } from "@oh-my-pi/pi-natives";
import type { JSX } from "solid-js";
import { LayoutRowFitter } from "../../components/layout/geometry";
import { over, spaces } from "../../core/out";
import { type Out, RichText } from "../../core/richtext";
import { type Color, Style } from "../../core/style";
import type { StyleProps } from "../../style/types";
import type { ThemeColor } from "../../theme/schema";
import {
	INTRINSIC_WIDTH,
	PAINT_PLACEMENTS,
	Damage,
	type ElementImpl,
	type HostElement,
	type LayoutHeight,
	type PaintContext,
} from "../types";
import { intrinsicStackWidth, paintVerticalChildren, resolveLayoutHeight } from "../layout";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";

/** Per-edge padding for a `box`. */
export interface BoxPadding {
	readonly top?: number;
	readonly right?: number;
	readonly bottom?: number;
	readonly left?: number;
	readonly x?: number;
	readonly y?: number;
}

/** Glyphs used by a custom `box` border. */
export interface BoxBorderChars {
	readonly topLeft: string;
	readonly topRight: string;
	readonly bottomLeft: string;
	readonly bottomRight: string;
	readonly horizontal: string;
	readonly vertical: string;
}

/** Configurable `box` border. */
export interface BoxBorder {
	readonly style?: "single" | "round" | "double" | "heavy";
	readonly chars?: BoxBorderChars;
	readonly color?: ThemeColor | Color | Style;
}

/** Props for padded, optionally bordered content. */
export interface BoxProps extends StyleProps {
	readonly children?: JSX.Element;
	readonly height?: LayoutHeight;
	readonly padding?: number | BoxPadding;
	readonly border?: "single" | "round" | "double" | "heavy" | BoxBorder;
}

interface ResolvedPadding {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

const BORDER_CHARS: Readonly<Record<"single" | "round" | "double" | "heavy", BoxBorderChars>> = {
	single: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" },
	round: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	double: { topLeft: "╔", topRight: "╗", bottomLeft: "╚", bottomRight: "╝", horizontal: "═", vertical: "║" },
	heavy: { topLeft: "┏", topRight: "┓", bottomLeft: "┗", bottomRight: "┛", horizontal: "━", vertical: "┃" },
};

function count(value: number | undefined): number {
	return value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.trunc(value));
}

function resolvePadding(value: BoxProps["padding"]): ResolvedPadding {
	if (typeof value === "number") {
		const size = count(value);
		return { top: size, right: size, bottom: size, left: size };
	}
	const x = count(value?.x);
	const y = count(value?.y);
	return {
		top: value?.top === undefined ? y : count(value.top),
		right: value?.right === undefined ? x : count(value.right),
		bottom: value?.bottom === undefined ? y : count(value.bottom),
		left: value?.left === undefined ? x : count(value.left),
	};
}

function borderStyle(border: BoxProps["border"], ctx: PaintContext): Style {
	if (typeof border === "string" || border?.color === undefined) return Style.NONE;
	if (border.color instanceof Style) return border.color;
	return typeof border.color === "number" ? Style.of({ fg: border.color }) : ctx.theme.style(border.color);
}

function borderChars(border: NonNullable<BoxProps["border"]>): BoxBorderChars {
	if (typeof border === "string") return BORDER_CHARS[border];
	return border.chars ?? BORDER_CHARS[border.style ?? "single"];
}

interface BoxState {
	readonly content: RichText;
	readonly fitter: LayoutRowFitter;
}

function boxState(node: HostElement): BoxState {
	if (node.state === undefined || node.state === null) {
		node.state = { content: new RichText(), fitter: new LayoutRowFitter(0) } satisfies BoxState;
	}
	return node.state as BoxState;
}

function paintBox(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = node.props as BoxProps;
	const safeWidth = Math.max(0, Math.trunc(width));
	const padding = resolvePadding(props.padding);
	const requestedBorder = props.border;
	const drawBorder = requestedBorder !== undefined && safeWidth >= padding.left + padding.right + 3;
	const innerWidth = Math.max(0, safeWidth - (drawBorder ? 2 : 0));
	const leftPadding = Math.min(padding.left, innerWidth);
	const rightPadding = Math.min(padding.right, innerWidth - leftPadding);
	const contentWidth = Math.max(0, innerWidth - leftPadding - rightPadding);
	const state = boxState(node);
	const content = state.content;
	content.clear();
	const height = resolveLayoutHeight(props.height, ctx.availableHeight);
	const contentHeight =
		height === undefined ? undefined : Math.max(0, height - (drawBorder ? 2 : 0) - padding.top - padding.bottom);
	paintVerticalChildren(node, content, contentWidth, ctx, contentHeight);
	content.finish();
	node[INTRINSIC_WIDTH] = intrinsicStackWidth(node.children) + leftPadding + rightPadding + (drawBorder ? 2 : 0);
	let childRow = (drawBorder ? 1 : 0) + padding.top;
	for (const child of node.children) {
		ctx.placeChild(child, {
			row:
				contentHeight === undefined
					? childRow
					: (drawBorder ? 1 : 0) + padding.top + (node[PAINT_PLACEMENTS]?.get(child)?.row ?? 0),
			col: (drawBorder ? 1 : 0) + leftPadding,
			width: contentWidth,
			...(contentHeight === undefined
				? {}
				: {
						clip: {
							row: (drawBorder ? 1 : 0) + padding.top,
							col: (drawBorder ? 1 : 0) + leftPadding,
							width: contentWidth,
							height: contentHeight,
						},
					}),
		});
		childRow += child.cache.rows;
	}
	if (content.rows === 0) return;

	const base = ctx.styleOf(node);
	const chrome = requestedBorder === undefined ? Style.NONE : borderStyle(requestedBorder, ctx).over(base);
	const chars = requestedBorder === undefined ? BORDER_CHARS.single : borderChars(requestedBorder);
	if (drawBorder) {
		out.push(chrome, chars.topLeft + chars.horizontal.repeat(innerWidth) + chars.topRight);
		out.br();
	}
	const emitInterior = (contentRow: number | undefined): void => {
		if (drawBorder) out.push(chrome, chars.vertical);
		const interior = over(out, base);
		if (leftPadding > 0) interior.push(Style.NONE, spaces(leftPadding));
		if (contentRow === undefined) {
			if (contentWidth > 0) interior.push(Style.NONE, spaces(contentWidth));
		} else {
			state.fitter.configure(contentWidth, Ellipsis.Omit, true, base);
			state.fitter.paint(content, contentRow, interior);
		}
		if (rightPadding > 0) {
			const fill =
				contentRow !== undefined && content.style[content.rowEnd[contentRow]! - 1] === Style.RESET
					? Style.RESET
					: Style.NONE;
			interior.push(fill, spaces(rightPadding));
		}
		if (drawBorder) out.push(chrome, chars.vertical);
		out.br();
	};
	for (let row = 0; row < padding.top; row++) emitInterior(undefined);
	for (let row = 0; row < content.rows; row++) emitInterior(row);
	for (let row = 0; row < padding.bottom; row++) emitInterior(undefined);
	if (drawBorder) {
		out.push(chrome, chars.bottomLeft + chars.horizontal.repeat(innerWidth) + chars.bottomRight);
		out.br();
	}
}

function boxDamage(name: string): Damage {
	if (name === "padding" || name === "border") return Damage.Layout;
	return textPropDamage(name);
}

/** Retained implementation of the padded `box` intrinsic. */
export const boxElement: ElementImpl = {
	tag: "box",
	propDamage: boxDamage,
	paint: paintBox,
};

registerElement(boxElement);
