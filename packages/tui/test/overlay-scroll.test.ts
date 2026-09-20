import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createComponent, createElement, setProp } from "../src/host/renderer";
import { mountOverlay, Portal, type OverlayDisposer } from "../src/host/overlay";
import { createSignal } from "../src/reactive";
import { render, type RootHandle } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualTerminal } from "./virtual-terminal";

interface OverlayRowsOptions {
	readonly anchor?: "center" | "top-center" | "bottom-center";
	readonly row?: number;
	readonly col?: number;
	readonly width?: number | "100%";
	readonly maxHeight?: number | "100%";
	readonly margin?: number | { readonly bottom: number };
	readonly cursorColumn?: number;
	readonly modal?: boolean;
}

function CursorLineView(props: { readonly value: string }) {
	const input = createElement("input");
	setProp(input, "tabIndex", 0);
	setProp(input, "prompt", "");
	setProp(input, "value", props.value);
	return input;
}

function mountRows(terminal: VirtualTerminal, rows: () => readonly string[], cursorColumn?: () => number): RootHandle {
	return render(
		() => () => {
			cursorColumn?.();
			return rows().join("\n");
		},
		{
			terminal,
			theme: loadThemeSync("dark"),
			clearScrollback: true,
		},
	);
}

function showRowsOverlay(
	root: RootHandle,
	rows: () => readonly string[],
	options: OverlayRowsOptions = {},
): OverlayDisposer {
	return mountOverlay(root.tui, () =>
		createComponent(Portal, {
			to: "overlay",
			anchor: options.anchor,
			row: options.row,
			col: options.col,
			width: options.width,
			maxHeight: options.maxHeight,
			margin: options.margin,
			modal: options.modal,
			get children() {
				if (options.cursorColumn === undefined) return () => rows().join("\n");
				return createComponent(CursorLineView, { value: rows()[0] ?? "" });
			},
		}),
	);
}

function buildRows(count: number): string[] {
	return Array.from({ length: count }, (_value, index) => `row-${index}`);
}

function viewportRowNumbers(term: VirtualTerminal): number[] {
	const rows: number[] = [];
	for (const line of term.getViewport()) {
		const match = line.trim().match(/^row-(\d+)$/);
		if (match) rows.push(Number.parseInt(match[1], 10));
	}
	return rows;
}

function longestBlankRun(lines: string[]): number {
	let longest = 0;
	let current = 0;
	for (const line of lines) {
		if (line.trim().length === 0) {
			current += 1;
			longest = Math.max(longest, current);
		} else {
			current = 0;
		}
	}
	return longest;
}

function renderNow(root: RootHandle): void {
	root.tui.renderNow();
}

function settleResize(root: RootHandle): void {
	vi.advanceTimersByTime(160);
	root.tui.renderNow();
}

withoutTerminalMultiplexer();

