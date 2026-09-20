import type { JSX } from "solid-js";
import { type Out, RichText, RunFlag } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { StyleProps } from "../../style/types";
import { registerElement } from "../registry";
import type { ElementImpl, HostElement, LayoutProps, PaintContext } from "../types";
import { textPropDamage } from "./text";
import { paintInlineValue } from "./rail";

/** Props for separator-aware inline metadata. */
export interface MetaProps extends StyleProps, LayoutProps {
	readonly children?: JSX.Element;
}

interface MetaState {
	readonly buffers: RichText[];
}

function metaState(node: HostElement): MetaState {
	if (node.state === undefined || node.state === null) node.state = { buffers: [] } satisfies MetaState;
	return node.state as MetaState;
}

function hasVisibleContent(buffer: RichText): boolean {
	for (let index = 0; index < buffer.runs; index++) {
		if ((buffer.flags[index]! & RunFlag.Raw) !== 0 && buffer.width[index]! > 0) return true;
		if (buffer.text[index]!.trim().length > 0) return true;
	}
	return false;
}

function paintMetaInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	const style = ctx.styleOf(node).over(base);
	const state = metaState(node);
	let painted = false;
	for (let index = 0; index < node.children.length; index++) {
		const buffer = (state.buffers[index] ??= new RichText());
		buffer.clear();
		paintInlineValue(node.children[index]!, buffer, style, ctx);
		buffer.finish();
		if (!hasVisibleContent(buffer)) continue;
		if (painted) out.push(style, ctx.theme.symbol("sep.dot"));
		if (buffer.rows > 0) buffer.replayRow(out, 0);
		painted = true;
	}
	state.buffers.length = node.children.length;
}

function paintMeta(node: HostElement, out: Out, _width: number, ctx: PaintContext): void {
	paintMetaInline(node, out, ctx.styleOf(node), ctx);
	out.br();
}

/** Retained implementation of the `meta` intrinsic. */
export const metaElement: ElementImpl = {
	tag: "meta",
	inline: true,
	defaultStyle: { color: "dim" },
	propDamage: textPropDamage,
	paint: paintMeta,
	paintInline: paintMetaInline,
};

registerElement(metaElement);
