import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { Terminal as XtermTerminalInstance } from "@oh-my-pi/pi-utils/vterm";
import {
	BashInteractiveOverlayView,
	BashInteractiveSession,
	normalizeInputForPty,
	normalizeMouseForPty,
	normalizePasteForPty,
	type BashInteractiveTerminalBackend,
} from "../src/tools/bash-interactive";
import { dispatchPaste, HostMouseEvent } from "../src/host/input";
import { loadXtermTerminal } from "../src/tools/terminal-output";
import { createSignal } from "../src/reactive";
import { mountForTest, type TestRoot } from "../src/testing";

describe("bash-interactive", () => {
	let uiTheme: Theme;
	let XtermTerminal: typeof XtermTerminalInstance;
	const roots: TestRoot[] = [];

	beforeAll(async () => {
		const [loadedTheme, terminalCtor] = await Promise.all([getThemeByName("dark"), loadXtermTerminal()]);
		if (!loadedTheme) throw new Error("Expected dark theme");
		uiTheme = loadedTheme;
		XtermTerminal = terminalCtor;
	});

	afterEach(() => {
		for (const root of roots.splice(0)) root.dispose();
	});

	it("normalizes terminal keystrokes for PTY input", () => {
		expect(normalizeInputForPty("\r", false)).toBe("\r");
		expect(normalizeInputForPty("\t", false)).toBe("\t");
		expect(normalizeInputForPty("hello", false)).toBe("hello");
		expect(normalizeInputForPty("\x1b", false)).toBe("\x1b");
		expect(normalizeInputForPty("\x7f", false)).toBe("\x7f");
	});

	it("renders BashInteractiveOverlayView with header, terminal rows, and footer", () => {
		const term = new XtermTerminal({ cols: 80, rows: 24 });
		let resizedCols = 0;
		let resizedRows = 0;

		const root = mountForTest(
			() => (
				<BashInteractiveOverlayView
					command="htop"
					theme={uiTheme}
					state="running"
					terminal={term}
					getTerminalRows={() => 40}
					onResize={(cols, rows) => {
						resizedCols = cols;
						resizedRows = rows;
					}}
				/>
			),
			{ width: 80, theme: uiTheme },
		);
		roots.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("Console");
		expect(text).toContain("htop");
		expect(text).toContain("running");
		expect(text).toContain("force-kill");
		expect(resizedCols).toBe(78);
		expect(resizedRows).toBe(28);
		expect(term.cols).toBe(78);
		expect(term.rows).toBe(28);

		root.dispose();
		term.dispose();
	});

	it("frames literal clipboard data only while the virtual PTY enables bracketed paste", async () => {
		const term = new XtermTerminal({ cols: 80, rows: 24 });
		const forwarded: string[] = [];
		const root = mountForTest(
			() => (
				<box
					tabIndex={0}
					onPaste={text => forwarded.push(normalizePasteForPty(text, term.modes.bracketedPasteMode))}
				/>
			),
			{ width: 80, theme: uiTheme },
		);
		roots.push(root);

		await new Promise<void>(resolve => term.write("\x1b[?2004h", () => resolve()));
		dispatchPaste(root.root, "first\nsecond");
		await new Promise<void>(resolve => term.write("\x1b[?2004l", () => resolve()));
		dispatchPaste(root.root, "plain");

		expect(forwarded).toEqual(["\x1b[200~first\nsecond\x1b[201~", "plain"]);

		root.dispose();
		term.dispose();
	});

	it("rebases SGR pointer reports to the PTY viewport without losing modifiers", () => {
		const press = new HostMouseEvent({
			row: 14,
			col: 37,
			action: "down",
			button: 0,
			rawButton: 20,
			data: "\x1b[<20;38;15M",
		});
		press.setCurrentOrigin(10, 30);
		expect(normalizeMouseForPty(press)).toBe("\x1b[<20;8;5M");

		const release = new HostMouseEvent({
			row: 14,
			col: 37,
			action: "up",
			button: 0,
			rawButton: 20,
			data: "\x1b[<20;38;15m",
		});
		release.setCurrentOrigin(10, 30);
		expect(normalizeMouseForPty(release)).toBe("\x1b[<20;8;5m");
	});

	it("keeps the historical status chrome and row budget at narrow widths", () => {
		const term = new XtermTerminal({ cols: 80, rows: 24 });
		const root = mountForTest(
			() => (
				<BashInteractiveOverlayView
					command="a command whose detail must clip before the completion badge"
					theme={uiTheme}
					state="killed"
					exitCode={0}
					terminal={term}
					getTerminalRows={() => 5}
					onResize={() => {}}
				/>
			),
			{ width: 30, theme: uiTheme },
		);
		roots.push(root);

		const text = root.text().join("\n");
		expect(text).toContain("killed");
		expect(text).toContain("[killed]");
		expect(text).not.toContain("[ killed ]");
		expect(root.text()).toHaveLength(5);

		root.dispose();
		term.dispose();
	});

	it("refreshes a bridge terminal from its revision source", async () => {
		const term = new XtermTerminal({ cols: 80, rows: 24 });
		const [revision, setRevision] = createSignal(0);
		const root = mountForTest(
			() => (
				<BashInteractiveOverlayView
					command="watch"
					theme={uiTheme}
					state="running"
					terminal={term}
					getTerminalRows={() => 40}
					onResize={() => {}}
					revision={revision}
				/>
			),
			{ width: 80, theme: uiTheme },
		);
		roots.push(root);

		await new Promise<void>(resolve => term.write("live output", () => resolve()));
		setRevision(previous => previous + 1);
		root.flush();
		expect(root.text().join("\n")).toContain("live output");

		root.dispose();
		term.dispose();
	});

	it("updates the reactive interactive terminal session", async () => {
		let resizedCols = 0;
		let resizedRows = 0;
		const backend: BashInteractiveTerminalBackend = {
			resize(cols, rows) {
				resizedCols = cols;
				resizedRows = rows;
			},
		};

		const session = new BashInteractiveSession("python3", XtermTerminal, backend);

		let inputReceived = "";
		let dismissed = false;
		let disposed = false;

		session.setHandlers(
			data => {
				inputReceived += data;
			},
			() => {
				dismissed = true;
			},
			() => {
				disposed = true;
			},
		);

		let frames = 0;
		const detach = session.borrowedTerminal.attach(() => {
			frames += 1;
		});
		session.appendOutput("Python 3.12.0\n>>> ");
		await session.flushOutput();
		expect(frames).toBeGreaterThan(0);
		detach();

		const root = mountForTest(
			() => (
				<BashInteractiveOverlayView
					command={session.command}
					theme={uiTheme}
					state={() => session.state()}
					exitCode={() => session.exitCode()}
					terminal={session.terminal}
					getTerminalRows={() => 40}
					onResize={(cols, rows) => backend.resize(cols, rows)}
				/>
			),
			{ width: 80, theme: uiTheme },
		);
		roots.push(root);
		const fullText = root.text().join("\n");
		expect(fullText).toContain("Console");
		expect(fullText).toContain("python3");
		expect(fullText).toContain("Python 3.12.0");

		// Send input to component
		session.handleInput("x = 1\r");
		expect(inputReceived).toContain("x = 1\r");

		// Complete session
		session.setComplete({ exitCode: 0, cancelled: false, timedOut: false });
		root.flush();
		expect(root.text().join("\n")).toContain("exit 0");
		expect(root.text().join("\n")).toContain("session finished");
		session.handleInput("ignored");
		expect(inputReceived).toContain("x = 1\r");
		expect(inputReceived).not.toContain("ignored");

		session.dispose();
		expect(disposed).toBe(true);
	});
});
