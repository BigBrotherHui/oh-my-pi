import { Ellipsis } from "@oh-my-pi/pi-natives";
import type { JSX } from "solid-js";
import { LayoutRowFitter } from "../../components/layout/geometry";
import { spaces } from "../../core/out";
import { type Out, RichText } from "../../core/richtext";
import { Style } from "../../core/style";
import { allocateLayout, intrinsicWidthOf, type LayoutAllocation, layoutPropsOf } from "../layout";
import { INTRINSIC_WIDTH, type ElementImpl, type HostElement, type HostNode, type PaintContext } from "../types";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";

/** Props for horizontal cell allocation across retained children. */
export interface RowProps {
	readonly children?: JSX.Element;
	readonly gap?: number;
	readonly pad?: boolean;
	readonly align?: "start" | "center" | "end";
	/** Move the growable detail child to an indented continuation when it cannot remain inline. */
	readonly wrap?: "continuation";
	/** Left indentation for a continuation detail child. */
	readonly continuationIndent?: number;
	/** Give equally weighted growing children identical cell widths, leaving indivisible slack at the end. */
	readonly equalGrow?: boolean;
}

interface RowState {
	readonly buffers: RichText[];
	readonly children: HostNode[];
	readonly fitters: LayoutRowFitter[];
}

function rowState(node: HostElement): RowState {
	if (node.state === undefined || node.state === null)
		node.state = { buffers: [], children: [], fitters: [] } satisfies RowState;
	return node.state as RowState;
}

function verticalOffset(align: RowProps["align"], total: number, child: number): number {
	if (align === "end") return total - child;
	if (align === "center") return (total - child) >> 1;
	return 0;
}

