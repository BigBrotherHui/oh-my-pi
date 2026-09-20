/**
 * Retained host tree contract (Architecture Contract v1 §2). Host nodes are
 * the terminal presentation: elements, text runs, and per-node paint caches.
 * Application code never touches these; elements and the compositor do.
 */
import type { Owner } from "solid-js";
import type { Out, RichText } from "../core/richtext";
import type { Style } from "../core/style";
import type { StyleProps } from "../style/types";
import type { Theme } from "../theme/theme";

/** Invalidation classes; `markDamage` bubbles them toward the root. */
export const enum Damage {
	None = 0,
	/** Style/paint only: colors, attrs, fixed-width glyphs. */
	Paint = 1,
	/** Text content changed: remeasure; escalates to Layout when the row count changes. */
	Text = 2,
	/** Geometry: padding, sizes, child insert/remove/move, width epoch. */
	Layout = 4,
	/** Hyperlink target only. */
	Link = 8,
	/** Focus/selection state. */
	Interaction = 16,
}

export type HostNodeKind = "element" | "text";

/** Cached content width before alignment padding or flex growth. */
export const INTRINSIC_WIDTH = Symbol("host.intrinsicWidth");
/** Paint time retained when a transcript subtree becomes immutable history. */
export const FROZEN_AT = Symbol("host.frozenAt");

export interface HostNodeBase {
	[INTRINSIC_WIDTH]?: number;
	[FROZEN_AT]?: number;
	readonly id: number;
	readonly kind: HostNodeKind;
	parent: HostElement | null;
	damage: Damage;
	/** Width-keyed paint cache replayed while the subtree is clean. */
	cache: RichText;
	cacheWidth: number;
	cacheHeight?: number;
	cacheEpoch: number;
}

export interface HostText extends HostNodeBase {
	readonly kind: "text";
	text: string;
}

/** Parent-local geometry retained alongside the subtree's paint cache. */
export interface PaintPlacement {
	readonly row: number;
	readonly col: number;
	readonly width: number;
	readonly height?: number;
	readonly clip?: { readonly row: number; readonly col: number; readonly width: number; readonly height: number };
}

/** Internal placement cache owned by each retained element. */
export const PAINT_PLACEMENTS = Symbol("host.paintPlacements");
/** Internal active parent while a paint context records child geometry. */
export const ACTIVE_PAINT_NODE = Symbol("host.activePaintNode");
/** Creation owner preserved for deferred width-dependent views and their context providers. */
export const HOST_OWNER = Symbol("host.owner");
/** Stable clipboard destination owned by a retained input element. */
export const INPUT_TARGET = Symbol("host.inputTarget");

/** Clipboard delivery and optional asynchronous reservation for a focused surface. */
export interface InputTarget {
	pasteText(text: string): void;
	beginPaste?(): (text: string | undefined) => boolean;
}

export interface HostElement extends HostNodeBase {
	[PAINT_PLACEMENTS]?: Map<HostNode, PaintPlacement>;
	[INPUT_TARGET]?: InputTarget;
	readonly [HOST_OWNER]?: Owner | null;
	readonly kind: "element";
	readonly tag: string;
	props: Record<string, unknown>;
	children: HostNode[];
	/** Changes only when the universal renderer inserts, removes, or moves direct children. */
	childrenVersion?: number;
	/** JSX-valued props (title/prefix slots): adopted nodes parented here but not in `children`. */
	slots: Map<string, HostNode[]>;
	impl: ElementImpl;
	/** Element-private retained state (parsers, PTY handles, ledgers). */
	state: unknown;
}

export type HostNode = HostElement | HostText;

/** Fixed terminal rows or the remaining allocation supplied by native layout. */
export type LayoutHeight = number | "fill";

