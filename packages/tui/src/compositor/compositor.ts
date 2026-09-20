import type { Owner } from "solid-js";
import { RichText } from "../core/richtext";
import { recordPaintSpan } from "../host/input";
import { markSubtreeDamage } from "../host/damage";
import { createHostRoot, disposeHostRoot, type HostRoot } from "../host/node";
import { createPaintContext, paintHostTree, publishPaintSpans } from "../host/paint";
import { Damage, type PaintContext } from "../host/types";
import type { Clock } from "../reactive/clock";
import { flushCommitHooks, flushLayoutHooks } from "../reactive/effects";
import { resolveStyle } from "../style/cascade";
import type { Theme } from "../theme/theme";
import type { HistoryBatch, TerminalFramePlan, TUI, ViewportSize } from "../tui";
import { getWidthConfigEpoch } from "../utils";
import { boundFrameToViewport, HostRootFrameProvider, type HostFrameSource } from "./frame";
import { CompositorScheduler } from "./scheduler";
import { findTranscriptController, type TranscriptController } from "./transcript";

/** Inputs required to own and compose one retained host root. */
export interface CompositorOptions {
	readonly tui: TUI;
	readonly theme: () => Theme;
	readonly clock: Clock;
	readonly owner?: Owner | null;
	/** Publish physical dimensions before evaluating width-sensitive views. */
	readonly onViewport?: (viewport: ViewportSize) => void;
}

interface PaintedRoot {
	readonly frame: RichText;
	readonly context: PaintContext;
	readonly transcript: TranscriptController | undefined;
}

/** Cache-aware compositor producing history plus bounded viewport frame plans. */
export class Compositor implements HostFrameSource {
	readonly root: HostRoot;
	readonly provider: HostRootFrameProvider;
	readonly #tui: TUI;
	readonly #theme: () => Theme;
	readonly #clock: Clock;
	readonly #scheduler: CompositorScheduler;
	readonly #detachedRoots = new Set<HostRoot>();
	#owner: Owner | null;
	#primaryTranscript: TranscriptController | undefined;
	#replayRequested = false;
	#flushing = false;
	#disposed = false;
	readonly #onViewport: ((viewport: ViewportSize) => void) | undefined;

