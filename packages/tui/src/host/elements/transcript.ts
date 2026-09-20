import { TranscriptController } from "../../compositor/transcript";
import type { Out } from "../../core/richtext";
import { registerElement } from "../registry";
import { Damage, type ElementImpl, type HostElement, type PaintContext } from "../types";

/** Retained transcript element that paints only its controller's mutable tail. */
export const transcriptElement: ElementImpl = {
	tag: "transcript",
	propDamage: () => Damage.Layout,
	paint(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
		let controller = node.state instanceof TranscriptController ? node.state : undefined;
		if (controller === undefined) {
			controller = new TranscriptController(node);
			node.state = controller;
		}
		controller.paint(out, width, ctx);
	},
	onAttach(node: HostElement): void {
		if (!(node.state instanceof TranscriptController)) node.state = new TranscriptController(node);
	},
	onDetach(node: HostElement): void {
		if (node.state instanceof TranscriptController) node.state.dispose();
		node.state = undefined;
	},
};

registerElement(transcriptElement);
