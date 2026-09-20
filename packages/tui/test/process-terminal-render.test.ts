import { afterEach, describe, expect, it, vi } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

// Geometry-reflow contract for the real ProcessTerminal driven by a terminal
// frame provider. These exercise the seam VirtualTerminal cannot model: the OS
// channel (SIGWINCH) and the DEC 2048 in-band channel disagreeing. The
// observable contract is `probe.last` — the width the frame provider received.
describe("ProcessTerminal geometry reflow through the frame provider", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
		vi.restoreAllMocks();
	});

	it("reflows to the OS width on resize when in-band resize is inactive", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		expect(harness.probe.last).toBe(100);

		await harness.osResize(160, 40);

		expect(harness.terminal.columns).toBe(160);
		expect(harness.probe.last).toBe(160);
	});

	it("reflows to the OS width when the post-resize in-band report is missed", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(30, 100, 600, 1000);
		expect(harness.probe.last).toBe(100);

		await harness.osResize(160, 40);

		expect(harness.terminal.columns).toBe(160);
		expect(harness.probe.last).toBe(160);
	});

	it("reflows to authoritative in-band geometry", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(30, 100, 600, 1000);
		await harness.inBand(30, 140, 700, 1400);

		expect(harness.terminal.columns).toBe(140);
		expect(harness.probe.last).toBe(140);
	});

	it("reflows when an in-band report is split across stdin reads", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(30, 100, 600, 1000);
		await harness.feed("\x1b[48;40;160", ";800;1600t");

		expect(harness.terminal.columns).toBe(160);
		expect(harness.probe.last).toBe(160);
	});

	it("recovers height from colon-subparameter reports", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(15, 100, 300, 1000);
		expect(harness.terminal.rows).toBe(15);
		await harness.feed("\x1b[48;30;100;600;1000:0t");

		expect(harness.terminal.rows).toBe(30);
		expect(harness.terminal.columns).toBe(100);
	});

	it("stops rendering and raises SIGHUP when terminal input ends", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		const rendersBeforeDisconnect = harness.probe.widths.length;
		const signalsBeforeDisconnect = harness.signals.length;
		await harness.endInput();
		harness.tui.requestRender(true);
		await harness.settle();

		expect(harness.probe.widths).toHaveLength(rendersBeforeDisconnect);
		expect(harness.signals.slice(signalsBeforeDisconnect)).toContainEqual({ pid: process.pid, signal: "SIGHUP" });
	});

	it("does not wait for terminal output to drain after input ends on Windows", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const quit = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.endInput();

		expect(quit).toHaveBeenCalledWith(129, { drainStdout: false });
		expect(harness.signals).toHaveLength(0);
	});

	it("stops rendering and raises SIGHUP when terminal output fails", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		const rendersBeforeDisconnect = harness.probe.widths.length;
		const signalsBeforeDisconnect = harness.signals.length;
		await harness.failOutput();
		harness.tui.requestRender(true);
		await harness.settle();

		expect(harness.probe.widths).toHaveLength(rendersBeforeDisconnect);
		expect(harness.signals.slice(signalsBeforeDisconnect)).toContainEqual({ pid: process.pid, signal: "SIGHUP" });
	});
});
