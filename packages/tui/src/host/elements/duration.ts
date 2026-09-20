import { formatDuration } from "@oh-my-pi/pi-utils";
import type { Out } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { StyleProps } from "../../style/types";
import { registerElement } from "../registry";
import { Damage, type ElementImpl, type HostElement, type LayoutProps, type PaintContext } from "../types";
import { textPropDamage } from "./text";

/** Props for a human-readable elapsed duration. */
export interface DurationProps extends StyleProps, LayoutProps {
	readonly ms: number;
	readonly coarse?: boolean;
}

/** Format a duration using stable coarse units for compact metadata. */
export function coarseDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

function paintDurationInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	const props = node.props as unknown as DurationProps;
	const text = props.coarse ? coarseDuration(props.ms) : formatDuration(props.ms);
	out.push(ctx.styleOf(node).over(base), text);
}

function paintDuration(node: HostElement, out: Out, _width: number, ctx: PaintContext): void {
	paintDurationInline(node, out, ctx.styleOf(node), ctx);
	out.br();
}

function durationDamage(name: string): Damage {
	if (name === "ms" || name === "coarse") return Damage.Text;
	return textPropDamage(name);
}

/** Retained implementation of the `duration` intrinsic. */
export const durationElement: ElementImpl = {
	tag: "duration",
	inline: true,
	defaultStyle: { color: "dim" },
	propDamage: durationDamage,
	paint: paintDuration,
	paintInline: paintDurationInline,
};

registerElement(durationElement);
