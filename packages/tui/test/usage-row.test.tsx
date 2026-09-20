import { beforeAll, describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { cellGrid } from "./cell-grid";
import { UsageRow, formatUsageRow } from "../src/overlays/usage-row";
import { renderToRows } from "../src/testing";
import { initTheme, theme } from "../src/theme";
import "../src/host/elements/box";
import "../src/host/elements/br";
import "../src/host/elements/stack";
import "../src/host/elements/text";

const USAGE: Usage = {
	input: 11,
	output: 22,
	cacheRead: 33,
	cacheWrite: 44,
	totalTokens: 110,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const TIMESTAMP = new Date(2026, 0, 2, 3, 4, 5).getTime();

beforeAll(async () => {
	await initTheme();
});

describe("usage row", () => {
	it("keeps every completed-turn metric in its historical declaration order", () => {
		expect(formatUsageRow(USAGE, 2_500, 1_700, TIMESTAMP, 60_000)).toBe(
			`2026-01-02 03:04:05  Δ 1m  ${theme.icon.input} 55  ${theme.icon.output} 22  ${theme.icon.cache} 33  ${theme.icon.time} 1.7s  ${theme.icon.throughput} 8.8/s`,
		);
	});

	it("omits unavailable duration, cache, and turn-time metrics instead of rendering placeholders", () => {
		const noOptionalMetrics: Usage = { ...USAGE, cacheRead: 0 };
		expect(formatUsageRow(noOptionalMetrics, 100, 0)).toBe(`${theme.icon.input} 55  ${theme.icon.output} 22`);
	});

	it("preserves the historical blank separator and two-cell outer padding when wrapping", () => {
		const width = 11;
		const rows = renderToRows(() => UsageRow({ usage: USAGE, timestamp: TIMESTAMP }), width);
		const text = rows.map(Bun.stripANSI);
		const cells = cellGrid(rows, width);

		expect(text[0]).toBe("");
		expect(text[1]).toBe(" 2026-01-0 ");
		expect(cells[1]![0]!.fg).toBeNull();
		expect(cells[1]![1]!.fg).not.toBeNull();
		expect(cells[1]![width - 1]!.fg).toBeNull();
	});
});
