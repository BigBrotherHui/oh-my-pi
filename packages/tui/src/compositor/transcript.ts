import * as logger from "@oh-my-pi/pi-utils/logger";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { Theme } from "../theme/theme";
import { emitRows } from "../core/emit";
import { type Out, RichText } from "../core/richtext";
import { handleHostNodeDetached } from "../host/focus";
import { forgetPaintSpan } from "../host/input";
import { markSubtreeDamage } from "../host/damage";
import { hostRootFor, hostSlotChildren } from "../host/node";
import {
	ACTIVE_PAINT_NODE,
	Damage,
	FROZEN_AT,
	HOST_OWNER,
	type HostElement,
	type HostNode,
	type PaintContext,
} from "../host/types";
import { freezeOwnerClock } from "../reactive/clock";
import type { HistoryBatch } from "../tui";

/** Presentation declaration captured when a transcript block is attached. */
export type TranscriptBlockMode = "mutable" | "appendOnly";

/** Immutable width-independent identity for one stable semantic row. */
export interface TranscriptStableRow {
	readonly key: string;
}

/** Reactive properties understood by the retained transcript-block element. */
export interface TranscriptBlockProps {
	/** Lazily activate the compact slot without changing the full history view. */
	readonly onCompact?: (compact: boolean) => void;
	/** Select an immutable semantic prefix in the retained stable slot. */
	readonly onStableRender?: (count: number) => void;
	/** Reset producer publication alongside a destructive history reset. */
	readonly onResetStableRows?: () => void;
	/** Measured start row within the current uncommitted transcript layout. */
	readonly onRowLayout?: (row: number) => void;
	/** Publish the live row budget remaining after surrounding terminal chrome. */
	readonly onAllocation?: (rows: number) => void;
	/** Lock removal when any part of the block enters a history transaction. */
	readonly onRetire?: () => void;
	/** Identify tool views eligible for compact presentation only while actively oversized. */
	readonly toolActivity?: boolean;
	readonly settled?: boolean;
	readonly mode?: TranscriptBlockMode;
	readonly stableRows?: readonly TranscriptStableRow[];
	readonly renderStableRows?: (count: number, width: number) => RichText;
}

/** A block lifecycle state exposed for diagnostics and contract tests. */
export type TranscriptBlockState = "active" | "settled" | "committed";

interface TranscriptEntry {
	node: HostElement;
	state: TranscriptBlockState;
	mode: TranscriptBlockMode;
	stableRows: readonly TranscriptStableRow[];
	renderedStableByWidth: Map<number, RichText>;
	stableRowCountByWidth: Map<number, Map<number, number>>;
	paintCache: RichText;
	renderCache: RichText;
	compactCache?: RichText;
	stableRenderCache?: LRUCache<string, RichText>;
	stableTheme?: Theme;
	stableEpoch?: number;
	emitted: number;
	stableFrozen: boolean;
	resourcesFrozen: boolean;
	paintedAt: number;
}

interface ViewportBlock {
	readonly entry: TranscriptEntry;
	readonly rendered: RichText;
	readonly emitted: number;
	readonly row: number;
	readonly rows: number;
	readonly compact: boolean;
}

type RetirementPolicy = "pressure" | "flush";
type Offered =
	| { batch: HistoryBatch; kind: "append"; entry: number; emittedEnd: number }
	| { batch: HistoryBatch; kind: "commit"; end: number }
	| { batch: HistoryBatch; kind: "replay" };

const MAX_LIVE_BLOCKS = 256;
const PINNED_FRONTIER_WARN_MS = 30_000;
const EMPTY_STABLE_ROWS: readonly TranscriptStableRow[] = [];
const EMPTY_STABLE_FRAME = new RichText();

function blockProps(node: HostElement): TranscriptBlockProps {
	return node.props as TranscriptBlockProps;
}

function copyRows(rows: RichText, start = 0, end = rows.rows): RichText {
	const copy = new RichText();
	rows.replay(copy, Math.max(0, start), Math.min(rows.rows, end));
	return copy;
}

function stablePrefix(prefix: readonly TranscriptStableRow[], rows: readonly TranscriptStableRow[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index]!.key !== rows[index]!.key) return false;
	}
	return true;
}

function directBlocks(node: HostElement): HostElement[] {
	const blocks: HostElement[] = [];
	for (const child of node.children) {
		if (child.kind === "element" && child.tag === "transcript-block") blocks.push(child);
	}
	return blocks;
}