function paintRow(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = node.props as RowProps;
	const state = rowState(node);
	const children = state.children;
	children.length = 0;
	for (const child of node.children) {
		// Solid's empty insertion markers occupy no cells and must not introduce flex gaps.
		if (child.kind !== "text" || child.text.length > 0) children.push(child);
	}
	const count = children.length;
	if (count === 0) {
		node[INTRINSIC_WIDTH] = 0;
		return;
	}
	const safeWidth = Math.max(0, Math.trunc(width));
	const requestedGap = Math.max(0, Math.trunc(props.gap ?? 0));
	const gap = count > 1 ? Math.min(requestedGap, Math.floor(safeWidth / (count - 1))) : 0;
	const gapBudget = gap * Math.max(0, count - 1);
	const allocations: LayoutAllocation[] = new Array(count);
	for (let index = 0; index < count; index++) {
		const child = children[index]!;
		const buffer = (state.buffers[index] ??= new RichText());
		buffer.clear();
		const layout = layoutPropsOf(child);
		if (layout.width !== undefined || ((layout.grow ?? 0) > 0 && props.wrap !== "continuation")) {
			allocations[index] = { ...layout, width: layout.width ?? layout.minWidth ?? 0 };
			continue;
		}
		ctx.paintChild(child, buffer, safeWidth);
		buffer.finish();
		const naturalWidth = intrinsicWidthOf(child);
		allocations[index] =
			layout.width === undefined
				? { ...layout, width: naturalWidth, grow: layout.grow ?? 0, shrink: layout.shrink ?? 1 }
				: layout;
	}
	let naturalWidth = gapBudget;
	for (const allocation of allocations) {
		naturalWidth += Math.max(
			allocation.minWidth ?? 0,
			Math.min(allocation.maxWidth ?? Number.MAX_SAFE_INTEGER, allocation.width ?? 0),
		);
	}
	node[INTRINSIC_WIDTH] = naturalWidth;
	const continuationIndex =
		props.wrap === "continuation" && naturalWidth > safeWidth
			? allocations.findIndex(allocation => (allocation.grow ?? 0) > 0)
			: -1;
	if (continuationIndex >= 0) {
		const fixedIndices = children.map((_, index) => index).filter(index => index !== continuationIndex);
		const fixedGap =
			fixedIndices.length > 1 ? Math.min(requestedGap, Math.floor(safeWidth / (fixedIndices.length - 1))) : 0;
		const fixedWidths = allocateLayout(
			fixedIndices.map(index => allocations[index]!),
			Math.max(0, safeWidth - fixedGap * Math.max(0, fixedIndices.length - 1)),
		);
		let fixedRows = 0;
		for (let position = 0; position < fixedIndices.length; position++) {
			const index = fixedIndices[position]!;
			const buffer = state.buffers[index]!;
			buffer.clear();
			const childWidth = fixedWidths[position]!;
			if (childWidth > 0) ctx.paintChild(children[index]!, buffer, childWidth);
			buffer.finish();
			fixedRows = Math.max(fixedRows, buffer.rows);
		}
		let column = 0;
		for (let position = 0; position < fixedIndices.length; position++) {
			const index = fixedIndices[position]!;
			ctx.placeChild(children[index]!, {
				row: verticalOffset(props.align, fixedRows, state.buffers[index]!.rows),
				col: column,
				width: fixedWidths[position]!,
			});
			column += fixedWidths[position]! + fixedGap;
		}
		for (let row = 0; row < fixedRows; row++) {
			for (let position = 0; position < fixedIndices.length; position++) {
				if (position > 0 && fixedGap > 0) out.push(Style.NONE, spaces(fixedGap));
				const index = fixedIndices[position]!;
				const childWidth = fixedWidths[position]!;
				if (childWidth === 0) continue;
				const buffer = state.buffers[index]!;
				const localRow = row - verticalOffset(props.align, fixedRows, buffer.rows);
				const fitter = (state.fitters[index] ??= new LayoutRowFitter(childWidth, Ellipsis.Omit));
				fitter.configure(childWidth, Ellipsis.Omit, props.pad !== false);
				if (localRow >= 0 && localRow < buffer.rows) fitter.paint(buffer, localRow, out);
				else if (props.pad !== false) out.push(Style.NONE, spaces(childWidth));
			}
			out.br();
		}
		const continuationIndent = Math.min(safeWidth, Math.max(0, Math.trunc(props.continuationIndent ?? 0)));
		const continuationWidth = Math.max(0, safeWidth - continuationIndent);
		const continuation = state.buffers[continuationIndex]!;
		continuation.clear();
		if (continuationWidth > 0) ctx.paintChild(children[continuationIndex]!, continuation, continuationWidth);
		continuation.finish();
		ctx.placeChild(children[continuationIndex]!, {
			row: fixedRows,
			col: continuationIndent,
			width: continuationWidth,
		});
		const fitter = (state.fitters[continuationIndex] ??= new LayoutRowFitter(continuationWidth, Ellipsis.Omit));
		fitter.configure(continuationWidth, Ellipsis.Omit, props.pad !== false);
		for (let row = 0; row < continuation.rows; row++) {
			if (continuationIndent > 0) out.push(Style.NONE, spaces(continuationIndent));
			fitter.paint(continuation, row, out);
			out.br();
		}
		return;
	}
	const widths = allocateLayout(allocations, Math.max(0, safeWidth - gapBudget));
	if (props.equalGrow) {
		let sharedWidth = Number.POSITIVE_INFINITY;
		for (let index = 0; index < count; index++) {
			if ((allocations[index]!.grow ?? 0) > 0) sharedWidth = Math.min(sharedWidth, widths[index]!);
		}
		if (Number.isFinite(sharedWidth)) {
			for (let index = 0; index < count; index++) {
				if ((allocations[index]!.grow ?? 0) > 0) widths[index] = sharedWidth;
			}
		}
	}
	let rows = 0;
	for (let index = 0; index < count; index++) {
		const buffer = state.buffers[index]!;
		buffer.clear();
		const childWidth = widths[index]!;
		if (childWidth > 0) ctx.paintChild(children[index]!, buffer, childWidth);
		buffer.finish();
		rows = Math.max(rows, buffer.rows);
	}

	let column = 0;
	for (let index = 0; index < count; index++) {
		ctx.placeChild(children[index]!, {
			row: verticalOffset(props.align, rows, state.buffers[index]!.rows),
			col: column,
			width: widths[index]!,
		});
		column += widths[index]! + gap;
	}
	for (let row = 0; row < rows; row++) {
		for (let index = 0; index < count; index++) {
			if (index > 0 && gap > 0) out.push(Style.NONE, spaces(gap));
			const childWidth = widths[index]!;
			if (childWidth === 0) continue;
			const buffer = state.buffers[index]!;
			const localRow = row - verticalOffset(props.align, rows, buffer.rows);
			const fitter = (state.fitters[index] ??= new LayoutRowFitter(childWidth, Ellipsis.Omit));
			fitter.configure(childWidth, Ellipsis.Omit, props.pad !== false);
			if (localRow >= 0 && localRow < buffer.rows) fitter.paint(buffer, localRow, out);
			else if (props.pad !== false) out.push(Style.NONE, spaces(childWidth));
		}
		out.br();
	}
}

/** Retained implementation of the allocating `row` intrinsic. */
export const rowElement: ElementImpl = {
	tag: "row",
	propDamage: textPropDamage,
	paint: paintRow,
};

registerElement(rowElement);
