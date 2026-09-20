import { RichText } from "../core/richtext";
import { focusedInputTarget } from "../host/input";
import type { HostRoot } from "../host/node";
import { Damage } from "../host/types";
import type { TerminalFramePlan, TerminalFrameProvider, ViewportSize } from "../tui";

/** Compositor operations exposed to the terminal frame-provider adapter. */
export interface HostFrameSource {
	readonly root: HostRoot;
	invalidate(damage: Damage): void;
	compose(viewport: ViewportSize): TerminalFramePlan;
	composeResize(viewport: ViewportSize): RichText;
	acknowledgeHistory(id: number): void;
	beginHistoryReplay(): void;
	beginHistoryFlush(): void;
	frameCommitted(): void;
}

/** TUI-compatible adapter around a retained host-root compositor. */
export class HostRootFrameProvider implements TerminalFrameProvider {
	private readonly source: HostFrameSource;

	constructor(source: HostFrameSource) {
		this.source = source;
	}

	get root() {
		return this.source.root.node;
	}

	inputTarget() {
		return focusedInputTarget(this.source.root);
	}

	invalidate(): void {
		this.source.invalidate(Damage.Layout);
	}

	/** Compose one bounded normal-buffer frame. */
	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		return this.source.compose(viewport);
	}

	/** Compose the semantic tail used by the transient resize buffer. */
	renderResizeFrame(viewport: ViewportSize): RichText {
		return this.source.composeResize(viewport);
	}

	/** Advance the transcript ledger after TUI accepts a history batch. */
	acknowledgeHistory(id: number): void {
		this.source.acknowledgeHistory(id);
	}

	/** Re-offer the committed transcript at the terminal's current width. */
	beginHistoryReplay(): void {
		this.source.beginHistoryReplay();
	}

	/** Retire every eligible settled block during terminal shutdown. */
	beginHistoryFlush(): void {
		this.source.beginHistoryFlush();
	}

	/** Flush reactive commit hooks after terminal bytes have been written. */
	frameCommitted(): void {
		this.source.frameCommitted();
	}
}

/** Return an owned bottom slice that never exceeds a physical viewport. */
export function boundFrameToViewport(frame: RichText, rows: number): RichText {
	const capacity = Math.max(0, Math.trunc(rows));
	if (frame.rows <= capacity) return frame;
	const bounded = new RichText();
	frame.replay(bounded, frame.rows - capacity, frame.rows);
	return bounded;
}
