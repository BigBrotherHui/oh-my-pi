import type { Out } from "../../core/richtext";
import { registerElement } from "../registry";
import { Damage, type ElementImpl, type HostElement, type PaintContext } from "../types";

/** Retained semantic transcript block with a width-keyed host paint cache. */
export const transcriptBlockElement: ElementImpl = {
	tag: "transcript-block",
	slots: ["compact", "stable"],
	propDamage(name: string): Damage {
		return name === "settled" || name === "stableRows" ? Damage.Paint : Damage.Layout;
	},
	paint(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
		for (const child of node.children) ctx.paintChild(child, out, width);
	},
};

registerElement(transcriptBlockElement);
