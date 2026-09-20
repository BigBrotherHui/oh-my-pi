import { describe, expect, it } from "bun:test";
import { VerticalLayoutFixture } from "../../src/contract/vertical-layout";
import { mountOverlay, Portal } from "../../src/host/overlay";
import { createSignal } from "../../src/reactive";
import { render } from "../../src/root";
import { loadThemeSync } from "../../src/theme/loader";
import { VirtualTerminal } from "../virtual-terminal";

describe("native vertical allocation", () => {
	it("keeps fixed chrome visible while resizing and wrapping the header", () => {
		const terminal = new VirtualTerminal(24, 10);
		const [header, setHeader] = createSignal("Header");
		const root = render(
			() => (
				<VerticalLayoutFixture header={header()}>
					<text>{Array.from({ length: 20 }, (_, index) => `body ${index}`).join("\n")}</text>
				</VerticalLayoutFixture>
			),
			{
				terminal,
				theme: loadThemeSync("dark"),
			},
		);
		try {
			root.tui.renderNow();
			let rows = terminal.getViewport();
			expect(rows[1]).toContain("Header");
			expect(rows[7]).toContain("body 5");
			expect(rows[8]).toContain("Footer");
			setHeader("A header that wraps across several terminal rows");
			root.tui.renderNow();
			rows = terminal.getViewport();
			expect(rows[2]).toContain("across several");
			expect(rows[7]).toContain("body 3");
			expect(rows[8]).toContain("Footer");
			terminal.resize(24, 7);
			root.tui.renderNow();
			rows = terminal.getViewport();
			expect(rows[5]).toContain("Footer");
			expect(rows.filter(row => row.includes("body "))).toHaveLength(1);
		} finally {
			root.dispose();
		}
	});

	it("allocates an anchored overlay from its height cap rather than terminal height", () => {
		const terminal = new VirtualTerminal(30, 16);
		const root = render(() => <text>Base</text>, { terminal, theme: loadThemeSync("dark") });
		const overlay = mountOverlay(root.tui, () => (
			<Portal to="overlay" anchor="bottom-center" width="100%" maxHeight={6}>
				<VerticalLayoutFixture header="Overlay">
					<text>{"content\n".repeat(20)}</text>
				</VerticalLayoutFixture>
			</Portal>
		));
		try {
			root.tui.renderNow();
			const rows = terminal.getViewport();
			expect(rows[11]).toContain("Overlay");
			expect(rows[14]).toContain("Footer");
			expect(rows.filter(row => row.includes("content"))).toHaveLength(2);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});
});
