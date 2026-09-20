import type { Out } from "../core/richtext";
import {
	INTRINSIC_WIDTH,
	type HostElement,
	type HostNode,
	type LayoutHeight,
	type LayoutProps,
	type PaintContext,
} from "./types";

/** One normalized child constraint consumed by the row allocator. */
export interface LayoutAllocation {
	readonly width?: number;
	readonly grow?: number;
	readonly shrink?: number;
	readonly minWidth?: number;
	readonly maxWidth?: number;
	readonly overflowPriority?: number;
}

function cells(value: number | undefined, fallback = 0): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.trunc(value));
}

function weight(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, value);
}

function maximum(item: LayoutAllocation, minimum: number): number {
	return item.maxWidth === undefined ? Number.MAX_SAFE_INTEGER : Math.max(minimum, cells(item.maxWidth));
}

function overflowPriority(item: LayoutAllocation): number {
	return item.overflowPriority === undefined || !Number.isFinite(item.overflowPriority)
		? Number.MAX_SAFE_INTEGER
		: item.overflowPriority;
}

function distributeGrowth(
	items: readonly LayoutAllocation[],
	sizes: number[],
	maximums: readonly number[],
	remaining: number,
): void {
	let active = items
		.map((item, index) => ({ index, weight: weight(item.grow, item.width === undefined ? 1 : 0) }))
		.filter(entry => entry.weight > 0 && sizes[entry.index]! < maximums[entry.index]!);
	while (remaining > 0 && active.length > 0) {
		const totalWeight = active.reduce((sum, entry) => sum + entry.weight, 0);
		let granted = 0;
		for (const entry of active) {
			const capacity = maximums[entry.index]! - sizes[entry.index]!;
			const proportional = Math.floor((remaining * entry.weight) / totalWeight);
			const share = Math.min(capacity, Math.max(1, proportional), remaining - granted);
			if (share <= 0) continue;
			sizes[entry.index]! += share;
			granted += share;
			if (granted === remaining) break;
		}
		if (granted === 0) return;
		remaining -= granted;
		active = active.filter(entry => sizes[entry.index]! < maximums[entry.index]!);
	}
}

function distributeShrink(
	items: readonly LayoutAllocation[],
	sizes: number[],
	minimums: readonly number[],
	deficit: number,
): number {
	let active = items
		.map((item, index) => ({ index, weight: weight(item.shrink, item.width === undefined ? 1 : 0) }))
		.filter(entry => entry.weight > 0 && sizes[entry.index]! > minimums[entry.index]!);
	while (deficit > 0 && active.length > 0) {
		const priority = Math.min(...active.map(entry => overflowPriority(items[entry.index]!)));
		const tier = active.filter(entry => overflowPriority(items[entry.index]!) === priority);
		const totalWeight = tier.reduce((sum, entry) => sum + entry.weight, 0);
		let removed = 0;
		for (const entry of tier) {
			const capacity = sizes[entry.index]! - minimums[entry.index]!;
			const proportional = Math.floor((deficit * entry.weight) / totalWeight);
			const share = Math.min(capacity, Math.max(1, proportional), deficit - removed);
			if (share <= 0) continue;
			sizes[entry.index]! -= share;
			removed += share;
			if (removed === deficit) break;
		}
		if (removed === 0) break;
		deficit -= removed;
		active = active.filter(entry => sizes[entry.index]! > minimums[entry.index]!);
	}
	return deficit;
}

/** Allocate exact integer cell widths using flex-like basis, grow, shrink, and min/max constraints. */
export function allocateLayout(items: readonly LayoutAllocation[], available: number): number[] {
	const budget = cells(available);
	const minimums = items.map(item => cells(item.minWidth));
	const maximums = items.map((item, index) => maximum(item, minimums[index]!));
	const sizes = items.map((item, index) => {
		const basis = item.width === undefined ? minimums[index]! : cells(item.width);
		return Math.max(minimums[index]!, Math.min(maximums[index]!, basis));
	});
	const used = sizes.reduce((sum, size) => sum + size, 0);
	if (used < budget) {
		distributeGrowth(items, sizes, maximums, budget - used);
		return sizes;
	}
	if (used === budget) return sizes;

	let deficit = distributeShrink(items, sizes, minimums, used - budget);
	// Unsatisfiable minima still must not overrun the terminal row. Explicitly
	// droppable children collapse by ascending priority before mandatory minima.
	const order = items
		.map((item, index) => ({ index, priority: overflowPriority(item) }))
		.sort((a, b) => a.priority - b.priority || b.index - a.index);
	for (const { index } of order) {
		if (deficit === 0) break;
		const reduction = Math.min(sizes[index]!, deficit);
		sizes[index]! -= reduction;
		deficit -= reduction;
	}
	return sizes;
}

