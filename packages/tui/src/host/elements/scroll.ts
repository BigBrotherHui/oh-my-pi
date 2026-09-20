import { Ellipsis } from "@oh-my-pi/pi-natives";
import type { JSX } from "solid-js";
import { LayoutRowFitter } from "../../components/layout/geometry";
import { clampScrollOffset, maxScrollOffset, scrollbarThumbRange } from "../../components/scroll-viewport";
import { replayCells } from "../../core/frame";
import { spaces } from "../../core/out";
import { type Out, RichText, cellWidth } from "../../core/richtext";
import { type Color, Style } from "../../core/style";
import type { ThemeColor } from "../../theme/schema";
import { INTRINSIC_WIDTH, Damage, type ElementImpl, type HostElement, type PaintContext } from "../types";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";
import { intrinsicStackWidth } from "../layout";

/** Props for a fixed-height retained row viewport. */
export interface ScrollProps {
	readonly children?: JSX.Element;
	readonly height?: number;
	readonly scrollbar?: "auto" | "always" | "never" | boolean;
	readonly followTail?: boolean;
	readonly anchor?: "start" | "end";
	readonly totalRows?: number;
	readonly contentWindowed?: boolean;
	readonly offset?: number;
	readonly shrinkToFit?: boolean;
	/**
	 * Logical width used to paint children before their rows are horizontally
	 * clipped to the physical viewport.
	 */
	readonly contentWidth?: number;
	/** Horizontal camera position within {@link contentWidth}. */
	readonly offsetX?: number;
	readonly trackChar?: string;
	readonly thumbChar?: string;
	readonly trackColor?: ThemeColor | Color;
	readonly thumbColor?: ThemeColor | Color;
	readonly ellipsis?: Ellipsis;
	readonly onViewport?: (viewport: ScrollViewportState) => void;
}

/** Actual vertical viewport geometry after wrapping, chrome, and clamping. */
export interface ScrollViewportState {
	readonly offset: number;
	readonly totalRows: number;
	readonly height: number;
	readonly width: number;
}

interface ScrollState {
	readonly content: RichText;
	readonly fitter: LayoutRowFitter;
	internalOffset: number;
	previousRows: number;
	previousHeight: number;
	previousWidth?: number;
	initialized: boolean;
	viewport: ScrollViewportState | undefined;
}

function count(value: number | undefined): number {
	return value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.trunc(value));
}

function scrollState(node: HostElement): ScrollState {
	if (node.state === undefined || node.state === null) {
		node.state = {
			content: new RichText(),
			fitter: new LayoutRowFitter(0),
			internalOffset: 0,
			previousRows: 0,
			previousHeight: 0,
			initialized: false,
			viewport: undefined,
		} satisfies ScrollState;
	}
	return node.state as ScrollState;
}

function scrollbarMode(value: ScrollProps["scrollbar"]): "auto" | "always" | "never" {
	if (value === true) return "auto";
	if (value === false) return "never";
	return value ?? "auto";
}

function glyph(value: string | undefined, fallback: string): string {
	const first = Array.from(value ?? fallback)[0] ?? fallback;
	return cellWidth(first) === 1 ? first : fallback;
}

function colorStyle(value: ThemeColor | Color | undefined, fallback: ThemeColor, ctx: PaintContext): Style {
	return typeof value === "number" ? Style.of({ fg: value }) : ctx.theme.style(value ?? fallback);
}

function publishViewport(
	state: ScrollState,
	callback: ScrollProps["onViewport"],
	offset: number,
	totalRows: number,
	height: number,
	width: number,
): void {
	const previous = state.viewport;
	if (
		previous?.offset === offset &&
		previous.totalRows === totalRows &&
		previous.height === height &&
		previous.width === width
	)
		return;
	const viewport = { offset, totalRows, height, width } satisfies ScrollViewportState;
	state.viewport = viewport;
	callback?.(viewport);
}

function paintContent(node: HostElement, state: ScrollState, width: number, ctx: PaintContext): void {
	state.content.clear();
	for (const child of node.children) ctx.paintChild(child, state.content, width, null);
	state.content.finish();
}

