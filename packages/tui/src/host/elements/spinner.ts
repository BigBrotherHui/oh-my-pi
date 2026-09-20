import type { Out } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { StyleProps } from "../../style/types";
import type { SpinnerType } from "../../theme/symbols";
import { registerElement } from "../registry";
import {
	Damage,
	FROZEN_AT,
	type ElementImpl,
	type HostContext,
	type HostElement,
	type LayoutProps,
	type PaintContext,
} from "../types";
import { selectSpinnerFrame, controlledSpinnerFrame } from "./spinner-frame";
import { textPropDamage } from "./text";

/** Props for a glyph driven by the shared spinner clock. */
export interface SpinnerProps extends StyleProps, LayoutProps {
	readonly type?: SpinnerType;
	/** Fixed spinner-frame index; omitting it keeps the glyph clock-driven. */
	readonly frame?: number;
}

interface SpinnerState {
	readonly context: HostContext;
	stop?: () => void;
	animated: boolean;
}

function paintSpinnerInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	syncSpinnerClock(node);
	const props = node.props as unknown as SpinnerProps;
	out.push(
		ctx.styleOf(node).over(base),
		selectSpinnerFrame(ctx.theme.getSpinnerFrames(props.type ?? "status"), props.frame, ctx.now),
	);
}

function paintSpinner(node: HostElement, out: Out, _width: number, ctx: PaintContext): void {
	paintSpinnerInline(node, out, ctx.styleOf(node), ctx);
	out.br();
}

function spinnerDamage(name: string): Damage {
	if (name === "type") return Damage.Layout;
	if (name === "frame") return Damage.Paint;
	return textPropDamage(name);
}

function syncSpinnerClock(node: HostElement): void {
	if (node[FROZEN_AT] !== undefined) return;
	const state = node.state as SpinnerState;
	const props = node.props as unknown as SpinnerProps;
	const animated = controlledSpinnerFrame(props.frame) === undefined;
	if (state.animated === animated) return;
	state.stop?.();
	state.stop = animated
		? state.context.subscribeClock("spinner", () => state.context.invalidate(node, Damage.Paint))
		: undefined;
	state.animated = animated;
}

function attachSpinner(node: HostElement, context: HostContext): void {
	node.state = { context, animated: false } satisfies SpinnerState;
	syncSpinnerClock(node);
}

function detachSpinner(node: HostElement): void {
	const state = node.state as SpinnerState | undefined;
	state?.stop?.();
	node.state = undefined;
}

/** Retained implementation of the `spinner` intrinsic. */
export const spinnerElement: ElementImpl = {
	tag: "spinner",
	inline: true,
	defaultStyle: { color: "accent" },
	propDamage: spinnerDamage,
	paint: paintSpinner,
	paintInline: paintSpinnerInline,
	onAttach: attachSpinner,
	onDetach: detachSpinner,
};

registerElement(spinnerElement);