function markInternalLayout(node: HostElement): void {
	let current: HostElement | null = node;
	while (current !== null) {
		current.damage |= Damage.Layout;
		current = current.parent;
	}
}

function freezeResources(entry: TranscriptEntry): void {
	if (entry.resourcesFrozen) return;
	entry.resourcesFrozen = true;
	entry.stableRenderCache?.clear();
	blockProps(entry.node).onStableRender?.(0);
	const owner = entry.node[HOST_OWNER];
	if (owner) freezeOwnerClock(owner, entry.paintedAt);
	const detach = (node: HostNode): void => {
		node[FROZEN_AT] = entry.paintedAt;
		if (node.kind === "text") return;
		for (const child of node.children) detach(child);
		for (const child of hostSlotChildren(node)) detach(child);
		forgetPaintSpan(node);
		handleHostNodeDetached(node);
		node.impl.onDetach?.(node);
	};
	detach(entry.node);
}

/** Whether `prefix` matches `rows` run-for-run from the top. */
export function isRowPrefix(prefix: RichText, rows: RichText): boolean {
	if (prefix.rows > rows.rows) return false;
	for (let index = 0; index < prefix.rows; index++) {
		if (!prefix.rowEquals(index, rows, index)) return false;
	}
	return true;
}

function isPlainBlankRow(rows: RichText, row: number): boolean {
	for (let run = rows.rowStart(row); run < rows.rowEnd[row]!; run++) {
		if (rows.flags[run] !== 0 || !rows.style[run]!.isNone || rows.text[run]!.trim().length > 0) return false;
	}
	return true;
}

/** Strip unstyled blank edges while preserving tinted cards and protocol rows. */
export function trimBlankEdges(rows: RichText, out: RichText = new RichText()): RichText {
	let start = 0;
	let end = rows.rows;
	while (start < end && isPlainBlankRow(rows, start)) start++;
	while (end > start && isPlainBlankRow(rows, end - 1)) end--;
	if (start === 0 && end === rows.rows) return rows;
	out.clear();
	rows.replay(out, start, end);
	return out;
}

/** Retained active/settled/committed policy for one transcript host element. */
export class TranscriptController {
	private readonly node: HostElement;
	private entries: TranscriptEntry[] = [];
	readonly #entryNodes = new Set<HostElement>();
	#childrenVersion = -1;
	private frontier = 0;
	#storeGeneration: unknown;
	private offered: Offered | undefined;
	private replayPending = false;
	private replayRequested = false;
	private capacity = Number.MAX_SAFE_INTEGER;
	private lastViewportRows = 0;
	private pinnedFrontier: { index: number; since: number; logged: boolean } | undefined;

	constructor(node: HostElement) {
		this.node = node;
	}

