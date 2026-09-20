import type { Out } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { StyleProps } from "../../style/types";
import type { SymbolKey } from "../../theme/symbols";
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

/** Semantic status vocabulary shared by retained status glyphs and view compositions. */
export type ToolUIStatus = "success" | "done" | "error" | "warning" | "info" | "pending" | "running" | "aborted";

/** Props for a semantic status glyph measured at its visible width. */
export interface StatusProps extends StyleProps, LayoutProps {
	readonly value: ToolUIStatus;
	readonly successIcon?: SymbolKey;
	/** Fixed spinner-frame index; omitting it keeps running glyphs clock-driven. */
	readonly frame?: number;
}

interface StatusState {
	readonly context: HostContext;
	stop?: () => void;
	animated: boolean;
}

function statusColor(value: ToolUIStatus): StyleProps["color"] {
	if (value === "success" || value === "done") return "success";
	if (value === "error" || value === "aborted") return "error";
	if (value === "warning") return "warning";
	if (value === "pending") return "muted";
	return value === "running" ? undefined : "accent";
}

function statusGlyph(node: HostElement, ctx: PaintContext): string {
	const props = node.props as unknown as StatusProps;
	if (props.value === "running") {
		return selectSpinnerFrame(ctx.theme.getSpinnerFrames("status"), props.frame, ctx.now);
	}
	if (props.value === "success" && props.successIcon !== undefined) return ctx.theme.symbol(props.successIcon);
	return ctx.theme.symbol(`status.${props.value}` as SymbolKey);
}

function paintStatusInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	syncStatusClock(node);
	out.push(ctx.styleOf(node).over(base), statusGlyph(node, ctx));
}

function paintStatus(node: HostElement, out: Out, _width: number, ctx: PaintContext): void {
	paintStatusInline(node, out, ctx.styleOf(node), ctx);
	out.br();
}

function statusDamage(name: string): Damage {
	if (name === "value" || name === "successIcon") return Damage.Layout;
	if (name === "frame") return Damage.Paint;
	return textPropDamage(name);
}

function syncStatusClock(node: HostElement): void {
	if (node[FROZEN_AT] !== undefined) return;
	const state = node.state as StatusState;
	const props = node.props as unknown as StatusProps;
	const animated = props.value === "running" && controlledSpinnerFrame(props.frame) === undefined;
	if (state.animated === animated) return;
	state.stop?.();
	state.stop = animated
		? state.context.subscribeClock("spinner", () => state.context.invalidate(node, Damage.Paint))
		: undefined;
	state.animated = animated;
}

function attachStatus(node: HostElement, context: HostContext): void {
	node.state = { context, animated: false } satisfies StatusState;
	syncStatusClock(node);
}

function detachStatus(node: HostElement): void {
	const state = node.state as StatusState | undefined;
	state?.stop?.();
	node.state = undefined;
}

/** Retained implementation of the `status` intrinsic. */
export const statusElement: ElementImpl = {
	tag: "status",
	inline: true,
	propDamage: statusDamage,
	variantStyle(node) {
		const props = node.props as unknown as StatusProps;
		return { color: statusColor(props.value) };
	},
	paint: paintStatus,
	paintInline: paintStatusInline,
	onAttach: attachStatus,
	onDetach: detachStatus,
};

registerElement(statusElement);