function paintScroll(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = node.props as unknown as ScrollProps;
	const state = scrollState(node);
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
	const height = count(props.height ?? ctx.availableHeight);
	const mode = scrollbarMode(props.scrollbar);
	const requestedContentWidth = props.contentWidth === undefined ? undefined : count(props.contentWidth);

	const geometryChanged =
		state.previousWidth !== safeWidth ||
		node.children.some(child => (child.damage & (Damage.Text | Damage.Layout)) !== 0);
	const predictedScrollbar =
		height > 0 &&
		safeWidth > 0 &&
		(mode === "always" || (mode === "auto" && state.initialized && !geometryChanged && state.previousRows > height));
	paintContent(node, state, requestedContentWidth ?? Math.max(0, safeWidth - (predictedScrollbar ? 1 : 0)), ctx);
	let measuredRows = state.content.rows;
	let rowCount = props.totalRows === undefined ? measuredRows : count(props.totalRows);
	let viewportHeight = props.shrinkToFit ? Math.min(height, rowCount) : height;
	let showScrollbar =
		viewportHeight > 0 && safeWidth > 0 && (mode === "always" || (mode === "auto" && rowCount > viewportHeight));
	if (showScrollbar !== predictedScrollbar && requestedContentWidth === undefined) {
		paintContent(node, state, Math.max(0, safeWidth - (showScrollbar ? 1 : 0)), ctx);
		measuredRows = state.content.rows;
		rowCount = props.totalRows === undefined ? measuredRows : count(props.totalRows);
		viewportHeight = props.shrinkToFit ? Math.min(height, rowCount) : height;
		showScrollbar =
			viewportHeight > 0 && safeWidth > 0 && (mode === "always" || (mode === "auto" && rowCount > viewportHeight));
	}
	let offset: number;
	if (props.offset !== undefined) {
		offset = clampScrollOffset(props.offset, rowCount, viewportHeight);
	} else if (!state.initialized) {
		offset = props.followTail || props.anchor === "end" ? maxScrollOffset(rowCount, viewportHeight) : 0;
	} else {
		const wasAtTail = state.internalOffset >= maxScrollOffset(state.previousRows, state.previousHeight);
		if (props.anchor === "end") {
			const trailing = Math.max(0, state.previousRows - state.internalOffset - state.previousHeight);
			offset = clampScrollOffset(rowCount - viewportHeight - trailing, rowCount, viewportHeight);
		} else if (props.followTail && wasAtTail) {
			offset = maxScrollOffset(rowCount, viewportHeight);
		} else {
			offset = clampScrollOffset(state.internalOffset, rowCount, viewportHeight);
		}
	}

	const viewportWidth = Math.max(0, safeWidth - (showScrollbar ? 1 : 0));
	const logicalContentWidth = requestedContentWidth ?? viewportWidth;
	const offsetX = clampScrollOffset(props.offsetX ?? 0, logicalContentWidth, viewportWidth);
	const horizontal = requestedContentWidth !== undefined || props.offsetX !== undefined;
	state.internalOffset = offset;
	state.previousRows = rowCount;
	state.previousHeight = viewportHeight;
	state.previousWidth = safeWidth;
	state.initialized = true;
	let childRow = props.contentWindowed ? 0 : -offset;
	for (const child of node.children) {
		ctx.placeChild(child, {
			row: childRow,
			col: -offsetX,
			width: logicalContentWidth,
			clip: { row: 0, col: 0, width: viewportWidth, height: viewportHeight },
		});
		childRow += child.cache.rows;
	}
	publishViewport(state, props.onViewport, offset, rowCount, viewportHeight, viewportWidth);
	node[INTRINSIC_WIDTH] = intrinsicStackWidth(node.children) + (showScrollbar ? 1 : 0);

	state.fitter.configure(viewportWidth, props.ellipsis ?? Ellipsis.Unicode, true);
	const thumb = showScrollbar ? scrollbarThumbRange(viewportHeight, rowCount, offset) : undefined;
	const track = glyph(props.trackChar, "│");
	const thumbGlyph = glyph(props.thumbChar, "█");
	const trackStyle = colorStyle(props.trackColor, "dim", ctx);
	const thumbStyle = colorStyle(props.thumbColor, "accent", ctx);
	for (let row = 0; row < viewportHeight; row++) {
		const sourceRow = props.contentWindowed ? row : offset + row;
		if (horizontal) {
			const visible = Math.min(viewportWidth, Math.max(0, logicalContentWidth - offsetX));
			const used = sourceRow < state.content.rows ? replayCells(out, state.content, sourceRow, offsetX, visible) : 0;
			if (used < viewportWidth) out.push(Style.NONE, spaces(viewportWidth - used));
		} else if (sourceRow < state.content.rows) {
			state.fitter.paint(state.content, sourceRow, out);
		} else {
			state.fitter.empty(out);
		}
		if (showScrollbar) {
			const thumbRow = thumb !== undefined && row >= thumb.start && row < thumb.end;
			out.push(thumbRow ? thumbStyle : trackStyle, thumbRow ? thumbGlyph : track);
		}
		out.br();
	}
}

function scrollDamage(name: string): Damage {
	if (
		name === "offset" ||
		name === "offsetX" ||
		name === "trackChar" ||
		name === "thumbChar" ||
		name === "trackColor" ||
		name === "thumbColor"
	)
		return Damage.Paint;
	if (name === "onViewport") return Damage.None;
	return textPropDamage(name);
}

/** Retained implementation of the fixed-height `scroll` intrinsic. */
export const scrollElement: ElementImpl = {
	tag: "scroll",
	propDamage: scrollDamage,
	paint: paintScroll,
};

registerElement(scrollElement);