/** Services an element sees while painting; never a `Theme` string API. */
export interface PaintContext {
	[ACTIVE_PAINT_NODE]?: HostElement;
	readonly theme: Theme;
	readonly widthEpoch: number;
	/** Vertical allocation supplied by the containing native layout, when bounded. */
	readonly availableHeight: number | undefined;
	/** Frozen wall clock for rows that will be committed; live clock otherwise. */
	readonly now: number;
	/** Resolved cascade style for `node` (§4). */
	styleOf(node: HostElement): Style;
	/** Cache-aware child paint: replays `child.cache` when clean at `width`. */
	paintChild(child: HostNode, out: Out, width: number, height?: number | null): void;
	/** Measure through the same cache without replaying runs; null clears the inherited height. */
	measureChild(child: HostNode, width: number, height?: number | null): number;
	/** Override a child's local painted position after padding, pane allocation or scrolling. */
	placeChild(child: HostNode, placement: PaintPlacement): void;
	/** Paint inline children (span/br/cursor/raw/text) of `node` over `base`. */
	paintInlineChildren(node: HostElement, out: Out, base: Style): void;
	/** Paint one inline child over `base` (separator-aware elements iterate children themselves). */
	paintInlineChild(child: HostNode, out: Out, base: Style): void;
	/** Record the rows `node` occupied in the current paint (hit-testing, focus scrolling). */
	recordSpan?(
		node: HostElement,
		row: number,
		count: number,
		col?: number,
		width?: number,
		originRow?: number,
		originCol?: number,
	): void;
}

/** Host services available to an element on attach. */
export interface HostContext {
	readonly theme: Theme;
	/** Request a repaint/relayout of `node` after an external event (PTY frame, image ledger). */
	invalidate(node: HostElement, damage: Damage): void;
	/** Shared root clock subscription; returns an unsubscribe. */
	subscribeClock(cadence: ClockCadence, listener: (now: number) => void): () => void;
	/** Revalidate a resource-dependent element on each scheduled paint, without scheduling idle frames. */
	trackFrameDependency(node: HostElement): () => void;
}

export type ClockCadence = "frame" | "spinner" | "second";

/**
 * Behaviour of one element tag. Lives below the application boundary:
 * feature views compose the vocabulary, they never implement this.
 */
export interface ElementImpl {
	readonly tag: string;
	/** JSX-valued properties whose accessors must resolve under a retained binding. */
	readonly slots?: readonly string[];
	/** Inline elements paint runs into a text row instead of producing rows. */
	readonly inline?: boolean;
	/** Damage class for a prop change (default `Damage.Layout`). */
	propDamage(name: string): Damage;
	/** Cascade layer "defaults" for this tag. */
	readonly defaultStyle?: StyleProps;
	/** Cascade layer "variant/state" derived from the node's current props/state. */
	variantStyle?(node: HostElement): StyleProps | undefined;
	/** Paint rows at `width`; children MUST go through `ctx.paintChild`. */
	paint(node: HostElement, out: Out, width: number, ctx: PaintContext): void;
	paintInline?(node: HostElement, out: Out, base: Style, ctx: PaintContext): void;
	/** Optional row count without painting. */
	measure?(node: HostElement, width: number, ctx: PaintContext): number;
	onAttach?(node: HostElement, ctx: HostContext): void;
	/** Deliver literal clipboard text to the retained input without interpreting it as keys. */
	pasteText?(node: HostElement, text: string): void;
	/** Expose a native editor's identity to host clipboard and keyboard routing. */
	inputTarget?(node: HostElement): InputTarget;
	onDetach?(node: HostElement): void;
	/** Deepest descendant covering (row, col) within `node`'s last painted rows, or null. */
	hitTest?(node: HostElement, row: number, col: number): HostElement | null;
}

/** Layout props any element may carry inside a `row`/`stack`. */
export interface LayoutProps {
	readonly grow?: number;
	readonly shrink?: number;
	readonly width?: number;
	readonly minWidth?: number;
	readonly maxWidth?: number;
	/** Higher-priority children retain their allocation before lower-priority siblings overflow. */
	readonly overflowPriority?: number;
}
