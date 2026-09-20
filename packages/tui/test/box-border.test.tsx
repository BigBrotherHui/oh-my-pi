import { describe, expect, it } from "bun:test";
import { ansi16, ansi256, Style } from "../src/core/style";
import type { BoxBorder } from "../src/host/elements/box";
import { renderToRows } from "../src/testing";

const CHARS: NonNullable<BoxBorder["chars"]> = {
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	horizontal: "-",
	vertical: "|",
};

function borderedBox(border: BoxBorder | false = { chars: CHARS, color: Style.of({ fg: ansi16(31) }) }) {
	return () => (
		<box
			padding={{ x: 1, y: 0 }}
			border={border === false ? undefined : border}
			style={Style.of({ bg: ansi256(236) })}
		>
			<text>hi</text>
		</box>
	);
}

const widths = (rows: readonly string[]) => rows.map(row => Bun.stringWidth(Bun.stripANSI(row)));
const plain = (rows: readonly string[]) => rows.map(row => Bun.stripANSI(row));

describe("box border", () => {
	it("frames content without exceeding the allocated width", () => {
		const rows = renderToRows(borderedBox(), 20);
		expect(rows).toHaveLength(3);
		for (const width of widths(rows)) expect(width).toBe(20);
		const flat = plain(rows);
		expect(flat[0]).toBe(`+${"-".repeat(18)}+`);
		expect(flat[2]).toBe(`+${"-".repeat(18)}+`);
		expect(flat[1]).toContain("hi");
	});

	it("paints the supplied border style and honors a borderless layout", () => {
		const bordered = renderToRows(borderedBox(), 20);
		expect(bordered[0]).toContain("\x1b[31;48;5;236m");
		const borderless = renderToRows(borderedBox(false), 20);
		expect(borderless).toHaveLength(1);
		expect(Bun.stringWidth(Bun.stripANSI(borderless[0]!))).toBe(20);
		expect(Bun.stripANSI(borderless[0]!)).not.toContain("+");
	});

	it("drops border chrome when the interior cannot fit", () => {
		for (const width of [3, 4]) {
			const rows = renderToRows(borderedBox(), width);
			for (const row of plain(rows)) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
			for (const row of plain(rows)) expect(row).not.toContain("+");
		}
	});
});
