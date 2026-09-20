import { Ellipsis } from "@oh-my-pi/pi-natives";
import type { JSX } from "solid-js";
import { LayoutRowFitter } from "../../components/layout/geometry";
import { type Out, RichText } from "../../core/richtext";
import { Style } from "../../core/style";
import type { ElementImpl, HostElement, HostNode, PaintContext } from "../types";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";

/** Props for a first/continuation inline rail beside block content. */
export interface RailProps {
	readonly children?: JSX.Element;
	readonly prefix: JSX.Element;
	readonly rest?: JSX.Element;
	readonly emptyRows?: boolean;
}

interface RailState {
	readonly prefix: RichText;
	readonly rest: RichText;
	readonly body: RichText;
	readonly prefixFitter: LayoutRowFitter;
	readonly restFitter: LayoutRowFitter;
	readonly bodyFitter: LayoutRowFitter;
}

function isHostNode(value: unknown): value is HostNode {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { kind?: unknown };
	return candidate.kind === "element" || candidate.kind === "text";
}

/** Paint a JSX prop value as inline runs; used for detached rail and frame slots. */
const INLINE_BLOCK_WIDTH = 4096;

export function paintInlineValue(
	value: unknown,
	out: Out,
	base: Style,
	ctx: PaintContext,
	maxWidth = INLINE_BLOCK_WIDTH,
): void {
	if (value === null || value === undefined || typeof value === "boolean") return;
	if (typeof value === "string" || typeof value === "number") {
		out.push(base, String(value));
		return;
	}
	if (Array.isArray(value)) {
		for (const child of value) paintInlineValue(child, out, base, ctx, maxWidth);
		return;
	}
	if (!isHostNode(value)) return;
	if (value.kind === "text") {
		ctx.paintInlineChild(value, out, base);
		return;
	}
	if (value.impl.paintInline) {
		value.impl.paintInline(value, out, base, ctx);
		return;
	}
	const block = new RichText();
	ctx.paintChild(value, block, maxWidth);
	block.finish();
	if (block.rows > 0) block.replayRow(out, 0);
}

function railState(node: HostElement): RailState {
	if (node.state === undefined || node.state === null) {
		node.state = {
			prefix: new RichText(),
			rest: new RichText(),
			body: new RichText(),
			prefixFitter: new LayoutRowFitter(0, Ellipsis.Omit),
			restFitter: new LayoutRowFitter(0, Ellipsis.Omit),
			bodyFitter: new LayoutRowFitter(0, Ellipsis.Omit),
		} satisfies RailState;
	}
	return node.state as RailState;
}

function paintSlot(value: unknown, buffer: RichText, ctx: PaintContext): number {
	buffer.clear();
	paintInlineValue(value, buffer, Style.NONE, ctx);
	const width = buffer.openWidth;
	buffer.br();
	return width;
}

function paintRail(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = node.props as unknown as RailProps;
	const state = railState(node);
	const prefixWidth = paintSlot(props.prefix, state.prefix, ctx);
	const restWidth = paintSlot(props.rest ?? props.prefix, state.rest, ctx);
	const safeWidth = Math.max(0, Math.trunc(width));
	const railWidth = Math.min(safeWidth, Math.max(prefixWidth, restWidth));
	const innerWidth = safeWidth - railWidth;
	state.body.clear();
	for (const child of node.children) ctx.paintChild(child, state.body, innerWidth);
	state.body.finish();
	let childRow = 0;
	for (const child of node.children) {
		ctx.placeChild(child, { row: childRow, col: railWidth, width: innerWidth });
		childRow += child.cache.rows;
	}
	for (let row = 0; row < state.body.rows; row++) {
		const slot = row === 0 ? state.prefix : state.rest;
		const fitter = row === 0 ? state.prefixFitter : state.restFitter;
		if (props.emptyRows !== false || state.body.rowWidth[row]! > 0) {
			fitter.configure(railWidth, Ellipsis.Omit, true);
			fitter.paint(slot, 0, out);
		}
		state.bodyFitter.configure(innerWidth, Ellipsis.Omit, false);
		state.bodyFitter.paint(state.body, row, out);
		out.br();
	}
}

/** Retained implementation of the inline-prefix `rail` intrinsic. */
export const railElement: ElementImpl = {
	tag: "rail",
	slots: ["prefix", "rest"],
	propDamage: textPropDamage,
	paint: paintRail,
};

registerElement(railElement);
