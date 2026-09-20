import { describe, expect, it } from "bun:test";
import { rgb } from "../../src/core/style";
import { createSignal } from "../../src/reactive";
import { mountForTest } from "../../src/testing";
import { loadThemeSync } from "../../src/theme/loader";
import { cellGrid } from "../cell-grid";

describe("retained style bindings", () => {
	it("reallocates adjacent text when a status glyph changes natural width", () => {
		const [settled, setSettled] = createSignal(false);
		const theme = loadThemeSync("dark", { symbolPresetOverride: "ascii" });
		const root = mountForTest(
			() => (
				<row gap={1}>
					<status value={settled() ? "done" : "success"} />
					<text>result</text>
				</row>
			),
			{ width: 20, theme },
		);
		try {
			expect(root.text()[0]?.trimEnd()).toBe(`${theme.symbol("status.success")} result`);
			setSettled(true);
			expect(root.text()[0]?.trimEnd()).toBe(`${theme.symbol("status.done")} result`);
		} finally {
			root.dispose();
		}
	});
	it("updates inherited styles through a cached container and adopted header slot", () => {
		const [active, setActive] = createSignal(false);
		const root = mountForTest(
			() => (
				<stack color={active() ? rgb(255, 0, 0) : rgb(0, 255, 0)}>
					<text>child</text>
					<frame title={<text>title</text>} paddingY={0}>
						<text>body</text>
					</frame>
				</stack>
			),
			{ width: 20 },
		);
		try {
			const first = cellGrid(root.rows(), 20);
			setActive(true);
			const next = cellGrid(root.rows(), 20);
			expect(next[0]![0]!.fg).not.toEqual(first[0]![0]!.fg);
			expect(next[2]![2]!.fg).not.toEqual(first[2]![2]!.fg);
		} finally {
			root.dispose();
		}
	});

	it("updates block and inline colors, attributes, and hyperlinks without changing text", () => {
		const [active, setActive] = createSignal(false);
		const root = mountForTest(
			() => (
				<text color={active() ? rgb(255, 0, 0) : rgb(0, 255, 0)}>
					<span bold={active()} link={active() ? "https://example.com/active" : "https://example.com/idle"}>
						label
					</span>
				</text>
			),
			{ width: 20 },
		);
		try {
			const before = cellGrid(root.rows(), 20)[0]![0]!;
			setActive(true);
			const after = cellGrid(root.rows(), 20)[0]![0]!;
			expect(after.fg).not.toEqual(before.fg);
			expect(after.attrs.bold).toBe(true);
			expect(after.link).toBe("https://example.com/active");
		} finally {
			root.dispose();
		}
	});
});
