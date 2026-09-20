import type { JSX } from "solid-js";
import type { Out } from "../../core/richtext";
import { INTRINSIC_WIDTH, type ElementImpl, type HostElement, type LayoutHeight, type PaintContext } from "../types";
import { intrinsicStackWidth, paintVerticalChildren, resolveLayoutHeight } from "../layout";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";

/** Props for vertically stacked children. */
export interface StackProps {
	readonly children?: JSX.Element;
	readonly gap?: number;
	readonly height?: LayoutHeight;
}

function paintStack(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = node.props as StackProps;
	const gap = Math.max(0, Math.trunc(props.gap ?? 0));
	paintVerticalChildren(node, out, width, ctx, resolveLayoutHeight(props.height, ctx.availableHeight), gap);
	node[INTRINSIC_WIDTH] = intrinsicStackWidth(node.children);
}

/** Retained implementation of the vertical `stack` intrinsic. */
export const stackElement: ElementImpl = {
	tag: "stack",
	propDamage: textPropDamage,
	paint: paintStack,
};

registerElement(stackElement);
