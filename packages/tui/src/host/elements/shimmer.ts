import type { JSX } from "solid-js";
import { type Out, RichText } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { StyleProps } from "../../style/types";
import { paintShimmerText, type ShimmerPalette } from "../../theme/shimmer";
import { registerElement } from "../registry";
import {
	Damage,
	FROZEN_AT,
	type ElementImpl,
	type HostContext,
	type HostElement,
	type HostNode,
	type LayoutProps,
	type PaintContext,
} from "../types";
import { textPropDamage } from "./text";

/** Props for text painted by the retained shimmer palette. */
export interface ShimmerProps extends StyleProps, LayoutProps {
	readonly palette?: ShimmerPalette;
	readonly children?: JSX.Element;
}

interface ShimmerState {
	readonly runs: RichText;
	stop?: () => void;
}

function shimmerState(node: HostElement): ShimmerState {
	if (node.state === undefined || node.state === null) node.state = { runs: new RichText() } satisfies ShimmerState;
	return node.state as ShimmerState;
}

function appendText(node: HostNode, parts: string[]): void {
	if (node.kind === "text") {
		parts.push(node.text);
		return;
	}
	for (const child of node.children) appendText(child, parts);
}

function shimmerText(node: HostElement): string {
	const parts: string[] = [];
	for (const child of node.children) appendText(child, parts);
	return parts.join("");
}

function paintShimmerInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	const props = node.props as unknown as ShimmerProps;
	const ownStyle = ctx.styleOf(node).over(base);
	const runs = shimmerState(node).runs;
	runs.clear();
	paintShimmerText(runs, shimmerText(node), ctx.theme, props.palette, ctx.now);
	runs.finish();
	for (let index = 0; index < runs.runs; index++) {
		out.push(runs.style[index]!.over(ownStyle), runs.text[index]!);
	}
}

function paintShimmer(node: HostElement, out: Out, _width: number, ctx: PaintContext): void {
	paintShimmerInline(node, out, ctx.styleOf(node), ctx);
	out.br();
}

function shimmerDamage(name: string): Damage {
	if (name === "palette") return Damage.Paint;
	return textPropDamage(name);
}

function attachShimmer(node: HostElement, ctx: HostContext): void {
	if (node[FROZEN_AT] !== undefined) return;
	shimmerState(node).stop = ctx.subscribeClock("frame", () => ctx.invalidate(node, Damage.Paint));
}

function detachShimmer(node: HostElement): void {
	const state = node.state as ShimmerState | undefined;
	state?.stop?.();
	node.state = undefined;
}

/** Retained implementation of the `shimmer` intrinsic. */
export const shimmerElement: ElementImpl = {
	tag: "shimmer",
	inline: true,
	propDamage: shimmerDamage,
	paint: paintShimmer,
	paintInline: paintShimmerInline,
	onAttach: attachShimmer,
	onDetach: detachShimmer,
};

registerElement(shimmerElement);
