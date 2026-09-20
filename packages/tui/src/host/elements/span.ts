import type { JSX } from "solid-js";
import type { Out } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { StyleProps } from "../../style/types";
import { type ElementImpl, type HostElement, type PaintContext } from "../types";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";

/** Props for an inline style boundary. */
export interface SpanProps extends StyleProps {
	readonly children?: JSX.Element;
}

function paintSpanInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	ctx.paintInlineChildren(node, out, ctx.styleOf(node).over(base));
}

function paintSpan(node: HostElement, out: Out, _width: number, ctx: PaintContext): void {
	paintSpanInline(node, out, ctx.styleOf(node), ctx);
	out.br();
}

/** Retained implementation of the inline `span` intrinsic. */
export const spanElement: ElementImpl = {
	tag: "span",
	inline: true,
	propDamage: textPropDamage,
	paint: paintSpan,
	paintInline: paintSpanInline,
};

registerElement(spanElement);
