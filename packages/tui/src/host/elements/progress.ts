import { takeCells } from "../../core/out";
import { cellWidth } from "../../core/richtext";
import { Style, type Color } from "../../core/style";
import type { ThemeColor } from "../../theme/schema";
import { registerElement } from "../registry";
import { Damage, type ElementImpl } from "../types";

/** One precomputed run in a width-aware progress bar. */
export interface ProgressRun {
	readonly text: string;
	readonly color?: ThemeColor | Color;
}

/** Props for a determinate or indeterminate progress row. */
export interface ProgressProps {
	readonly value?: number;
	readonly min?: number;
	readonly max?: number;
	readonly prefix?: string;
	readonly suffix?: string;
	readonly showPercentage?: boolean;
	readonly filled?: string;
	readonly empty?: string;
	readonly indeterminate?: string;
	readonly color?: ThemeColor | Color;
	readonly emptyColor?: ThemeColor | Color;
	/** Build styled cells after native layout allocates the bar's exact width. */
	readonly render?: (width: number) => readonly ProgressRun[];
}

function singleLine(text: string): string {
	return text.replace(/[\t\r\n]/g, " ");
}

function fill(out: { push(style: Style, text: string): void }, style: Style, glyph: string, width: number): void {
	const clean = singleLine(glyph);
	const glyphWidth = cellWidth(clean);
	if (glyphWidth <= 0) {
		out.push(style, " ".repeat(width));
		return;
	}
	const count = Math.floor(width / glyphWidth);
	out.push(style, `${clean.repeat(count)}${" ".repeat(width - count * glyphWidth)}`);
}

function fraction(value: number | undefined, min: number, max: number): number | undefined {
	if (value === undefined) return undefined;
	if (max <= min) return value >= max ? 1 : 0;
	return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function paintRuns(
	out: { push(style: Style, text: string): void },
	runs: readonly ProgressRun[],
	width: number,
	base: Style,
	remaining: Style,
	theme: { style(color: ThemeColor): Style },
): void {
	let written = 0;
	for (const run of runs) {
		if (written >= width) break;
		const text = takeCells(singleLine(run.text), width - written);
		const textWidth = cellWidth(text);
		if (textWidth === 0) continue;
		const style =
			run.color === undefined
				? base
				: (typeof run.color === "number" ? Style.of({ fg: run.color }) : theme.style(run.color)).over(base);
		out.push(style, text);
		written += textWidth;
	}
	if (written < width) fill(out, remaining, " ", width - written);
}

const progressElement: ElementImpl = {
	tag: "progress",
	propDamage: name => (name === "value" || name === "color" || name === "emptyColor" ? Damage.Paint : Damage.Layout),
	paint(node, out, width, ctx) {
		const props = node.props as unknown as ProgressProps;
		const base = ctx.styleOf(node);
		const complete = (
			typeof props.color === "number" ? Style.of({ fg: props.color }) : ctx.theme.style(props.color ?? "accent")
		).over(base);
		const remaining = (
			typeof props.emptyColor === "number"
				? Style.of({ fg: props.emptyColor })
				: ctx.theme.style(props.emptyColor ?? "dim")
		).over(base);
		const min = props.min ?? 0;
		const max = props.max ?? 1;
		const progress = fraction(props.value, min, max);
		const prefix = singleLine(props.prefix ?? "");
		const suffix = singleLine(props.suffix ?? "");
		const percentage = progress !== undefined && props.showPercentage ? ` ${Math.round(progress * 100)}%` : "";
		const barWidth = Math.max(0, width - cellWidth(prefix) - cellWidth(suffix) - cellWidth(percentage));
		out.push(base, prefix);
		if (props.render) {
			paintRuns(out, props.render(barWidth), barWidth, base, remaining, ctx.theme);
		} else if (progress === undefined) {
			fill(out, remaining, props.indeterminate ?? "·", barWidth);
		} else {
			const filledWidth = Math.round(progress * barWidth);
			fill(out, complete, props.filled ?? ctx.theme.progress.filled, filledWidth);
			fill(out, remaining, props.empty ?? ctx.theme.progress.empty, Math.max(0, barWidth - filledWidth));
		}
		out.push(base, `${suffix}${percentage}`);
		out.br();
	},
};

registerElement(progressElement);
