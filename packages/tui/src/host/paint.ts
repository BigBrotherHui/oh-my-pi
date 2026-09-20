import { RichText, type Out } from "../core/richtext";
import { Style } from "../core/style";
import { instrument } from "../instrumentation";
import { markDamage } from "./damage";
import type { HostRoot } from "./node";
import {
	ACTIVE_PAINT_NODE,
	FROZEN_AT,
	PAINT_PLACEMENTS,
	Damage,
	type HostElement,
	type HostNode,
	type PaintContext,
} from "./types";

/** Resolve the computed style for one host element. */
export type HostStyleResolver = (node: HostElement) => Style;

/** Optional frame-local services added to a paint context. */
export interface PaintContextOptions {
	readonly now?: number;
	readonly availableHeight?: number;
	readonly recordSpan?: (
		node: HostElement,
		row: number,
		count: number,
		col?: number,
		width?: number,
		originRow?: number,
		originCol?: number,
	) => void;
}

interface DownstreamOut extends Out {
	readonly downstream: Out;
}

function outputRow(out: Out): number {
	let current = out;
	while (true) {
		if (current instanceof RichText) return current.rows;
		if (!("downstream" in current)) return 0;
		current = (current as DownstreamOut).downstream;
	}
}

function pushText(out: Out, style: Style, text: string): void {
	let start = 0;
	for (;;) {
		const newline = text.indexOf("\n", start);
		if (newline === -1) {
			if (start < text.length) out.push(style, start === 0 ? text : text.slice(start));
			return;
		}
		if (newline > start) out.push(style, text.slice(start, newline));
		out.br();
		start = newline + 1;
	}
}

function paintInlineNode(node: HostNode, out: Out, base: Style, ctx: PaintContext): void {
	if (node.kind === "text") {
		pushText(out, base, node.text);
		node.damage = Damage.None;
		return;
	}
	if (node.impl.inline !== true || node.impl.paintInline === undefined) {
		throw new Error(`Host element <${node.tag}> is not inline content`);
	}
	instrument.paint();
	ctx.styleOf(node);
	node.damage = Damage.None;
	node.impl.paintInline(node, out, base, ctx);
}

/** Construct cache-aware paint services and parent-relative placement recording. */
export function createPaintContext(
	root: HostRoot,
	styleOf: HostStyleResolver,
	options: PaintContextOptions = {},
): PaintContext {
	let availableHeight = options.availableHeight;
	const childCache = (child: HostNode, width: number, height: number | null | undefined): RichText => {
		const previousHeight = availableHeight;
		availableHeight = height === null ? undefined : height;
		try {
			cacheNode(child, width, context);
			return child.cache;
		} finally {
			availableHeight = previousHeight;
		}
	};
	const context: PaintContext = {
		get theme() {
			return root.theme;
		},
		get widthEpoch() {
			return root.widthEpoch;
		},
		get availableHeight() {
			return availableHeight;
		},
		get now() {
			return context[ACTIVE_PAINT_NODE]?.[FROZEN_AT] ?? options.now ?? 0;
		},
		styleOf,
		paintChild(child, out, width, height = availableHeight) {
			const row = outputRow(out);
			childCache(child, width, height).replay(out);
			context.placeChild(child, { row, col: 0, width, height: child.cache.rows });
		},
		measureChild(child, width, height = availableHeight) {
			return childCache(child, width, height).rows;
		},
		placeChild(child, placement) {
			context[ACTIVE_PAINT_NODE]?.[PAINT_PLACEMENTS]?.set(child, placement);
		},
		paintInlineChild(child, out, base) {
			paintInlineNode(child, out, base, context);
		},
		paintInlineChildren(node, out, base) {
			for (const child of node.children) context.paintInlineChild(child, out, base);
		},
		recordSpan: options.recordSpan,
	};
	return context;
}

/** Paint into a node-local cache before replay, so layout coordinates never depend on an ancestor's scratch sink. */
export function paintNode(node: HostNode, out: Out, width: number, ctx: PaintContext): void {
	cacheNode(node, width, ctx);
	node.cache.replay(out);
}

