import { describe, expect, it } from "bun:test";
import { createSignal, type Setter } from "../src/reactive";
import { StrippedToolCallsPlaceholderView } from "../src/chat/stripped-tool-calls-placeholder";
import { mountForTest } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";
import { setTuiTight } from "../src/utils";
import { cellGrid } from "./cell-grid";
import "../src/host/elements/box";
import "../src/host/elements/text";

function message(count: number): string {
	return `${count} tool call${count === 1 ? "" : "s"} elided — no result on this branch`;
}

const palette = loadThemeSync("dark", { mode: "truecolor" });

function rendered(count: number, width: number, visible = true): string[] {
	const root = mountForTest(() => <StrippedToolCallsPlaceholderView strippedToolCalls={count} visible={visible} />, {
		width,
		theme: palette,
	});
	try {
		return root.rows();
	} finally {
		root.dispose();
	}
}

describe("StrippedToolCallsPlaceholderView", () => {
	it("keeps the historical inset, dim italic marker, and pluralized count", () => {
		const width = 80;
		const text = message(2);
		const rows = rendered(2, width);
		const plain = Bun.stripANSI(rows[0]!);

		expect(rows).toHaveLength(1);
		expect(plain).toBe(` ${text} ${" ".repeat(width - Bun.stringWidth(text) - 2)}`);

		const cells = cellGrid(rows, width)[0]!;
		expect(cells[0]!.attrs).toMatchObject({ dim: false, italic: false });
		const dimColor = cellGrid([palette.fg("dim", "x")], 1)[0]![0]!.fg;
		for (let column = 1; column <= Bun.stringWidth(text); column++) {
			expect(cells[column]!.attrs.italic).toBe(true);
			expect(cells[column]!.fg).toEqual(dimColor);
		}
		expect(cells[Bun.stringWidth(text) + 1]!.attrs).toMatchObject({ dim: false, italic: false });
	});

	it("wraps inside its one-cell margins without losing the singular marker", () => {
		const width = 18;
		const rows = rendered(1, width);
		const plain = rows.map(row => Bun.stripANSI(row));

		expect(rows.length).toBeGreaterThan(1);
		for (const row of plain) {
			expect(Bun.stringWidth(row)).toBe(width);
			expect(row.startsWith(" ")).toBe(true);
			expect(row.endsWith(" ")).toBe(true);
		}
		expect(plain.map(row => row.trim()).join(" ")).toBe(message(1));
	});

	it("removes and restores the marker when tool activity visibility changes", () => {
		let setVisible: Setter<boolean> | undefined;
		const root = mountForTest(() => {
			const [visible, set] = createSignal(false);
			setVisible = set;
			return <StrippedToolCallsPlaceholderView strippedToolCalls={2} visible={visible()} />;
		});
		try {
			expect(root.text()).toEqual([]);
			if (setVisible === undefined) throw new Error("visibility signal was not initialized");
			setVisible(true);
			expect(root.text().join("\n")).toContain(message(2));
		} finally {
			root.dispose();
		}
	});

	it("removes its margins live in tight layout", () => {
		setTuiTight(false);
		const root = mountForTest(() => <StrippedToolCallsPlaceholderView strippedToolCalls={2} visible />);
		try {
			expect(root.text()[0]!).toStartWith(" ");
			setTuiTight(true);
			expect(root.text()[0]!).toStartWith(message(2));
		} finally {
			setTuiTight(false);
			root.dispose();
		}
	});
});
