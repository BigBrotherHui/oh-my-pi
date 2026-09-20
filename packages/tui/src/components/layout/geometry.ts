import { Ellipsis } from "@oh-my-pi/pi-natives";
import { Clip, spaces } from "../../core/out";
import { type Out, RichText } from "../../core/richtext";
import { Style } from "../../core/style";
import { padding, truncateToWidth, visibleWidth } from "../../utils";

/** Alignment within space allocated by a layout component. */
export type LayoutAlignment = "start" | "center" | "end";

/** Insets reserved inside a layout child's allocated rectangle. */
export interface LayoutInsets {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Insets normalized to finite, non-negative terminal-cell counts. */
export interface NormalizedLayoutInsets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/** Rectangle in coordinates local to a layout component. */
export interface LayoutRect {
	row: number;
	col: number;
	width: number;
	height: number;
}

export interface LayoutDecorationRun {
	readonly text: string;
	readonly style?: Style;
}

/** Plain or styled static text, optionally resolved late for mutable themes. */
export type LayoutDecoration = string | LayoutDecorationRun | (() => LayoutDecorationRun);

/** One fixed or growing constraint consumed by {@link allocateLayoutSpace}. */
export interface LayoutAllocation {
	fixed?: number;
	grow?: number;
	min?: number;
	max?: number;
}

/** Clamp an external size to a finite, non-negative integer cell count. */
export function layoutSize(value: number | undefined, fallback = 0): number {
	const resolved = value === undefined || !Number.isFinite(value) ? fallback : value;
	return Number.isFinite(resolved) ? Math.max(0, Math.floor(resolved)) : 0;
}

/** Normalize an optional external size while preserving `undefined`. */
export function optionalLayoutSize(value: number | undefined): number | undefined {
	return value === undefined ? undefined : layoutSize(value);
}

/** Clamp a proportional layout input to a finite, non-negative number. */
export function layoutRatio(value: number | undefined, fallback: number): number {
	const resolved = value === undefined || !Number.isFinite(value) ? fallback : value;
	return Number.isFinite(resolved) ? Math.max(0, resolved) : 0;
}

/** Resolve a decoration once for measurement and painting. */
export function resolveLayoutDecoration(decoration: LayoutDecoration | undefined): LayoutDecorationRun {
	if (decoration === undefined) return { text: "" };
	if (typeof decoration === "string") return { text: decoration };
	return typeof decoration === "function" ? decoration() : decoration;
}

/** Resolve static or late-bound layout decoration text. */
export function layoutDecorationText(decoration: LayoutDecoration | undefined): string {
	return resolveLayoutDecoration(decoration).text;
}

function allocationMaximum(item: LayoutAllocation): number {
	return item.max === undefined ? Number.MAX_SAFE_INTEGER : Math.max(layoutSize(item.min), layoutSize(item.max));
}

/**
 * Allocate bounded integer cells across fixed and growing children. When the
 * minimums cannot fit, later children collapse first so output stays bounded.
 */
export function allocateLayoutSpace(items: readonly LayoutAllocation[], available: number): number[] {
	available = layoutSize(available);
	const sizes = items.map(item => {
		const minimum = layoutSize(item.min);
		const maximum = allocationMaximum(item);
		return item.fixed === undefined ? minimum : Math.max(minimum, Math.min(maximum, layoutSize(item.fixed)));
	});
	const used = sizes.reduce((sum, size) => sum + size, 0);
	if (used > available) {
		let overflow = used - available;
		for (let index = sizes.length - 1; index >= 0 && overflow > 0; index--) {
			const reduction = Math.min(sizes[index] ?? 0, overflow);
			sizes[index] = (sizes[index] ?? 0) - reduction;
			overflow -= reduction;
		}
		return sizes;
	}

	let remaining = available - used;
	let flexible = items
		.map((item, index) => ({ item, index }))
		.filter(({ item }) => item.fixed === undefined && layoutSize(item.grow) > 0);
	while (remaining > 0 && flexible.length > 0) {
		const totalWeight = flexible.reduce((sum, { item }) => sum + layoutSize(item.grow), 0);
		let granted = 0;
		for (const { item, index } of flexible) {
			const maximum = allocationMaximum(item);
			const capacity = maximum - (sizes[index] ?? 0);
			if (capacity <= 0) continue;
			const proportional = Math.floor((remaining * layoutSize(item.grow)) / totalWeight);
			const share = Math.min(capacity, Math.max(1, proportional), remaining - granted);
			if (share <= 0) continue;
			sizes[index] = (sizes[index] ?? 0) + share;
			granted += share;
			if (granted === remaining) break;
		}
		if (granted === 0) break;
		remaining -= granted;
		flexible = flexible.filter(({ item, index }) => {
			const maximum = allocationMaximum(item);
			return (sizes[index] ?? 0) < maximum;
		});
	}
	return sizes;
}

/** Normalize every inset to a finite, non-negative integer cell count. */
export function layoutInsets(insets: LayoutInsets | undefined): NormalizedLayoutInsets {
	return {
		top: layoutSize(insets?.top),
		right: layoutSize(insets?.right),
		bottom: layoutSize(insets?.bottom),
		left: layoutSize(insets?.left),
	};
}

/** Compare optional inset objects by their normalized terminal geometry. */
export function equalLayoutInsets(left: LayoutInsets | undefined, right: LayoutInsets | undefined): boolean {
	return (
		layoutSize(left?.top) === layoutSize(right?.top) &&
		layoutSize(left?.right) === layoutSize(right?.right) &&
		layoutSize(left?.bottom) === layoutSize(right?.bottom) &&
		layoutSize(left?.left) === layoutSize(right?.left)
	);
}

/** Offset content within spare cells according to an alignment. */
export function layoutAlignmentOffset(space: number, alignment: LayoutAlignment): number {
	if (space <= 0 || alignment === "start") return 0;
	return alignment === "end" ? space : Math.floor(space / 2);
}

/** Fit one ANSI-styled row to an exact terminal-cell width. */
export function fitLayoutLine(line: string, width: number): string {
	width = layoutSize(width);
	if (width === 0) return "";
	const lineWidth = visibleWidth(line);
	const clipped = lineWidth > width ? truncateToWidth(line, width) : line;
	const clippedWidth = lineWidth > width ? visibleWidth(clipped) : lineWidth;
	return clipped + padding(Math.max(0, width - clippedWidth));
}

/** Paint one resolved layout decoration without ANSI serialization. */
export function paintLayoutDecoration(out: Out, decoration: LayoutDecorationRun): void {
	out.push(decoration.style ?? Style.NONE, decoration.text);
}

/**
 * Reusable exact-width row fitter. It preserves run styles while matching
 * legacy `truncateToWidth` + padding semantics without serializing ANSI.
 */
export class LayoutRowFitter {
	readonly rich = new RichText();
	private clip: Clip;
	private configuredWidth: number;
	private configuredEllipsis: Ellipsis;
	private configuredPad: boolean;
	private configuredFill: Style;

