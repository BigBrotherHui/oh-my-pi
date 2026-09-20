import { spaces, takeCells } from "../../core/out";
import { cellWidth, type Out } from "../../core/richtext";
import { type Color, Style } from "../../core/style";
import { scrollbarThumbRange } from "../../components/scroll-viewport";
import type { ThemeBg, ThemeColor } from "../../theme/schema";
import { registerElement } from "../registry";
import { Damage, type ElementImpl, type HostElement, type PaintContext } from "../types";

const PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

/** One option rendered by the controlled select host. */
export interface SelectOption {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
	readonly icon?: string;
	/** Dim secondary text shown only on the selected row. */
	readonly hint?: string;
	readonly disabled?: boolean;
	/** Semantic color for an unselected option, such as an enabled multiselect entry. */
	readonly color?: ThemeColor;
}

/** Props for a controlled select viewport. */
export interface SelectProps {
	readonly options: readonly SelectOption[];
	readonly value?: string;
	readonly selectedIndex?: number;
	/** Non-selected row currently under the pointer. */
	readonly hoveredIndex?: number;
	/** First rendered option. The owner keeps this aligned with selection. */
	readonly offset?: number;
	readonly maxRows?: number;
	/** Fixed label-column width, including the inter-column gap. */
	readonly primaryColumnWidth?: number;
	readonly emptyText?: string;
	/** Foreground for disabled rows; defaults to `dim`. */
	readonly disabledColor?: ThemeColor | Color;
	/** Background applied to non-selected hovered rows. */
	readonly hoverBackground?: ThemeBg | Color;
	/** Extend the hover background through the unused row width. Defaults to true. */
	readonly hoverFill?: boolean;
	/** Overflow scrollbar chrome, matching the shared `<scroll>` vocabulary. */
	readonly trackColor?: ThemeColor | Color;
	readonly thumbColor?: ThemeColor | Color;
	readonly trackChar?: string;
	readonly thumbChar?: string;
}

interface RowSegment {
	readonly style: Style;
	readonly text: string;
}

interface SelectPaintStyles {
	readonly selected: Style;
	readonly disabled: Style;
	readonly hover: Style;
	readonly hoverFill: boolean;
}

function singleLine(value: string): string {
	return value
		.replace(/\t/g, " ")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function clipped(value: string, width: number): string {
	if (width <= 0) return "";
	if (cellWidth(value) <= width) return value;
	if (width === 1) return "…";
	return `${takeCells(value, width - 1)}…`;
}

function glyph(value: string | undefined, fallback: string): string {
	const first = Array.from(value ?? fallback)[0] ?? fallback;
	return cellWidth(first) === 1 ? first : fallback;
}

function primaryColumnWidth(options: readonly SelectOption[], requested: number | undefined): number {
	if (requested !== undefined && Number.isFinite(requested)) return Math.max(1, Math.trunc(requested));
	let widest = 1;
	for (const option of options)
		widest = Math.max(widest, cellWidth(singleLine(option.label || option.value)) + PRIMARY_COLUMN_GAP);
	return Math.min(PRIMARY_COLUMN_WIDTH, widest);
}

function iconColumnWidth(options: readonly SelectOption[]): number {
	let widest = 0;
	for (const option of options) {
		if (option.icon) widest = Math.max(widest, cellWidth(singleLine(option.icon)));
	}
	return widest;
}

function colorStyle(
	color: ThemeColor | Color | undefined,
	fallback: ThemeColor,
	ctx: PaintContext,
	base: Style,
): Style {
	return (typeof color === "number" ? Style.of({ fg: color }) : ctx.theme.style(color ?? fallback)).over(base);
}

function backgroundStyle(color: ThemeBg | Color, ctx: PaintContext, base: Style): Style {
	return Style.of({ bg: typeof color === "number" ? color : ctx.theme.bgColor(color) }).over(base);
}

function pushSegments(out: Out, segments: readonly RowSegment[], width: number, fill: Style): void {
	const safeWidth = Math.max(0, width);
	let totalWidth = 0;
	for (const segment of segments) totalWidth += cellWidth(segment.text);
	const contentWidth = totalWidth > safeWidth ? Math.max(0, safeWidth - 1) : safeWidth;
	let written = 0;
	let lastStyle = fill;
	for (const segment of segments) {
		if (written >= contentWidth) break;
		const text = takeCells(segment.text, contentWidth - written);
		if (text.length === 0) continue;
		out.push(segment.style, text);
		written += cellWidth(text);
		lastStyle = segment.style;
	}
	if (totalWidth > safeWidth && safeWidth > 0) {
		out.push(lastStyle, "…");
		written++;
	}
	if (written < safeWidth) out.push(fill, spaces(safeWidth - written));
}

function rowSegments(
	option: SelectOption,
	selected: boolean,
	hovered: boolean,
	width: number,
	primaryWidth: number,
	iconWidth: number,
	ctx: PaintContext,
	base: Style,
	styles: SelectPaintStyles,
): { segments: readonly RowSegment[]; fill: Style } {
	const normalStyle = option.color ? ctx.theme.style(option.color).over(base) : base;
	const rowStyle = option.disabled
		? styles.disabled
		: selected
			? styles.selected
			: hovered
				? styles.hover
				: normalStyle;
	const mutedStyle = ctx.theme.style("muted").over(rowStyle);
	const hintStyle = ctx.theme.style("dim").over(rowStyle);
	const cursor = ctx.theme.nav.cursor;
	const prefix = selected ? `${cursor} ` : spaces(cellWidth(cursor) + 1);
	const icon = option.icon ? singleLine(option.icon) : "";
	const iconCell = iconWidth > 0 ? `${icon}${spaces(Math.max(0, iconWidth - cellWidth(icon)) + 1)}` : "";
	const prefixWidth = cellWidth(prefix) + cellWidth(iconCell);
	const label = singleLine(option.label || option.value);
	const description = option.description ? singleLine(option.description) : "";
	const hint = selected && option.hint ? `  ${singleLine(option.hint)}` : "";
	const hintWidth = cellWidth(hint);
	const segments: RowSegment[] = [
		{ style: rowStyle, text: prefix },
		{ style: rowStyle, text: iconCell },
	];

	if (description && width > 40) {
		const effectivePrimaryWidth = Math.max(1, Math.min(primaryWidth, width - prefixWidth - 4));
		const labelWidth = Math.max(1, effectivePrimaryWidth - PRIMARY_COLUMN_GAP);
		const primary = clipped(label, labelWidth);
		const gap = spaces(Math.max(1, effectivePrimaryWidth - cellWidth(primary)));
		const remainingWidth = width - prefixWidth - cellWidth(primary) - cellWidth(gap) - hintWidth - 2;
		if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
			segments.push({ style: rowStyle, text: primary });
			segments.push({
				style: selected || option.disabled ? rowStyle : mutedStyle,
				text: `${gap}${clipped(description, remainingWidth)}`,
			});
			if (hint) segments.push({ style: hintStyle, text: hint });
			return { segments, fill: hovered && !selected && !option.disabled && !styles.hoverFill ? base : rowStyle };
		}
	}

	segments.push({ style: rowStyle, text: clipped(label, Math.max(0, width - prefixWidth - hintWidth - 2)) });
	if (hint) segments.push({ style: hintStyle, text: hint });
	return { segments, fill: hovered && !selected && !option.disabled && !styles.hoverFill ? base : rowStyle };
}