	constructor(options: CompositorOptions) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#clock = options.clock;
		this.#owner = options.owner ?? null;
		this.#onViewport = options.onViewport;
		this.#scheduler = new CompositorScheduler(options.tui);
		this.root = this.#makeHostRoot();
		this.provider = new HostRootFrameProvider(this);
	}

	/** Attach the Solid root owner used by layout and terminal-commit effects. */
	setOwner(owner: Owner): void {
		this.#owner = owner;
	}

	/** Mark every retained cache at the granularity required by a root-wide change. */
	invalidate(damage: Damage): void {
		if (this.#disposed) return;
		markSubtreeDamage(this.root.node, damage);
		for (const detached of this.#detachedRoots) markSubtreeDamage(detached.node, damage);
		this.#scheduler.request(this.root.node, damage);
	}

	/** Compose one normal-buffer history/viewport transaction. */
	compose(viewport: ViewportSize): TerminalFramePlan {
		this.#onViewport?.(viewport);
		this.#scheduler.beginFrame();
		const snapshot = this.#clock.freeze();
		let painted = this.#paintRoot(this.root, viewport.columns, snapshot.at, viewport.rows);
		const transcript = painted.transcript;
		this.#primaryTranscript = transcript;
		let history: HistoryBatch | undefined;
		if (transcript !== undefined) {
			if (this.#replayRequested) {
				transcript.beginReplay();
				this.#replayRequested = false;
			}
			const outsideRows = Math.max(0, painted.frame.rows - transcript.renderedRows);
			const capacity = Math.max(0, viewport.rows - outsideRows);
			const capacityChanged = transcript.setCapacity(capacity);
			history = this.#flushing
				? transcript.peekFlushBatch(viewport.columns, painted.context)
				: (transcript.peekReplayBatch(viewport.columns, painted.context) ??
					transcript.peekFinalizedBatch(viewport.columns, capacity, painted.context));
			if (capacityChanged || history !== undefined) {
				painted = this.#paintRoot(this.root, viewport.columns, snapshot.at, viewport.rows);
			}
		}
		painted = this.#flushLayout(painted, viewport, snapshot.at);
		publishPaintSpans(this.root, painted.context, -Math.max(0, painted.frame.rows - viewport.rows), viewport.rows);
		return {
			history,
			viewport: boundFrameToViewport(painted.frame, viewport.rows),
		};
	}

	/** Compose the bounded semantic tail used while TUI borrows the resize buffer. */
	composeResize(viewport: ViewportSize): RichText {
		this.#onViewport?.(viewport);
		const snapshot = this.#clock.freeze();
		let painted = this.#paintRoot(this.root, viewport.columns, snapshot.at, viewport.rows);
		const transcript = painted.transcript;
		if (transcript) {
			const outsideRows = Math.max(0, painted.frame.rows - transcript.renderedRows);
			if (transcript.setCapacity(Math.max(0, viewport.rows - outsideRows)))
				painted = this.#paintRoot(this.root, viewport.columns, snapshot.at, viewport.rows);
		}
		painted = this.#flushLayout(painted, viewport, snapshot.at);
		publishPaintSpans(this.root, painted.context, -Math.max(0, painted.frame.rows - viewport.rows), viewport.rows);
		return boundFrameToViewport(painted.frame, viewport.rows);
	}

	#flushLayout(painted: PaintedRoot, viewport: ViewportSize, now: number): PaintedRoot {
		if (this.#owner !== null) flushLayoutHooks(this.#owner);
		return this.root.node.damage === Damage.None
			? painted
			: this.#paintRoot(this.root, viewport.columns, now, viewport.rows);
	}

	/** Advance the active transcript after TUI accepts a history batch. */
	acknowledgeHistory(id: number): void {
		this.#primaryTranscript?.acknowledgeHistory(id);
	}

	/** Request deterministic committed-ledger replay at the next frame width. */
	beginHistoryReplay(): void {
		if (this.#primaryTranscript === undefined) this.#replayRequested = true;
		else this.#primaryTranscript.beginReplay();
	}

	/** Switch retirement to flush mode until no settled history remains. */
	beginHistoryFlush(): void {
		this.#flushing = true;
		this.#primaryTranscript?.cancelReplay();
	}

	/** Flush root-scoped reactive commit hooks after terminal emission. */
	frameCommitted(): void {
		if (this.#owner !== null) flushCommitHooks(this.#owner);
	}

	/** Clear native history and explicitly replay the semantic transcript. */
	resetDisplay(resetStableEmission = false): void {
		if (resetStableEmission) this.#primaryTranscript?.resetStableEmission();
		this.beginHistoryReplay();
		this.#scheduler.resetDisplay();
	}

	/** Create a detached retained root for an overlay portal. */
	createDetachedRoot(): HostRoot {
		if (this.#disposed) throw new Error("Cannot create an overlay for a disposed compositor");
		const root = this.#makeHostRoot();
		this.#detachedRoots.add(root);
		return root;
	}

	/** Paint a detached overlay root with the current frozen frame clock. */
	paintDetachedRoot(root: HostRoot, out: RichText, width: number, height: number): void {
		if (!this.#detachedRoots.has(root)) throw new Error("Overlay root is not owned by this compositor");
		this.#onViewport?.({ columns: this.#tui.terminal.columns, rows: this.#tui.terminal.rows });
		root.theme = this.#theme();
		root.widthEpoch = getWidthConfigEpoch();
		const context = createPaintContext(root, node => resolveStyle(node, { theme: root.theme }), {
			now: this.#clock.freeze().at,
			availableHeight: height,
			recordSpan: recordPaintSpan,
		});
		paintHostTree(root, out, Math.max(1, width), context);
	}

	/** Dispose a detached overlay root and remove it from compositor ownership. */
	disposeDetachedRoot(root: HostRoot): void {
		if (!this.#detachedRoots.delete(root)) return;
		disposeHostRoot(root);
	}

	/** Stop scheduling and release the main and detached retained trees. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#scheduler.dispose();
		for (const root of this.#detachedRoots) disposeHostRoot(root);
		this.#detachedRoots.clear();
		disposeHostRoot(this.root);
	}

	#makeHostRoot(): HostRoot {
		return createHostRoot({
			theme: this.#theme(),
			widthEpoch: getWidthConfigEpoch(),
			onDamage: (node, damage) => this.#scheduler.request(node, damage),
			subscribeClock: (cadence, listener) => this.#clock.subscribe(cadence, listener),
		});
	}

	#paintRoot(root: HostRoot, width: number, now: number, height: number): PaintedRoot {
		root.theme = this.#theme();
		root.widthEpoch = getWidthConfigEpoch();
		const context = createPaintContext(root, node => resolveStyle(node, { theme: root.theme }), {
			now,
			availableHeight: height,
			recordSpan: recordPaintSpan,
		});
		const frame = new RichText();
		paintHostTree(root, frame, Math.max(1, width), context, { publishSpans: false });
		frame.finish();
		return { frame, context, transcript: findTranscriptController(root.node) };
	}
}
