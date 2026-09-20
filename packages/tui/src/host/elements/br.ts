import type { Out } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { ElementImpl, HostElement, PaintContext } from "../types";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";

/** Props for an inline hard row break. */
export type BrProps = Record<never, never>;

function paintBreak(_node: HostElement, out: Out): void {
	out.br();
}

function paintBreakInline(_node: HostElement, out: Out, _base: Style, _ctx: PaintContext): void {
	out.br();
}

/** Retained implementation of the inline `br` intrinsic. */
export const brElement: ElementImpl = {
	tag: "br",
	inline: true,
	propDamage: textPropDamage,
	paint: paintBreak,
	paintInline: paintBreakInline,
};

registerElement(brElement);
