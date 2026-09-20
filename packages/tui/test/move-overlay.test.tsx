import { describe, expect, it } from "bun:test";
import {
	openMoveOverlay,
	type MoveDirectoryEntry,
	type MoveDirectorySource,
	type MoveOverlayResult,
} from "../src/overlays/move-overlay";
import { render } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";
import { VirtualTerminal } from "./virtual-terminal";

function directorySource(entries: readonly MoveDirectoryEntry[], limits?: number[]): MoveDirectorySource {
	return {
		search(prefix, _cwd, maximum) {
			limits?.push(maximum);
			const needle = prefix.toLowerCase();
			return entries
				.filter(entry => entry.label.toLowerCase().includes(needle) || entry.value.toLowerCase().includes(needle))
				.slice(0, maximum);
		},
	};
}

describe("move overlay", () => {
	it("renders the historical directory picker while retrieving its autocomplete buffer", () => {
		const terminal = new VirtualTerminal(80, 30);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const limits: number[] = [];
		const entries = Array.from({ length: 20 }, (_, index) => ({
			value: `/workspace/directory-${index}`,
			label: `directory-${index}/`,
		}));
		const overlay = openMoveOverlay(root.tui, "/workspace", () => {}, directorySource(entries, limits));
		try {
			root.tui.renderNow();
			const view = terminal.getViewport().join("\n");
			expect(view).toContain("Move to directory");
			expect(view).toContain("Path:");
			expect(view).toContain("directory-14/");
			expect(view).not.toContain("directory-15/");
			expect(view).toContain("Type to filter · ↑↓ navigate · Tab accept · Enter confirm · Esc cancel");
			expect(limits).toContain(20);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});

	it("clamps selection, accepts the highlighted path, and cancels with Control-C", () => {
		const terminal = new VirtualTerminal(80, 20);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const selected: Array<MoveOverlayResult | undefined> = [];
		const overlay = openMoveOverlay(
			root.tui,
			"/workspace",
			result => selected.push(result),
			directorySource([
				{ value: "/workspace/alpha", label: "alpha/" },
				{ value: "/workspace/beta", label: "beta/" },
			]),
		);
		try {
			terminal.sendInput("\x1b[B");
			terminal.sendInput("\x1b[B");
			terminal.sendInput("\r");
			terminal.sendInput("\x03");
			expect(selected).toEqual([{ directory: "/workspace/beta" }, undefined]);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});

	it("accepts the highlighted entry through Tab completion", () => {
		const terminal = new VirtualTerminal(80, 20);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const selected: Array<MoveOverlayResult | undefined> = [];
		const overlay = openMoveOverlay(
			root.tui,
			"/workspace",
			result => selected.push(result),
			directorySource([{ value: "/workspace/alpha", label: "alpha/" }]),
		);
		try {
			terminal.sendInput("\t");
			terminal.sendInput("\r");
			expect(selected).toEqual([{ directory: "/workspace/alpha" }]);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});

	it("uses the native input's bracketed-paste path", () => {
		const terminal = new VirtualTerminal(80, 20);
		const root = render(() => <box />, { terminal, theme: loadThemeSync("dark") });
		const selected: Array<MoveOverlayResult | undefined> = [];
		const overlay = openMoveOverlay(root.tui, "/workspace", result => selected.push(result), directorySource([]));
		try {
			terminal.sendInput("\x1b[200~missing\nø\x1b[201~");
			terminal.sendInput("\r");
			expect(selected).toEqual([{ directory: "missingø" }]);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});
});