/** Content width excludes alignment fill, which must not steal sibling label columns. */
export function intrinsicWidthOf(node: HostNode): number {
	const explicit = layoutPropsOf(node).width;
	if (explicit !== undefined) return cells(explicit);
	if (node[INTRINSIC_WIDTH] !== undefined) return node[INTRINSIC_WIDTH];
	let width = 0;
	for (const row of node.cache.rowWidth) width = Math.max(width, row);
	return width;
}

/** Maximum content width of vertically stacked children without allocating a measurement array. */
export function intrinsicStackWidth(children: readonly HostNode[]): number {
	let width = 0;
	for (const child of children) width = Math.max(width, intrinsicWidthOf(child));
	return width;
}

const EMPTY_LAYOUT: LayoutProps = {};

/** Read the universal layout constraints stored directly on a retained child node. */
export function layoutPropsOf(node: HostNode): LayoutProps {
	return node.kind === "element" ? (node.props as LayoutProps) : EMPTY_LAYOUT;
}

/** Resolve fixed rows or a parent's remaining allocation without imposing a bound on natural flow. */
export function resolveLayoutHeight(
	height: LayoutHeight | undefined,
	available: number | undefined,
): number | undefined {
	const value = height === "fill" ? available : height;
	return value === undefined ? undefined : cells(value);
}

function verticalGrow(node: HostNode): number {
	if (node.kind === "text" || typeof node.props.height === "number") return 0;
	return weight(layoutPropsOf(node).grow, node.props.height === "fill" ? 1 : 0);
}

/** Paint vertical flow, allocating bounded remaining rows to growing children without copying measurement frames. */
export function paintVerticalChildren(
	node: HostElement,
	out: Out,
	width: number,
	ctx: PaintContext,
	height?: number,
	gap = 0,
): void {
	let fixedRows = 0;
	let visible = 0;
	let totalGrow = 0;
	for (const child of node.children) {
		const grow = height === undefined ? 0 : verticalGrow(child);
		if (grow > 0) {
			totalGrow += grow;
			visible++;
		} else {
			const rows = ctx.measureChild(child, width, height === undefined ? undefined : null);
			fixedRows += rows;
			if (rows > 0) visible++;
		}
	}
	let remaining = height === undefined ? 0 : Math.max(0, height - fixedRows - Math.max(0, visible - 1) * gap);
	let row = 0;
	let painted = 0;
	for (const child of node.children) {
		const grow = height === undefined ? 0 : verticalGrow(child);
		let rows: number;
		if (grow > 0) {
			rows = Math.floor((remaining * grow) / totalGrow);
			remaining -= rows;
			totalGrow -= grow;
			ctx.measureChild(child, width, rows);
		} else {
			rows = child.cache.rows;
		}
		if (rows === 0) continue;
		if (painted > 0) {
			const spacing = height === undefined ? gap : Math.min(gap, Math.max(0, height - row));
			for (let index = 0; index < spacing; index++) out.br();
			row += spacing;
		}
		const shown = height === undefined ? rows : Math.min(rows, Math.max(0, height - row));
		ctx.placeChild(child, {
			row,
			col: 0,
			width,
			height: rows,
			...(height === undefined ? {} : { clip: { row: 0, col: 0, width, height } }),
		});
		const contentRows = Math.min(shown, child.cache.rows);
		child.cache.replay(out, 0, contentRows);
		for (let index = contentRows; index < shown; index++) out.br();
		row += shown;
		painted++;
	}
	if (height !== undefined) while (row++ < height) out.br();
}