/** Paint controlled selection state for both a `<select>` node and editor autocomplete popup. */
export function paintSelect(props: SelectProps, out: Out, width: number, ctx: PaintContext, base: Style): void {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
	const requestedRows = props.maxRows ?? props.options.length;
	const maxRows = Number.isFinite(requestedRows) ? Math.max(0, Math.trunc(requestedRows)) : 0;
	if (props.options.length === 0) {
		out.push(ctx.theme.style("dim").over(base), clipped(props.emptyText ?? "No options", safeWidth));
		out.br();
		return;
	}

	const valueIndex = props.value === undefined ? -1 : props.options.findIndex(option => option.value === props.value);
	const requestedSelected = props.selectedIndex ?? 0;
	const selectedIndex =
		valueIndex >= 0
			? valueIndex
			: Number.isFinite(requestedSelected)
				? Math.max(0, Math.min(props.options.length - 1, Math.trunc(requestedSelected)))
				: 0;
	const requestedOffset = props.offset ?? 0;
	const offset = Number.isFinite(requestedOffset)
		? Math.max(0, Math.min(Math.trunc(requestedOffset), Math.max(0, props.options.length - maxRows)))
		: 0;
	const overflow = maxRows > 0 && props.options.length > maxRows;
	const contentWidth = Math.max(0, safeWidth - (overflow ? 1 : 0));
	const primaryWidth = primaryColumnWidth(props.options, props.primaryColumnWidth);
	const iconsWidth = iconColumnWidth(props.options);
	const styles: SelectPaintStyles = {
		selected: ctx.theme.style("accent").over(base),
		disabled: colorStyle(props.disabledColor, "dim", ctx, base),
		hover:
			props.hoverBackground === undefined
				? ctx.theme.style("accent").over(base)
				: backgroundStyle(props.hoverBackground, ctx, base),
		hoverFill: props.hoverFill !== false,
	};
	const thumb = overflow ? scrollbarThumbRange(maxRows, props.options.length, offset) : undefined;
	const trackStyle = colorStyle(props.trackColor, "dim", ctx, base);
	const thumbStyle = colorStyle(props.thumbColor, "accent", ctx, base);
	const track = glyph(props.trackChar, "│");
	const thumbGlyph = glyph(props.thumbChar, "█");

	for (let row = 0; row < maxRows && offset + row < props.options.length; row++) {
		const index = offset + row;
		const option = props.options[index]!;
		const rendered = rowSegments(
			option,
			index === selectedIndex,
			index === props.hoveredIndex && index !== selectedIndex,
			contentWidth,
			primaryWidth,
			iconsWidth,
			ctx,
			base,
			styles,
		);
		pushSegments(out, rendered.segments, contentWidth, rendered.fill);
		if (overflow)
			out.push(
				thumb && row >= thumb.start && row < thumb.end ? thumbStyle : trackStyle,
				thumb && row >= thumb.start && row < thumb.end ? thumbGlyph : track,
			);
		out.br();
	}
}

function selectDamage(name: string): Damage {
	if (
		name === "value" ||
		name === "selectedIndex" ||
		name === "hoveredIndex" ||
		name === "offset" ||
		name === "disabledColor" ||
		name === "hoverBackground" ||
		name === "hoverFill" ||
		name === "trackColor" ||
		name === "thumbColor" ||
		name === "trackChar" ||
		name === "thumbChar"
	) {
		return Damage.Paint;
	}
	return Damage.Layout;
}

const selectElement: ElementImpl = {
	tag: "select",
	propDamage: selectDamage,
	paint(node: HostElement, out: Out, width: number, ctx: PaintContext) {
		paintSelect(node.props as unknown as SelectProps, out, width, ctx, ctx.styleOf(node));
	},
};

registerElement(selectElement);
