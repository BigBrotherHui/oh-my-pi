import { Ellipsis } from "@oh-my-pi/pi-natives";
import type { JSX } from "solid-js";
import { LayoutRowFitter } from "../../components/layout/geometry";
import { type Out, RichText, cellWidth } from "../../core/richtext";
import { Style } from "../../core/style";
import type { ElementImpl, HostElement, LayoutHeight, PaintContext } from "../types";
import { intrinsicWidthOf, resolveLayoutHeight } from "../layout";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";

/** Fixed or proportional sizing constraints for the left split pane. */
export interface SplitPaneSize {
	readonly fixed?: number;
	/** Prefer the left pane's intrinsic content width, within its min/max bounds. */
	readonly content?: boolean;
	readonly ratio?: number;
	readonly min?: number;
	readonly max?: number;
}

/** Actual pane widths published after native split allocation. */
export interface SplitPaneLayout {
	readonly leftWidth: number;
	readonly rightWidth: number;
	readonly split: boolean;
}

/** Props for adaptive two-pane row layout. */
export interface SplitProps {
	readonly children?: JSX.Element;
	readonly leftSize?: SplitPaneSize;
	readonly rightMinWidth?: number;
	readonly splitAt?: number;
	readonly narrowPane?: "left" | "right";
	readonly height?: LayoutHeight;
	readonly prefix?: string;
	readonly divider?: string;
	/** Explicit divider styling, independent of the child panes. */
	readonly dividerStyle?: Style;
	readonly suffix?: string;
	readonly align?: "start" | "center" | "end";
	readonly onLayout?: (layout: SplitPaneLayout) => void;
}

interface SplitGeometry {
	readonly indices: readonly number[];
	readonly widths: readonly number[];
	readonly split: boolean;
}

interface SplitState {
	readonly buffers: RichText[];
	layout?: SplitPaneLayout;
	readonly fitters: LayoutRowFitter[];
	readonly line: RichText;
	readonly lineFitter: LayoutRowFitter;
}

function count(value: number | undefined): number {
	return value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.trunc(value));
}

function ratio(value: number | undefined): number {
	return value === undefined || !Number.isFinite(value) ? 0.5 : Math.max(0, value);
}

function geometry(props: SplitProps, width: number, contentWidth = 0): SplitGeometry {
	const decorations = cellWidth(props.prefix ?? "") + cellWidth(props.suffix ?? "");
	const dividerWidth = cellWidth(props.divider ?? "");
	const splitAvailable = Math.max(0, width - decorations - dividerWidth);
	const leftMin = count(props.leftSize?.min);
	const leftMax =
		props.leftSize?.max === undefined ? Number.MAX_SAFE_INTEGER : Math.max(leftMin, count(props.leftSize.max));
	const rightMin = count(props.rightMinWidth);
	const canSplit =
		props.narrowPane === undefined || (width >= count(props.splitAt) && splitAvailable >= leftMin + rightMin);
	if (!canSplit) {
		return {
			indices: [props.narrowPane === "right" ? 1 : 0],
			widths: [Math.max(0, width - decorations)],
			split: false,
		};
	}
	const desired =
		props.leftSize?.fixed !== undefined
			? count(props.leftSize.fixed)
			: props.leftSize?.content
				? contentWidth
				: Math.floor(width * ratio(props.leftSize?.ratio));
	const left = Math.min(
		splitAvailable,
		Math.max(leftMin, Math.min(leftMax, Math.max(0, splitAvailable - rightMin), desired)),
	);
	return { indices: [0, 1], widths: [left, Math.max(0, splitAvailable - left)], split: true };
}

function splitState(node: HostElement): SplitState {
	if (node.state === undefined || node.state === null) {
		node.state = {
			buffers: [],
			fitters: [],
			line: new RichText(),
			lineFitter: new LayoutRowFitter(0, Ellipsis.Omit),
		} satisfies SplitState;
	}
	return node.state as SplitState;
}

function offset(align: SplitProps["align"], height: number, rows: number): number {
	if (align === "end") return height - rows;
	if (align === "center") return (height - rows) >> 1;
	return 0;
}

function paintSplit(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	if (node.children.length < 2) return;
	const props = node.props as SplitProps;
	const safeWidth = Math.max(0, Math.trunc(width));
	const requestedHeight = resolveLayoutHeight(props.height, ctx.availableHeight);
	let contentWidth = 0;
	if (props.leftSize?.content) {
		const probeWidth = props.leftSize.max === undefined ? safeWidth : Math.min(safeWidth, count(props.leftSize.max));
		ctx.measureChild(node.children[0]!, probeWidth, requestedHeight);
		contentWidth = intrinsicWidthOf(node.children[0]!);
	}
	const measured = geometry(props, safeWidth, contentWidth);
	const state = splitState(node);
	const leftWidth = measured.indices[0] === 0 ? measured.widths[0]! : 0;
	const rightWidth = measured.split ? measured.widths[1]! : measured.indices[0] === 1 ? measured.widths[0]! : 0;
	if (
		state.layout?.leftWidth !== leftWidth ||
		state.layout.rightWidth !== rightWidth ||
		state.layout.split !== measured.split
	) {
		state.layout = { leftWidth, rightWidth, split: measured.split };
		props.onLayout?.(state.layout);
	}
	let naturalHeight = 0;
	for (let pane = 0; pane < measured.indices.length; pane++) {
		const buffer = (state.buffers[pane] ??= new RichText());
		buffer.clear();
		const paneWidth = measured.widths[pane]!;
		if (paneWidth > 0) ctx.paintChild(node.children[measured.indices[pane]!]!, buffer, paneWidth, requestedHeight);
		buffer.finish();
		naturalHeight = Math.max(naturalHeight, buffer.rows);
	}
	const height = requestedHeight ?? naturalHeight;
	let column = cellWidth(props.prefix ?? "");
	for (let pane = 0; pane < measured.indices.length; pane++) {
		ctx.placeChild(node.children[measured.indices[pane]!]!, {
			row: offset(props.align, height, Math.min(height, state.buffers[pane]!.rows)),
			col: column,
			width: measured.widths[pane]!,
			clip: { row: 0, col: column, width: measured.widths[pane]!, height },
		});
		column += measured.widths[pane]! + (pane === 0 && measured.split ? cellWidth(props.divider ?? "") : 0);
	}
	for (let row = 0; row < height; row++) {
		state.line.clear();
		state.line.push(Style.NONE, props.prefix ?? "");
		for (let pane = 0; pane < measured.indices.length; pane++) {
			const paneWidth = measured.widths[pane]!;
			const buffer = state.buffers[pane]!;
			const childRow = row - offset(props.align, height, Math.min(height, buffer.rows));
			const fitter = (state.fitters[pane] ??= new LayoutRowFitter(paneWidth, Ellipsis.Unicode));
			fitter.configure(paneWidth, Ellipsis.Unicode, true);
			if (childRow >= 0 && childRow < buffer.rows) fitter.paint(buffer, childRow, state.line);
			else fitter.empty(state.line);
			if (pane === 0 && measured.split) state.line.push(props.dividerStyle ?? Style.NONE, props.divider ?? "");
		}
		state.line.push(Style.NONE, props.suffix ?? "");
		state.line.br();
		state.lineFitter.configure(safeWidth, Ellipsis.Omit, true);
		state.lineFitter.paint(state.line, 0, out);
		out.br();
	}
}

/** Retained implementation of the adaptive `split` intrinsic. */
export const splitElement: ElementImpl = {
	tag: "split",
	propDamage: textPropDamage,
	paint: paintSplit,
};

registerElement(splitElement);
