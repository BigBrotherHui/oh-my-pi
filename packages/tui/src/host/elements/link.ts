import type { JSX } from "solid-js";
import type { Out } from "../../core/richtext";
import type { Style } from "../../core/style";
import { uriHyperlinkStyle } from "../../render/hyperlink";
import type { StyleProps } from "../../style/types";
import { Damage, type ElementImpl, type HostElement, type PaintContext } from "../types";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";

/** Props for an inline OSC 8 hyperlink. */
export interface LinkProps extends StyleProps {
	readonly children?: JSX.Element;
	readonly href: string;
}

function linkedStyle(node: HostElement, base: Style, ctx: PaintContext): Style {
	const props = node.props as unknown as LinkProps;
	return uriHyperlinkStyle(props.href, ctx.styleOf(node).over(base));
}

function paintLinkInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	ctx.paintInlineChildren(node, out, linkedStyle(node, base, ctx));
}

function paintLink(node: HostElement, out: Out, _width: number, ctx: PaintContext): void {
	paintLinkInline(node, out, ctx.styleOf(node), ctx);
	out.br();
}

function linkDamage(name: string): Damage {
	return name === "href" ? Damage.Link : textPropDamage(name);
}

/** Retained implementation of the inline `link` intrinsic. */
export const linkElement: ElementImpl = {
	tag: "link",
	inline: true,
	propDamage: linkDamage,
	paint: paintLink,
	paintInline: paintLinkInline,
};

registerElement(linkElement);