describe("TUI overlays", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		vi.useFakeTimers();
		for (const key of [
			"TERM_PROGRAM",
			"PI_TUI_RESIZE_IN_PLACE",
			"HERDR_ENV",
			"HERDR_PANE_ID",
			"HERDR_TAB_ID",
			"HERDR_WORKSPACE_ID",
		]) {
			savedTerminalEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});
	afterEach(() => {
		vi.useRealTimers();
		for (const key in savedTerminalEnv) {
			const value = savedTerminalEnv[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		savedTerminalEnv = {};
	});

	it("does not scroll the terminal when an overlay is shown with a large historical working area", () => {
		const term = new VirtualTerminal(80, 24);
		const [rows, setRows] = createSignal(buildRows(1500));
		const root = mountRows(term, rows);
		let overlay: OverlayDisposer | undefined;
		try {
			renderNow(root);
			setRows(buildRows(5));
			renderNow(root);
			const before = term.getScrollBuffer().length;

			overlay = showRowsOverlay(root, () => ["overlay-0", "overlay-1", "overlay-2"], { anchor: "center" });
			renderNow(root);

			expect(term.getScrollBuffer().length - before).toBeLessThan(200);
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});

	it("keeps the native viewport anchored when an overlay repaint follows a focused cursor below the frame tail", () => {
		const term = new VirtualTerminal(24, 6, 100);
		const [baseRows, setBaseRows] = createSignal(buildRows(8));
		const [statusText, setStatusText] = createSignal("status-before");
		const root = mountRows(term, baseRows);
		root.tui.setShowHardwareCursor(true);
		let cursorOverlay: OverlayDisposer | undefined;
		let statusOverlay: OverlayDisposer | undefined;
		try {
			renderNow(root);
			cursorOverlay = showRowsOverlay(root, () => ["overlay-cursor"], {
				row: 5,
				col: 0,
				width: 16,
				cursorColumn: 14,
			});
			statusOverlay = showRowsOverlay(root, () => [statusText()], { row: 0, col: 0, width: 16, modal: false });
			renderNow(root);

			setBaseRows(["base-0", "base-1"]);
			renderNow(root);
			expect(term.getCursor().row).toBe(5);
			const before = term.getBufferPosition();
			const beforeScrollBufferLength = term.getScrollBuffer().length;

			setStatusText("status-after");
			renderNow(root);

			expect(term.getBufferPosition()).toEqual(before);
			expect(term.getScrollBuffer()).toHaveLength(beforeScrollBufferLength);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual([
				"status-after",
				"base-1",
				"",
				"",
				"",
				"overlay-cursor",
			]);
			expect(term.getCursor().row).toBe(5);
		} finally {
			statusOverlay?.dispose();
			cursorOverlay?.dispose();
			root.dispose();
		}
	});

	it("clamps tall overlays without an explicit maxHeight to the available rows", () => {
		const term = new VirtualTerminal(80, 24);
		const root = mountRows(term, () => ["base-0", "base-1", "base-2"]);
		let overlay: OverlayDisposer | undefined;
		try {
			renderNow(root);
			const marginBottom = 6;
			overlay = showRowsOverlay(root, () => Array.from({ length: 40 }, (_value, index) => `ov-${index}`), {
				anchor: "top-center",
				margin: { bottom: marginBottom },
			});
			renderNow(root);
			const maxVisibleOverlayIndex = (): number => {
				let max = -1;
				for (const line of term.getViewport()) {
					const match = line.trim().match(/^ov-(\d+)$/);
					if (match) max = Math.max(max, Number.parseInt(match[1], 10));
				}
				return max;
			};
			expect(maxVisibleOverlayIndex()).toBeGreaterThanOrEqual(0);
			expect(maxVisibleOverlayIndex()).toBeLessThan(24 - marginBottom);

			term.resize(80, 10);
			settleResize(root);
			expect(maxVisibleOverlayIndex()).toBeGreaterThanOrEqual(0);
			expect(maxVisibleOverlayIndex()).toBeLessThan(10 - marginBottom);
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});

	it("preserves bottom-anchored overlay actions when clamped", () => {
		const term = new VirtualTerminal(80, 5);
		const root = mountRows(term, () => ["base-0"]);
		let overlay: OverlayDisposer | undefined;
		try {
			renderNow(root);
			overlay = showRowsOverlay(root, () => Array.from({ length: 10 }, (_value, index) => `ov-${index}`), {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
			});
			renderNow(root);
			const viewport = term.getViewport().join("\n");
			expect(viewport).toContain("ov-5");
			expect(viewport).toContain("ov-9");
			expect(viewport).not.toContain("ov-0");
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});

	it("clears stale viewport content on launch", () => {
		const term = new VirtualTerminal(40, 4);
		term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\nshell-4\r\n");
		const root = mountRows(term, () => ["ui-0", "ui-1"]);
		try {
			renderNow(root);
			expect(term.getViewport().join("\n").includes("shell-")).toBeFalsy();
		} finally {
			root.dispose();
		}
	});

	it("does not duplicate transcript into scrollback on repeated forced redraws", () => {
		const term = new VirtualTerminal(40, 4);
		const root = mountRows(term, () => buildRows(60));
		try {
			renderNow(root);
			const baseline = term.getScrollBuffer().filter(line => /^row-\d+$/.test(line.trim())).length;
			for (let index = 0; index < 5; index++) {
				root.tui.requestRender(true);
				renderNow(root);
			}
			const after = term.getScrollBuffer().filter(line => /^row-\d+$/.test(line.trim())).length;
			expect(after).toBeLessThanOrEqual(baseline + 4);
		} finally {
			root.dispose();
		}
	});

	it("fully redraws on height increase to avoid stale viewport rows", () => {
		const term = new VirtualTerminal(40, 4);
		term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\nshell-4\r\n");
		const root = mountRows(term, () => ["ui-0", "ui-1", "ui-2", "ui-3"]);
		try {
			renderNow(root);
			term.resize(40, 8);
			settleResize(root);
			expect(term.getViewport().join("\n").includes("shell-")).toBeFalsy();
		} finally {
			root.dispose();
		}
	});

	it("keeps single viewport copy under simultaneous height and content changes", () => {
		const term = new VirtualTerminal(60, 8);
		const [rows, setRows] = createSignal(buildRows(4));
		const root = mountRows(term, rows);
		try {
			renderNow(root);
			for (let index = 0; index < 12; index++) {
				setRows(buildRows(4 + index));
				term.resize(60, index % 2 === 0 ? 7 : 9);
				settleResize(root);
			}
			const viewport = term.getViewport();
			const rowOccurrences = new Map<string, number>();
			for (const line of viewport) {
				const trimmed = line.trim();
				if (/^row-\d+$/.test(trimmed)) rowOccurrences.set(trimmed, (rowOccurrences.get(trimmed) ?? 0) + 1);
			}
			for (const [row, count] of rowOccurrences)
				expect(count, `${row} should appear at most once in the viewport`).toBe(1);
			expect(viewport.at(-1)?.trim()).toBe("row-14");
		} finally {
			root.dispose();
		}
	});

	it("keeps scrollback bounded on resize when content size is stable", () => {
		const term = new VirtualTerminal(60, 8);
		const root = mountRows(term, () => buildRows(140));
		try {
			renderNow(root);
			const before = term.getScrollBuffer().length;
			for (let index = 0; index < 8; index++) {
				term.resize(index % 2 === 0 ? 59 : 60, index % 2 === 0 ? 9 : 8);
				settleResize(root);
			}
			expect(term.getScrollBuffer().length - before).toBeLessThan(120);
		} finally {
			root.dispose();
		}
	});

	it("renders a fresh viewport on resize when content grows before resize", () => {
		const term = new VirtualTerminal(60, 8);
		const [rows, setRows] = createSignal(buildRows(8));
		const root = mountRows(term, rows);
		try {
			renderNow(root);
			setRows(buildRows(140));
			term.resize(59, 9);
			settleResize(root);
			expect(term.getViewport().at(-1)?.includes("row-139")).toBeTruthy();
		} finally {
			root.dispose();
		}
	});

	it("stays anchored across shrink-grow cycles while overflowing viewport", () => {
		const term = new VirtualTerminal(30, 6);
		const [rows, setRows] = createSignal(buildRows(64));
		const root = mountRows(term, rows);
		try {
			renderNow(root);
			for (let cycle = 0; cycle < 3; cycle++) {
				setRows(buildRows(64 - cycle * 8));
				renderNow(root);
				setRows(buildRows(68 - cycle * 8));
				renderNow(root);
			}
			const viewport = term.getViewport().map(line => line.trim());
			expect(viewport.every(line => /^row-\d+$/.test(line))).toBeTruthy();
			const viewportRows = viewport.map(line => Number.parseInt(line.slice(4), 10));
			expect(viewportRows.at(-1)).toBe(51);
			expect(viewportRows[0]).toBeGreaterThanOrEqual(40);
		} finally {
			root.dispose();
		}
	});

	it("updates hardware cursor without redrawing content", () => {
		const term = new VirtualTerminal(40, 6);
		const [cursor, setCursor] = createSignal(0);
		const root = mountRows(term, () => ["cursor-anchor"], cursor);
		root.tui.setShowHardwareCursor(true);
		try {
			renderNow(root);
			const before = term.getScrollBuffer().length;
			for (let column = 0; column <= 10; column++) {
				setCursor(column);
				renderNow(root);
			}
			expect(term.getViewport()[0]?.trim()).toBe("cursor-anchor");
			expect(term.getScrollBuffer().length - before).toBeLessThan(2);
		} finally {
			root.dispose();
		}
	});

	it("limits scrollback growth during resize oscillation with overflowing content", () => {
		const term = new VirtualTerminal(60, 10);
		const [rows, setRows] = createSignal(buildRows(160));
		const root = mountRows(term, rows);
		try {
			renderNow(root);
			const before = term.getScrollBuffer().length;
			for (let index = 0; index < 18; index++) {
				setRows(buildRows(140 + (index % 6) * 8));
				term.resize(index % 2 === 0 ? 59 : 60, index % 3 === 0 ? 11 : 10);
				settleResize(root);
				expect(viewportRowNumbers(term).length).toBeGreaterThan(0);
			}
			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(220);
			expect(longestBlankRun(scrollback)).toBeLessThan(30);
		} finally {
			root.dispose();
		}
	});

	it("limits scrollback while toggling overlays over overflowing content", () => {
		const term = new VirtualTerminal(60, 10);
		const [rows, setRows] = createSignal(buildRows(150));
		const root = mountRows(term, rows);
		try {
			renderNow(root);
			const before = term.getScrollBuffer().length;
			for (let index = 0; index < 12; index++) {
				const overlay = showRowsOverlay(
					root,
					() => Array.from({ length: 3 }, (_value, row) => `overlay-${index}-${row}`),
					{ anchor: "center" },
				);
				renderNow(root);
				overlay.dispose();
				renderNow(root);
				if (index % 4 === 0) {
					setRows(buildRows(140 + (index % 4) * 10));
					renderNow(root);
				}
				expect(viewportRowNumbers(term).length).toBeGreaterThan(0);
			}
			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(320);
			expect(longestBlankRun(scrollback)).toBeLessThan(50);
		} finally {
			root.dispose();
		}
	});

	it("keeps scrollback bounded under rapid micro-resize oscillation", () => {
		const term = new VirtualTerminal(80, 12);
		const root = mountRows(term, () => buildRows(180));
		try {
			renderNow(root);
			const before = term.getScrollBuffer().length;
			for (let index = 0; index < 24; index++) {
				term.resize(index % 2 === 0 ? 79 : 80, index % 3 === 0 ? 11 : 12);
				settleResize(root);
				expect(viewportRowNumbers(term).length).toBeGreaterThan(0);
			}
			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(320);
			expect(longestBlankRun(scrollback)).toBeLessThan(60);
		} finally {
			root.dispose();
		}
	});

	it("avoids scrollback growth on repeated no-op renders with overflowing content", () => {
		const term = new VirtualTerminal(70, 10);
		const root = mountRows(term, () => buildRows(130));
		try {
			renderNow(root);
			const before = term.getScrollBuffer().length;
			for (let index = 0; index < 16; index++) renderNow(root);
			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(30);
		} finally {
			root.dispose();
		}
	});

	it("stays stable with direct row-delta movement", () => {
		const term = new VirtualTerminal(50, 10);
		const [rows, setRows] = createSignal(buildRows(150));
		const root = mountRows(term, rows);
		try {
			renderNow(root);
			const before = term.getScrollBuffer().length;
			for (let index = 0; index < 18; index++) {
				setRows(buildRows(120 + (index % 8) * 6));
				term.resize(index % 2 === 0 ? 50 : 49, index % 3 === 0 ? 11 : 10);
				settleResize(root);
				expect(viewportRowNumbers(term).length).toBeGreaterThan(0);
			}
			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(260);
			expect(longestBlankRun(scrollback)).toBeLessThan(40);
		} finally {
			root.dispose();
		}
	});
});
