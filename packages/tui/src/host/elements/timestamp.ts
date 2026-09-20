import type { Out } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { StyleProps } from "../../style/types";
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
import { textPropDamage } from "./text";

/** Props for a wall-clock instant rendered relatively or as local clock time. */
export interface TimestampProps extends StyleProps, LayoutProps {
	readonly at: number | Date;
	readonly mode?: "relative" | "absolute";
}

interface TimestampState {
	stop: () => void;
}

function relativeTimestamp(at: number, now: number): string {
	const delta = now - at;
	const suffix = delta < 0 ? "from now" : "ago";
	const seconds = Math.floor(Math.abs(delta) / 1_000);
	if (seconds < 60) return delta < 0 ? "soon" : "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${suffix}`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${suffix}`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ${suffix}`;
	const weeks = Math.floor(days / 7);
	if (days < 30) return `${weeks}w ${suffix}`;
	return `${Math.floor(days / 30)}mo ${suffix}`;
}

function timestampText(props: TimestampProps, now: number): string {
	const at = props.at instanceof Date ? props.at.getTime() : props.at;
	if (!Number.isFinite(at)) return "";
	if (props.mode !== "absolute") return relativeTimestamp(at, now);
	return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function paintTimestampInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	const props = node.props as unknown as TimestampProps;
	out.push(ctx.styleOf(node).over(base), timestampText(props, ctx.now));
}

function paintTimestamp(node: HostElement, out: Out, _width: number, ctx: PaintContext): void {
	paintTimestampInline(node, out, ctx.styleOf(node), ctx);
	out.br();
}

function timestampDamage(name: string): Damage {
	if (name === "at" || name === "mode") return Damage.Text;
	return textPropDamage(name);
}

function attachTimestamp(node: HostElement, ctx: HostContext): void {
	if (node[FROZEN_AT] !== undefined) return;
	const stop = ctx.subscribeClock("second", () => {
		const props = node.props as unknown as TimestampProps;
		if (props.mode !== "absolute") ctx.invalidate(node, Damage.Text);
	});
	node.state = { stop } satisfies TimestampState;
}

function detachTimestamp(node: HostElement): void {
	const state = node.state as TimestampState | undefined;
	state?.stop();
	node.state = undefined;
}

/** Retained implementation of the `timestamp` intrinsic. */
export const timestampElement: ElementImpl = {
	tag: "timestamp",
	inline: true,
	defaultStyle: { color: "dim" },
	propDamage: timestampDamage,
	paint: paintTimestamp,
	paintInline: paintTimestampInline,
	onAttach: attachTimestamp,
	onDetach: detachTimestamp,
};

registerElement(timestampElement);