	#nextBatchId(): number {
		const root = hostRootFor(this.node);
		if (!root) throw new Error("Transcript history requires an attached retained root");
		return root.nextHistoryBatchId();
	}

	/** Update the live transcript allocation and invalidate only its cached ancestry. */
	setCapacity(rows: number): boolean {
		const next = Math.max(0, Math.trunc(rows));
		if (next === this.capacity) return false;
		this.capacity = next;
		for (let index = this.frontier; index < this.entries.length; index++)
			blockProps(this.entries[index]!.node).onAllocation?.(next);
		markInternalLayout(this.node);
		return true;
	}

	/** Rows produced by the latest viewport render. */
	get renderedRows(): number {
		return this.lastViewportRows;
	}

	/** Paint the bounded uncommitted tail into `out`. */
	paint(out: Out, width: number, ctx: PaintContext): void {
		if (this.capacity === Number.MAX_SAFE_INTEGER && ctx.availableHeight !== undefined)
			this.setCapacity(ctx.availableHeight);
		const rendered = this.renderViewport(width, this.capacity, ctx);
		rendered.replay(out);
		this.lastViewportRows = rendered.rows;
	}

	/** Offer stable heads or the shortest settled prefix required by viewport pressure. */
	peekFinalizedBatch(width: number, capacity: number, ctx: PaintContext): HistoryBatch | undefined {
		return this.peekBatch(width, capacity, "pressure", ctx);
	}

	/** Offer the complete currently eligible prefix for graceful shutdown. */
	peekFlushBatch(width: number, ctx: PaintContext): HistoryBatch | undefined {
		return this.peekBatch(width, 0, "flush", ctx);
	}

	/** Return only a prepared complete replay, never an ordinary retirement offer. */
	peekReplayBatch(width: number, ctx: PaintContext): HistoryBatch | undefined {
		this.syncEntries();
		this.settleFinalized();
		return this.prepareReplay(width, ctx);
	}

	/** Acknowledge exactly the most recently offered append, commit, or replay transaction. */
	acknowledgeHistory(id: number): void {
		const offered = this.offered;
		if (offered === undefined || offered.batch.id !== id) return;
		if (offered.kind === "append") {
			const entry = this.entries[offered.entry];
			if (entry === undefined || offered.entry !== this.frontier || offered.emittedEnd <= entry.emitted) return;
			entry.emitted = offered.emittedEnd;
		} else if (offered.kind === "commit") {
			for (let index = this.frontier; index < offered.end; index++) {
				const entry = this.entries[index]!;
				entry.state = "committed";
				entry.emitted = 0;
				freezeResources(entry);
			}
			this.frontier = offered.end;
		}
		this.offered = undefined;
		markInternalLayout(this.node);
		if (this.replayRequested) this.startReplay();
	}

	/** Prepare one atomic replay of committed rows and an emitted active-head prefix. */
	beginReplay(): void {
		this.syncEntries();
		if (this.offered !== undefined) {
			this.replayRequested = true;
			return;
		}
		this.startReplay();
	}

	/** Drop a pending replay so shutdown only flushes unretired rows. */
	cancelReplay(): void {
		this.replayPending = false;
		this.replayRequested = false;
	}

	/** Forget stable publication only when paired with a destructive display reset. */
	resetStableEmission(): void {
		this.syncEntries();
		if (this.offered?.kind === "append") this.offered = undefined;
		for (const entry of this.entries) {
			entry.emitted = 0;
			entry.stableRows = EMPTY_STABLE_ROWS;
			entry.renderedStableByWidth.clear();
			entry.stableRowCountByWidth.clear();
			entry.stableRenderCache?.clear();
			entry.stableFrozen = false;
			blockProps(entry.node).onResetStableRows?.();
		}
		markInternalLayout(this.node);
	}

	/** Render the complete semantic tail, clipped from the top to `maxRows`. */
	renderTail(width: number, maxRows: number, ctx: PaintContext): RichText {
		this.syncEntries();
		const cap = Math.max(0, Math.trunc(maxRows));
		const output = new RichText();
		if (cap === 0) return output;
		const blocks: RichText[] = [];
		let total = 0;
		for (let index = this.entries.length - 1; index >= 0; index--) {
			const block = this.renderEntry(this.entries[index]!, width, ctx);
			if (block.rows === 0) continue;
			total += block.rows + (blocks.length > 0 ? 1 : 0);
			blocks.unshift(copyRows(block));
			if (total >= cap) break;
		}
		for (const block of blocks) {
			if (output.rows > 0) output.br();
			block.replay(output);
		}
		return output.rows > cap ? copyRows(output, output.rows - cap) : output;
	}

	/** Current lifecycle state for each retained block. */
	blockStates(): readonly TranscriptBlockState[] {
		this.syncEntries();
		return this.entries.map(entry => entry.state);
	}

	/** Emitted stable semantic-row counts for each retained block. */
	emittedStableRows(): readonly number[] {
		this.syncEntries();
		return this.entries.map(entry => entry.emitted);
	}

	/** Release retained caches and offers owned by this transcript. */
	dispose(): void {
		this.entries = [];
		this.#entryNodes.clear();
		this.offered = undefined;
		this.replayPending = false;
		this.replayRequested = false;
	}

	private syncEntries(): void {
		if (this.#storeGeneration !== this.node.props.generation) {
			this.#storeGeneration = this.node.props.generation;
			this.#childrenVersion = -1;
			this.entries = [];
			this.#entryNodes.clear();
			this.frontier = 0;
			this.offered = undefined;
			this.replayPending = false;
			this.replayRequested = false;
			this.pinnedFrontier = undefined;
		}
		const version = this.node.childrenVersion;
		if (version !== undefined && this.#childrenVersion === version) return;
		this.#childrenVersion = version ?? -1;
		const children = directBlocks(this.node);
		const live = new Set(children);
		for (let index = this.entries.length - 1; index >= this.frontier; index--) {
			const entry = this.entries[index]!;
			if (live.has(entry.node) || !this.canRemoveEntry(index, entry)) continue;
			this.entries.splice(index, 1);
			this.#entryNodes.delete(entry.node);
		}
		for (const child of children) {
			if (this.#entryNodes.has(child)) continue;
			this.#entryNodes.add(child);
			const props = blockProps(child);
			this.entries.push({
				node: child,
				state: props.settled === true ? "settled" : "active",
				mode: props.mode === "appendOnly" ? "appendOnly" : "mutable",
				stableRows: EMPTY_STABLE_ROWS,
				renderedStableByWidth: new Map(),
				stableRowCountByWidth: new Map(),
				paintCache: new RichText(),
				renderCache: new RichText(),
				emitted: 0,
				stableFrozen: false,
				resourcesFrozen: false,
				paintedAt: 0,
			});
			if (this.capacity !== Number.MAX_SAFE_INTEGER) props.onAllocation?.(this.capacity);
		}
	}

	private canRemoveEntry(index: number, entry: TranscriptEntry): boolean {
		if (entry.state === "committed" || entry.emitted > 0) return false;
		if (this.offered?.kind === "commit" && index < this.offered.end) return false;
		if (this.offered?.kind === "append" && index === this.offered.entry) return false;
		return true;
	}

	private settleFinalized(): void {
		for (let index = this.frontier; index < this.entries.length; index++) {
			const entry = this.entries[index]!;
			entry.state = blockProps(entry.node).settled === true ? "settled" : "active";
		}
	}

	private liveEntries(): Array<{ entry: TranscriptEntry; index: number }> {
		const live: Array<{ entry: TranscriptEntry; index: number }> = [];
		// A frame appends its offered history before painting its viewport.
		// Exclude that same prefix now, not one frame later at acknowledgement.
		const start = this.offered?.kind === "commit" ? this.offered.end : this.frontier;
		for (let index = start; index < this.entries.length; index++) {
			const entry = this.entries[index]!;
			if (entry.state !== "committed") live.push({ entry, index });
		}
		return live;
	}

	private liveCount(): number {
		return this.entries.length - this.frontier;
	}

	private renderViewport(width: number, rows: number, ctx: PaintContext): RichText {
		this.syncEntries();
		this.settleFinalized();
		const output = new RichText();
		const capacity = Math.max(0, Math.trunc(rows));
		if (capacity === 0) return output;
		const blocks: ViewportBlock[] = [];
		let total = 0;
		for (const candidate of this.liveEntries()) {
			const entry = candidate.entry;
			const props = blockProps(entry.node);
			let rendered = this.renderEntry(entry, width, ctx);
			let emitted = this.projectedEmittedRowCount(entry, candidate.index, width, ctx);
			let count = Math.max(0, rendered.rows - emitted);
			let compact = false;
			ctx.placeChild(entry.node, { row: 0, col: 0, width, height: 0 });
			// Completed output and ordinary streaming prose never compete for
			// one-row allocations. Only an oversized live tool may use its summary.
			if (entry.state === "active" && props.toolActivity === true && count > capacity) {
				const summary = this.#renderCompact(entry, width, ctx);
				if (summary) {
					rendered = summary;
					emitted = 0;
					count = 1;
					compact = true;
				}
			} else {
				props.onCompact?.(false);
			}
			if (count === 0) continue;
			const row = total + (blocks.length > 0 ? 1 : 0);
			blocks.push({ entry, rendered, emitted, row, rows: count, compact });
			total = row + count;
		}

		const drop = Math.max(0, total - capacity);
		for (const block of blocks) {
			const end = block.row + block.rows;
			if (end <= drop) continue;
			const first = Math.max(block.row, drop);
			while (output.rows < first - drop) output.br();
			const row = output.rows;
			const start = block.emitted + first - block.row;
			const height = end - first;
			const clip = { row, col: 0, width, height };
			blockProps(block.entry.node).onRowLayout?.(row);
			if (block.compact) {
				let offset = 0;
				for (const child of block.entry.node.slots.get("compact") ?? []) {
					ctx.placeChild(child, { row: row + offset, col: 0, width, clip });
					offset += child.cache.rows;
				}
			} else {
				ctx.placeChild(block.entry.node, { row: row - start, col: 0, width, clip });
			}
			block.rendered.replay(output, start, start + height);
		}
		return output;
	}

	#renderCompact(entry: TranscriptEntry, width: number, ctx: PaintContext): RichText | undefined {
		const props = blockProps(entry.node);
		props.onCompact?.(true);
		const nodes = entry.node.slots.get("compact");
		if (!nodes?.length) return undefined;
		const frame = (entry.compactCache ??= new RichText());
		frame.clear();
		for (const child of nodes) {
			ctx.paintChild(child, frame, width);
			ctx.placeChild(child, { row: 0, col: 0, width, height: 0 });
		}
		frame.finish();
		return frame.rows > 0 ? frame : undefined;
	}

	private peekBatch(
		width: number,
		capacity: number,
		policy: RetirementPolicy,
		ctx: PaintContext,
	): HistoryBatch | undefined {
		this.syncEntries();
		this.settleFinalized();
		if (this.offered !== undefined) return this.offered.batch;
		const replay = this.prepareReplay(width, ctx);
		if (replay !== undefined) return replay;
		this.completeFullyEmittedHeads(width, ctx);
		const live = this.liveEntries();
		if (live.length === 0) return undefined;
		const heights = new Array<number>(live.length);
		let total = 0;
		let visible = 0;
		for (let index = 0; index < live.length; index++) {
			const candidate = live[index]!;
			const rendered = this.renderEntry(candidate.entry, width, ctx);
			const rows =
				rendered.rows - this.renderStablePrefix(candidate.entry, candidate.entry.emitted, width, ctx).rows;
			heights[index] = rows;
			if (rows > 0) total += rows + (visible++ > 0 ? 1 : 0);
		}
		const room = Math.max(0, Math.trunc(capacity));
		const overflowing = total > room || this.liveCount() >= MAX_LIVE_BLOCKS;
		if (policy === "pressure" && !overflowing) {
			this.pinnedFrontier = undefined;
			return undefined;
		}

		const head = this.entries[this.frontier];
		if (
			policy === "pressure" &&
			total > room &&
			head?.mode === "appendOnly" &&
			!head.stableFrozen &&
			head.state !== "committed" &&
			head.emitted < head.stableRows.length
		) {
			const before = this.renderStablePrefix(head, head.emitted, width, ctx);
			let emittedEnd = head.emitted;
			let rows = new RichText();
			const overflow = total - room;
			while (emittedEnd < head.stableRows.length && rows.rows < overflow) {
				const after = this.renderStablePrefix(head, emittedEnd + 1, width, ctx);
				if (!isRowPrefix(before, after) || after.rows === before.rows) {
					if (emittedEnd === head.emitted)
						this.freezeStableRows(head, "semantic row render added no suffix", ctx.now);
					break;
				}
				rows = copyRows(after, before.rows);
				emittedEnd++;
			}
			if (emittedEnd > head.emitted) {
				const batch: HistoryBatch = {
					id: this.#nextBatchId(),
					rows: this.emitHistoryRows(rows, ctx),
					kind: "append",
				};
				this.offered = { batch, kind: "append", entry: this.frontier, emittedEnd };
				blockProps(head.node).onRetire?.();
				this.pinnedFrontier = undefined;
				markInternalLayout(this.node);
				return batch;
			}
		}

		let end = this.frontier;
		let freed = 0;
		let index = 0;
		while (end < this.entries.length && this.entries[end]!.state === "settled") {
			if (
				policy === "pressure" &&
				total - freed <= room &&
				this.liveCount() - (end - this.frontier) < MAX_LIVE_BLOCKS
			)
				break;
			freed += heights[index]! > 0 ? heights[index]! + 1 : 0;
			end++;
			index++;
		}
		if (end === this.frontier) {
			if (policy === "pressure") this.notePinnedFrontier(ctx.now);
			return undefined;
		}
		const frame = this.renderRange(this.frontier, end, width, true, ctx);
		const batch: HistoryBatch = { id: this.#nextBatchId(), rows: this.emitHistoryRows(frame, ctx), kind: "append" };
		this.offered = { batch, kind: "commit", end };
		for (let retired = this.frontier; retired < end; retired++) {
			blockProps(this.entries[retired]!.node).onRetire?.();
		}
		this.pinnedFrontier = undefined;
		markInternalLayout(this.node);
		return batch;
	}

	private emitHistoryRows(rows: RichText, ctx: PaintContext): readonly string[] {
		return emitRows(rows, { mode: ctx.theme.getColorMode() });
	}

	private renderEntry(entry: TranscriptEntry, width: number, ctx: PaintContext): RichText {
		if (entry.mode === "appendOnly" && (entry.stableTheme !== ctx.theme || entry.stableEpoch !== ctx.widthEpoch)) {
			entry.stableTheme = ctx.theme;
			entry.stableEpoch = ctx.widthEpoch;
			entry.stableRenderCache?.clear();
			entry.renderedStableByWidth.clear();
			entry.stableRowCountByWidth.clear();
		}
		if (!entry.resourcesFrozen) entry.paintedAt = ctx.now;
		entry.paintCache.clear();
		ctx.paintChild(entry.node, entry.paintCache, Math.max(1, width));
		entry.paintCache.finish();
		const rendered = trimBlankEdges(entry.paintCache, entry.renderCache);
		if (entry.mode === "mutable" || entry.stableFrozen || entry.state === "committed") return rendered;
		const props = blockProps(entry.node);
		const stable = props.stableRows ?? EMPTY_STABLE_ROWS;
		if (props.renderStableRows === undefined && props.onStableRender === undefined)
			return this.freezeStableRows(entry, "append-only block has no stable renderer", ctx.now, rendered);
		if (!stablePrefix(entry.stableRows, stable)) {
			return this.freezeStableRows(entry, "publication retracted the published prefix", ctx.now, rendered);
		}
		if (entry.emitted > stable.length) {
			return this.freezeStableRows(entry, "publication retracted emitted history", ctx.now, rendered);
		}
		const published =
			stable.length > entry.stableRows.length
				? [...entry.stableRows, ...stable.slice(entry.stableRows.length)]
				: entry.stableRows;
		const stableRendered = this.#renderStableFrame(entry, published.length, width, ctx);
		stableRendered.finish();
		if (!isRowPrefix(stableRendered, rendered)) {
			return this.freezeStableRows(
				entry,
				"stable rows no longer render as a prefix of the block",
				ctx.now,
				rendered,
			);
		}
		const prior = entry.renderedStableByWidth.get(width);
		if (prior !== undefined && !isRowPrefix(prior, stableRendered)) {
			return this.freezeStableRows(entry, "stable rows changed within a width epoch", ctx.now, rendered);
		}
		entry.stableRows = published;
		if (prior === undefined || prior.rows !== stableRendered.rows || !isRowPrefix(prior, stableRendered)) {
			entry.renderedStableByWidth.set(width, copyRows(stableRendered));
		}
		let counts = entry.stableRowCountByWidth.get(width);
		if (counts === undefined) {
			counts = new Map();
			entry.stableRowCountByWidth.set(width, counts);
		}
		counts.set(published.length, stableRendered.rows);
		return rendered;
	}

	private freezeStableRows(entry: TranscriptEntry, reason: string, now: number, rendered?: RichText): RichText {
		entry.stableFrozen = true;
		logger.warn("Append-only transcript block frozen", { reason, emitted: entry.emitted, now });
		return rendered ?? entry.renderCache;
	}

	#renderStableFrame(entry: TranscriptEntry, count: number, width: number, ctx: PaintContext): RichText {
		if (count === 0) return EMPTY_STABLE_FRAME;
		const props = blockProps(entry.node);
		if (props.renderStableRows) {
			const rows = props.renderStableRows(count, width);
			rows.finish();
			return rows;
		}
		const key = `${width}:${count}`;
		const cache = (entry.stableRenderCache ??= new LRUCache<string, RichText>({ max: 64 }));
		const cached = cache.get(key);
		if (cached) return cached;
		props.onStableRender?.(count);
		const frame = new RichText();
		// Offscreen stable projections must not register as live transcript hits.
		const parent = ctx[ACTIVE_PAINT_NODE];
		ctx[ACTIVE_PAINT_NODE] = undefined;
		try {
			for (const child of entry.node.slots.get("stable") ?? []) ctx.paintChild(child, frame, Math.max(1, width));
		} finally {
			ctx[ACTIVE_PAINT_NODE] = parent;
		}
		frame.finish();
		const rows = trimBlankEdges(frame);
		cache.set(key, rows);
		return rows;
	}

	private renderStablePrefix(entry: TranscriptEntry, count: number, width: number, ctx: PaintContext): RichText {
		return this.#renderStableFrame(entry, Math.min(count, entry.stableRows.length), width, ctx);
	}

	private projectedEmittedRowCount(entry: TranscriptEntry, index: number, width: number, ctx: PaintContext): number {
		const offered = this.offered;
		const count = offered?.kind === "append" && offered.entry === index ? offered.emittedEnd : entry.emitted;
		if (count === 0) return 0;
		const memo = entry.stableRowCountByWidth.get(width)?.get(Math.min(count, entry.stableRows.length));
		return memo ?? this.renderStablePrefix(entry, count, width, ctx).rows;
	}

	private renderRange(start: number, end: number, width: number, trailingBlank: boolean, ctx: PaintContext): RichText {
		const output = new RichText();
		for (let index = start; index < end; index++) {
			const entry = this.entries[index]!;
			blockProps(entry.node).onCompact?.(false);
			const rendered = this.renderEntry(entry, width, ctx);
			const emittedRows = index === start ? this.renderStablePrefix(entry, entry.emitted, width, ctx).rows : 0;
			if (emittedRows >= rendered.rows) continue;
			if (output.rows > 0) output.br();
			rendered.replay(output, emittedRows);
		}
		if (trailingBlank && output.rows > 0) output.br();
		return output;
	}

	private renderReplay(width: number, ctx: PaintContext): RichText {
		const output = this.renderRange(0, this.frontier, width, true, ctx);
		const head = this.entries[this.frontier];
		if (head?.mode === "appendOnly" && head.emitted > 0) {
			this.renderEntry(head, width, ctx);
			this.renderStablePrefix(head, head.emitted, width, ctx).replay(output);
		}
		return output;
	}

	private prepareReplay(width: number, ctx: PaintContext): HistoryBatch | undefined {
		if (this.offered !== undefined) return this.offered.kind === "replay" ? this.offered.batch : undefined;
		if (!this.replayPending) return undefined;
		// Retired document views no longer subscribe to updates; explicit replay
		// must read their current documents rather than reuse frozen paint caches.
		for (let index = 0; index < this.frontier; index++) markSubtreeDamage(this.entries[index]!.node, Damage.Layout);
		const frame = this.renderReplay(width, ctx);
		this.replayPending = false;
		if (frame.rows === 0) return undefined;
		const batch: HistoryBatch = {
			id: this.#nextBatchId(),
			rows: this.emitHistoryRows(frame, ctx),
			kind: "replay",
		};
		this.offered = { batch, kind: "replay" };
		return batch;
	}

	private completeFullyEmittedHeads(width: number, ctx: PaintContext): void {
		while (this.frontier < this.entries.length) {
			const entry = this.entries[this.frontier]!;
			if (entry.mode !== "appendOnly" || entry.state !== "settled") return;
			const rendered = this.renderEntry(entry, width, ctx);
			if (entry.emitted !== entry.stableRows.length) return;
			if (this.renderStablePrefix(entry, entry.emitted, width, ctx).rows !== rendered.rows) return;
			entry.state = "committed";
			entry.emitted = 0;
			freezeResources(entry);
			this.frontier++;
		}
	}

	private startReplay(): void {
		const head = this.entries[this.frontier];
		this.replayPending = this.frontier > 0 || (head?.mode === "appendOnly" && head.emitted > 0);
		this.replayRequested = false;
	}

	private notePinnedFrontier(now: number): void {
		const entry = this.entries[this.frontier];
		if (entry === undefined) return;
		if (this.pinnedFrontier?.index !== this.frontier) {
			this.pinnedFrontier = { index: this.frontier, since: now, logged: false };
			return;
		}
		if (this.pinnedFrontier.logged || now - this.pinnedFrontier.since < PINNED_FRONTIER_WARN_MS) return;
		this.pinnedFrontier.logged = true;
		logger.warn("Transcript retirement pinned by unfinalized frontier block", {
			node: entry.node.id,
			state: entry.state,
			mode: entry.mode,
			liveBlocks: this.liveCount(),
		});
	}
}

/** Return the transcript controller retained by a transcript node, if attached. */
export function transcriptController(node: HostElement): TranscriptController | undefined {
	return node.tag === "transcript" && node.state instanceof TranscriptController ? node.state : undefined;
}

/** Find the first transcript controller in a retained host subtree. */
export function findTranscriptController(node: HostNode): TranscriptController | undefined {
	if (node.kind === "text") return undefined;
	const own = transcriptController(node);
	if (own !== undefined) return own;
	for (const child of node.children) {
		const found = findTranscriptController(child);
		if (found !== undefined) return found;
	}
	return undefined;
}
