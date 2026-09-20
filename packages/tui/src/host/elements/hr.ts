import { takeCells } from "../../core/out";
import { cellWidth, type Out } from "../../core/richtext";
import { Attr, type Color, Style } from "../../core/style";
import type { ThemeColor } from "../../theme/schema";
import { INTRINSIC_WIDTH, Damage, type ElementImpl, type HostElement, type PaintContext } from "../types";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";

/** Props for a horizontal rule or frame section divider. */
export interface HrProps {
	readonly variant?: "full" | "label" | "frame";
	readonly label?: string;
	readonly labelPosition?: "start" | "center";
	readonly labelColor?: ThemeColor | Color;
	readonly ruleColor?: ThemeColor | Color;
	readonly char?: string;
	readonly left?: string;
	readonly right?: string;
	readonly ruleWidth?: number;
	readonly truncateWhenNarrow?: boolean;
}

function colorStyle(value: ThemeColor | Color | undefined, fallback: ThemeColor, ctx: PaintContext): Style {
	return typeof value === "number" ? Style.of({ fg: value }) : ctx.theme.style(value ?? fallback);
}

function clippedText(value: string, width: number): string {
	if (width <= 0) return "";
	if (cellWidth(value) <= width) return value;
	return width === 1 ? "…" : `${takeCells(value, width - 1)}…`;
}

function paintRule(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = node.props as HrProps;
	const safeWidth = Math.max(0, Math.trunc(width));
	const glyph = Array.from(props.char ?? ctx.theme.tree.horizontal)[0] ?? "─";
	const rule = colorStyle(props.ruleColor, props.variant === "label" ? "dim" : "border", ctx);
	const label = props.label ?? "";
	// Stretching rules fill their assigned column; only fixed content sets its natural width.
	node[INTRINSIC_WIDTH] =
		cellWidth(label) +
		cellWidth(props.left ?? "") +
		cellWidth(props.right ?? "") +
		(props.variant === "label" ? Math.max(0, Math.trunc(props.ruleWidth ?? 10)) + 1 : label.length > 0 ? 2 : 0);
	if (props.variant === "label") {
		const availableRule = safeWidth - cellWidth(label) - 1;
		const ruleWidth = Math.min(Math.max(0, Math.trunc(props.ruleWidth ?? 10)), availableRule);
		const labelStyle = colorStyle(props.labelColor, "text", ctx);
		if (ruleWidth < 1) {
			const shown = props.truncateWhenNarrow === false ? label : clippedText(label, safeWidth);
			out.push(labelStyle, shown);
			out.br();
			return;
		}
		out.push(rule, glyph.repeat(ruleWidth));
		out.push(Style.NONE, " ");
		out.push(labelStyle, clippedText(label, Math.max(0, safeWidth - ruleWidth - 1)));
		out.br();
		return;
	}

	const left = props.left ?? "";
	const right = props.right ?? "";
	const available = Math.max(0, safeWidth - cellWidth(left) - cellWidth(right));
	if (label.length === 0) {
		out.push(rule, left + glyph.repeat(available) + right);
		out.br();
		return;
	}
	const shown = clippedText(` ${label} `, available);
	const remainder = Math.max(0, available - cellWidth(shown));
	const before = props.labelPosition === "center" ? Math.floor(remainder / 2) : Math.min(1, remainder);
	out.push(rule, left + glyph.repeat(before));
	out.push(colorStyle(props.labelColor, "accent", ctx).plus(Attr.Bold), shown);
	out.push(rule, glyph.repeat(remainder - before) + right);
	out.br();
}

function hrDamage(name: string): Damage {
	if (name === "labelColor" || name === "ruleColor") return Damage.Paint;
	return textPropDamage(name);
}

/** Retained implementation of the `hr` intrinsic. */
export const hrElement: ElementImpl = {
	tag: "hr",
	propDamage: hrDamage,
	paint: paintRule,
};

registerElement(hrElement);
