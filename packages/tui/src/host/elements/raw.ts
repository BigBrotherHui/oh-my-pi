import type { Out } from "../../core/richtext";
import { RunFlag } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { StyleProps } from "../../style/types";
import { Damage, type ElementImpl, type HostElement, type PaintContext } from "../types";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";

/** Internal compositor payload props; never pass untrusted text through `raw`. */
export interface RawProps extends StyleProps {
	readonly value: string;
	readonly width: number;
	readonly image?: boolean;
	/** Payload leaves terminal rendition and hyperlink state untouched. */
	readonly styleSafe?: boolean;
}

function paintRawInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	const props = node.props as unknown as RawProps;
	const flags = RunFlag.Raw | (props.image ? RunFlag.Image : 0) | (props.styleSafe ? RunFlag.StyleSafe : 0);
	out.raw(ctx.styleOf(node).over(base), props.value, Math.max(0, Math.trunc(props.width)), flags);
}

function paintRaw(node: HostElement, out: Out, _width: number, ctx: PaintContext): void {
	paintRawInline(node, out, ctx.styleOf(node), ctx);
	out.br();
}

function rawDamage(name: string): Damage {
	if (name === "value") return Damage.Text;
	if (name === "width" || name === "image") return Damage.Layout;
	if (name === "styleSafe") return Damage.Paint;
	return textPropDamage(name);
}

/** Retained implementation of compositor-internal `raw` payloads. */
export const rawElement: ElementImpl = {
	tag: "raw",
	inline: true,
	propDamage: rawDamage,
	paint: paintRaw,
	paintInline: paintRawInline,
};

registerElement(rawElement);
