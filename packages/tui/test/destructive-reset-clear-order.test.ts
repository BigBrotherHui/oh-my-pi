import { describe, expect, it, vi } from "bun:test";
import { RichText } from "../src/core/richtext";
import { Style } from "../src/core/style";
import { TUI, type TerminalFramePlan, type TerminalFrameProvider, type ViewportSize } from "../src/tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

class RawLines implements TerminalFrameProvider {
	constructor(private readonly lines: readonly string[]) {}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		const frame = new RichText();
		for (const line of this.lines) {
			frame.push(Style.NONE, line);
			frame.br();
		}
		return { viewport: frame };
	}

	acknowledgeHistory(_id: number): void {}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(40);
	await term.flush();
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

describe("destructive reset erase order", () => {
	// tmux implements ED2 (CSI 2J) by scrolling the live screen into pane
	// history so cleared content stays reachable in scrollback. Emitting ED3
	// before ED2 therefore wipes history only to have ED2 immediately refill
	// it with a copy of the old screen — the subsequent replay then paints the
	// same content again, depositing one duplicate frame in scrollback per
	// destructive reset. ED2-then-ED3 clears the screen first and then wipes
	// history including tmux's push; on xterm-family terminals the two erases
	// are independent and the order is irrelevant.
	it("emits ED2 before ED3 so tmux's clear-pushes-screen-into-history cannot survive the wipe", async () => {
		const term = new VirtualTerminal(80, 10);
		const tui = new TUI(term);
		tui.setFrameProvider(new RawLines(["alpha", "beta", "gamma"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			const reset = writes.find(write => write.includes("\x1b[3J"));
			expect(reset).toBeDefined();
			expect(reset!).toContain("\x1b[2J\x1b[3J");
			expect(reset!).not.toContain("\x1b[3J\x1b[2J");
		} finally {
			tui.stop();
		}
	});
});
