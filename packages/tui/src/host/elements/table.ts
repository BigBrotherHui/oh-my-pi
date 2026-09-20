import { spaces, takeCells } from "../../core/out";
import { cellWidth } from "../../core/richtext";
import { Attr } from "../../core/style";
import type { ThemeColor } from "../../theme/schema";
import { allocateLayout } from "../layout";
import { registerElement } from "../registry";
import { Damage, type ElementImpl, type LayoutProps } from "../types";

/** Plain content and optional semantic color for one table cell. */
export interface TableCell {
	readonly text: string;
	readonly color?: ThemeColor;
	readonly bold?: boolean;
	/** Span adjacent columns without influencing their intrinsic widths. */
	readonly span?: number;
}

/** Data cells or a full-width separator in a native table. */
export type TableRow = readonly (TableCell | string)[] | { readonly rule: true; readonly color?: ThemeColor };

/** Flex-like sizing and text policy for one table column. */
export interface TableColumn extends LayoutProps {
	/** Measure this column from its non-spanning cells before flex allocation. */
	readonly intrinsic?: boolean;
	readonly align?: "left" | "right";
	readonly overflow?: "clip" | "ellipsis";
}

/** Props for a run-native table. */
export interface TableProps {
	readonly columns: readonly TableColumn[];
	readonly rows: readonly TableRow[];
	readonly gap?: number;
}

function singleLine(text: string): string {
	return text.replace(/\t/g, " ").replace(/[\r\n]+/g, " ");
}

function fit(text: string, width: number, overflow: TableColumn["overflow"]): string {
	if (width <= 0) return "";
	if (cellWidth(text) <= width) return text;
	if (overflow === "clip" || width === 1) return takeCells(text, width);
	return `${takeCells(text, width - 1)}…`;
}

function dataRow(row: TableRow): row is readonly (TableCell | string)[] {
	return Array.isArray(row);
}

function cellSpan(cell: TableCell | string, remaining: number): number {
	const span = typeof cell === "string" ? 1 : (cell.span ?? 1);
	return Math.min(remaining, Number.isFinite(span) ? Math.max(1, Math.trunc(span)) : 1);
}

function measuredColumns(props: TableProps): readonly TableColumn[] {
	if (!props.columns.some(column => column.intrinsic && column.width === undefined)) return props.columns;
	const natural = props.columns.map(() => 0);
	for (const row of props.rows) {
		if (!dataRow(row)) continue;
		let index = 0;
		for (const cell of row) {
			if (index >= props.columns.length) break;
			const span = cellSpan(cell, props.columns.length - index);
			const column = props.columns[index]!;
			if (span === 1 && column.intrinsic && column.width === undefined)
				natural[index] = Math.max(
					natural[index]!,
					cellWidth(singleLine(typeof cell === "string" ? cell : cell.text)),
				);
			index += span;
		}
	}
	return props.columns.map((column, index) =>
		column.intrinsic && column.width === undefined ? { ...column, width: natural[index] } : column,
	);
}

const tableElement: ElementImpl = {
	tag: "table",
	propDamage: name =>
		name === "color" || name === "background" || name === "style" || name === "recipe" ? Damage.Paint : Damage.Layout,
	paint(node, out, width, ctx) {
		const props = node.props as unknown as TableProps;
		const gap = Math.max(0, Math.trunc(props.gap ?? 1));
		const widths = allocateLayout(
			measuredColumns(props),
			Math.max(0, width - gap * Math.max(0, props.columns.length - 1)),
		);
		const base = ctx.styleOf(node);
		for (const row of props.rows) {
			if (!dataRow(row)) {
				out.push(row.color ? ctx.theme.style(row.color).over(base) : base, "─".repeat(Math.max(0, width)));
				out.br();
				continue;
			}
			let sourceIndex = 0;
			for (let index = 0; index < props.columns.length;) {
				if (index > 0) out.push(base, spaces(gap));
				const column = props.columns[index]!;
				const source = row[sourceIndex++] ?? "";
				const cell = typeof source === "string" ? undefined : source;
				const span = cellSpan(source, props.columns.length - index);
				let allocated = gap * (span - 1);
				for (let offset = 0; offset < span; offset++) allocated += widths[index + offset] ?? 0;
				const text = fit(
					singleLine(typeof source === "string" ? source : source.text),
					allocated,
					column.overflow ?? "ellipsis",
				);
				const padding = spaces(Math.max(0, allocated - cellWidth(text)));
				let style = cell?.color ? ctx.theme.style(cell.color).over(base) : base;
				if (cell?.bold) style = style.plus(Attr.Bold);
				out.push(style, column.align === "right" ? `${padding}${text}` : `${text}${padding}`);
				index += span;
			}
			out.br();
		}
	},
};

registerElement(tableElement);
