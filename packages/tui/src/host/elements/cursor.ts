import type { Out } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { ElementImpl, HostElement, PaintContext } from "../types";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";

/** Props for a zero-width hardware-cursor anchor. */
export type CursorProps = Record<never, never>;

function paintCursor(_node: HostElement, out: Out): void {
	out.cursor();
	out.br();
}

function paintCursorInline(_node: HostElement, out: Out, _base: Style, _ctx: PaintContext): void {
	out.cursor();
}

/** Retained implementation of the inline `cursor` intrinsic. */
export const cursorElement: ElementImpl = {
	tag: "cursor",
	inline: true,
	propDamage: textPropDamage,
	paint: paintCursor,
	paintInline: paintCursorInline,
};

registerElement(cursorElement);
