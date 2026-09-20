import type { JSX } from "solid-js";
import type { Out } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { StyleProps } from "../../style/types";
import { registerElement } from "../registry";
import type { ElementImpl, HostElement, LayoutProps, PaintContext } from "../types";
import { textPropDamage } from "./text";

/** Props for inline content enclosed by theme bracket glyphs. */
export interface BadgeProps extends StyleProps, LayoutProps {
	readonly children?: JSX.Element;
}

function paintBadgeInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	const style = ctx.styleOf(node).over(base);
	out.push(style, ctx.theme.symbol("format.bracketLeft"));
	ctx.paintInlineChildren(node, out, style);
	out.push(style, ctx.theme.symbol("format.bracketRight"));
}

function paintBadge(node: HostElement, out: Out, _width: number, ctx: PaintContext): void {
	paintBadgeInline(node, out, ctx.styleOf(node), ctx);
	out.br();
}

/** Retained implementation of the `badge` intrinsic. */
export const badgeElement: ElementImpl = {
	tag: "badge",
	inline: true,
	propDamage: textPropDamage,
	paint: paintBadge,
	paintInline: paintBadgeInline,
};

registerElement(badgeElement);