function cacheNode(node: HostNode, width: number, ctx: PaintContext): void {
	const parentTime = ctx[ACTIVE_PAINT_NODE]?.[FROZEN_AT];
	if (parentTime !== undefined) node[FROZEN_AT] = parentTime;
	if (
		node.damage === Damage.None &&
		node.cacheWidth === width &&
		node.cacheHeight === ctx.availableHeight &&
		node.cacheEpoch === ctx.widthEpoch
	)
		return;
	if (
		(node.damage & (Damage.Layout | Damage.Text)) !== 0 ||
		node.cacheWidth !== width ||
		node.cacheHeight !== ctx.availableHeight ||
		node.cacheEpoch !== ctx.widthEpoch
	) {
		instrument.layout();
	}
	instrument.paint();
	const damage = node.damage;
	if (node.kind === "element") ctx.styleOf(node);
	node.damage = Damage.None;
	node.cache.clear();
	const parent = ctx[ACTIVE_PAINT_NODE];
	try {
		if (node.kind === "text") {
			pushText(node.cache, node.parent === null ? Style.NONE : ctx.styleOf(node.parent), node.text);
		} else {
			const children = node[PAINT_PLACEMENTS];
			if (children) children.clear();
			else node[PAINT_PLACEMENTS] = new Map();
			ctx[ACTIVE_PAINT_NODE] = node;
			node.impl.paint(node, node.cache, width, ctx);
		}
		node.cache.finish();
		node.cacheWidth = width;
		node.cacheEpoch = ctx.widthEpoch;
		node.cacheHeight = ctx.availableHeight;
	} catch (error) {
		node.damage |= damage | Damage.Layout;
		node.cache.clear();
		throw error;
	} finally {
		ctx[ACTIVE_PAINT_NODE] = parent;
	}
}

interface Bounds {
	row: number;
	col: number;
	endRow: number;
	endCol: number;
}

interface PublishedSpans {
	current: Set<HostElement>;
	next: Set<HostElement>;
}

const publishedSpans = new WeakMap<HostRoot, PublishedSpans>();

function intersection(left: Bounds, right: Bounds): Bounds {
	return {
		row: Math.max(left.row, right.row),
		col: Math.max(left.col, right.col),
		endRow: Math.min(left.endRow, right.endRow),
		endCol: Math.min(left.endCol, right.endCol),
	};
}

/** Rebuild physical hit spans from retained local placements, including cached, clipped and shifted descendants. */
export function publishPaintSpans(
	root: HostRoot,
	ctx: PaintContext,
	rowOffset = 0,
	rows = Number.POSITIVE_INFINITY,
): void {
	const record = ctx.recordSpan;
	if (!record) return;
	let published = publishedSpans.get(root);
	if (!published) {
		published = { current: new Set(), next: new Set() };
		publishedSpans.set(root, published);
	}
	const visibleNodes = published.next;
	const visit = (node: HostNode, row: number, col: number, width: number, height: number, clip: Bounds): void => {
		if (node.kind === "text") return;
		const visible = intersection(clip, { row, col, endRow: row + height, endCol: col + width });
		if (visible.endRow <= visible.row || visible.endCol <= visible.col) return;
		visibleNodes.add(node);
		record(node, visible.row, visible.endRow - visible.row, visible.col, visible.endCol - visible.col, row, col);
		const children = node[PAINT_PLACEMENTS];
		if (!children) return;
		for (const [child, place] of children) {
			const childClip = place.clip
				? intersection(visible, {
						row: row + place.clip.row,
						col: col + place.clip.col,
						endRow: row + place.clip.row + place.clip.height,
						endCol: col + place.clip.col + place.clip.width,
					})
				: visible;
			visit(child, row + place.row, col + place.col, place.width, place.height ?? child.cache.rows, childClip);
		}
	};
	visit(root.node, rowOffset, 0, root.node.cacheWidth, root.node.cache.rows, {
		row: 0,
		col: 0,
		endRow: rows,
		endCol: root.node.cacheWidth,
	});
	for (const node of published.current) {
		if (!visibleNodes.has(node)) record(node, 0, 0, 0, 0);
	}
	published.current.clear();
	published.next = published.current;
	published.current = visibleNodes;
}

/** Paint a retained root and publish its hit spans unless the compositor will crop them afterward. */
export function paintHostTree(
	root: HostRoot,
	out: Out,
	width: number,
	ctx: PaintContext,
	options: { publishSpans?: boolean } = {},
): void {
	for (const node of root.frameDependencies) markDamage(node, Damage.Paint, { schedule: false });
	paintNode(root.node, out, width, ctx);
	if (options.publishSpans !== false) publishPaintSpans(root, ctx);
}
