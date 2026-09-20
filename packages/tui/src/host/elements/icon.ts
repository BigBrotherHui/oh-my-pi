import type { Out } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { LayoutProps } from "../types";
import { Damage, type ElementImpl, type HostElement, type PaintContext } from "../types";
import { registerElement } from "../registry";
import type { StyleProps } from "../../style/types";
import type { SymbolKey } from "../../theme/symbols";
import { visibleWidth } from "../../utils";
import { textPropDamage } from "./text";

/** Props for a theme-preset glyph. */
export interface IconProps extends StyleProps, LayoutProps {
	readonly name: SymbolKey;
}

function paintIconInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	const props = node.props as unknown as IconProps;
	const glyph = ctx.theme.symbol(props.name);
	if (visibleWidth(glyph) > 0) out.push(ctx.styleOf(node).over(base), glyph);
}

function paintIcon(node: HostElement, out: Out, _width: number, ctx: PaintContext): void {
	paintIconInline(node, out, ctx.styleOf(node), ctx);
	out.br();
}

function iconDamage(name: string): Damage {
	if (name === "name") return Damage.Layout;
	return textPropDamage(name);
}

/** Retained implementation of the `icon` intrinsic. */
export const iconElement: ElementImpl = {
	tag: "icon",
	inline: true,
	propDamage: iconDamage,
	paint: paintIcon,
	paintInline: paintIconInline,
};

registerElement(iconElement);
