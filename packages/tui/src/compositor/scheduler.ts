import type { HostNode } from "../host/types";
import { Damage } from "../host/types";
import type { TUI } from "../tui";

/** Damage bridge that reuses TUI's coalescing, pacing, and output backpressure. */
export class CompositorScheduler {
	private readonly tui: TUI;
	private pendingDamage: Damage = Damage.None;
	private stopped = false;

	constructor(tui: TUI) {
		this.tui = tui;
	}

	/** Record host damage and request one ordinary coalesced terminal frame. */
	request(_node: HostNode, damage: Damage): void {
		if (this.stopped) return;
		this.pendingDamage |= damage;
		this.tui.requestRender();
	}

	/** Consume the damage classes represented by the frame now being composed. */
	beginFrame(): Damage {
		const damage = this.pendingDamage;
		this.pendingDamage = Damage.None;
		return damage;
	}

	/** Run an explicit destructive replay through TUI's established reset path. */
	resetDisplay(): void {
		if (this.stopped) return;
		this.pendingDamage |= Damage.Layout;
		this.tui.resetDisplay();
	}

	/** Stop forwarding damage after root teardown. */
	dispose(): void {
		this.stopped = true;
		this.pendingDamage = Damage.None;
	}
}