	constructor(width: number, ellipsis: Ellipsis = Ellipsis.Unicode, pad = true, fill: Style = Style.NONE) {
		this.configuredWidth = layoutSize(width);
		this.configuredEllipsis = ellipsis;
		this.configuredPad = pad;
		this.configuredFill = fill;
		this.clip = new Clip(this.rich, this.configuredWidth, ellipsis);
	}

	configure(
		width: number,
		ellipsis = this.configuredEllipsis,
		pad = this.configuredPad,
		fill = this.configuredFill,
	): void {
		const nextWidth = layoutSize(width);
		if (
			nextWidth === this.configuredWidth &&
			ellipsis === this.configuredEllipsis &&
			pad === this.configuredPad &&
			fill === this.configuredFill
		)
			return;
		this.configuredWidth = nextWidth;
		this.configuredEllipsis = ellipsis;
		this.configuredPad = pad;
		this.configuredFill = fill;
		this.clip = new Clip(this.rich, nextWidth, ellipsis);
	}

	paint(source: RichText, row: number, out: Out): void {
		this.rich.clear();
		source.replayRow(this.clip, row);
		this.clip.br();
		if (
			(source.rowWidth[row] ?? 0) > this.configuredWidth &&
			this.configuredEllipsis !== Ellipsis.Omit &&
			this.rich.runs > 0
		) {
			this.rich.style[this.rich.runs - 1] = Style.NONE;
		}
		const start = out instanceof RichText ? out.openWidth : 0;
		this.rich.replayRow(out, 0);
		if (!this.configuredPad) return;
		const used = out instanceof RichText ? out.openWidth - start : (this.rich.rowWidth[0] ?? 0);
		if (used < this.configuredWidth) {
			const fill = this.rich.style[this.rich.runs - 1] === Style.RESET ? Style.RESET : this.configuredFill;
			out.push(fill, spaces(this.configuredWidth - used));
		}
	}

	empty(out: Out): void {
		if (this.configuredPad && this.configuredWidth > 0) out.push(this.configuredFill, spaces(this.configuredWidth));
	}
}
