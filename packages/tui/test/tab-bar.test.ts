import { describe, expect, it } from "bun:test";
import { TabBarView } from "../src/components/tab-bar";
import { dispatchMouse, HostMouseEvent } from "../src/host/input";
import { focusNext } from "../src/host/focus";
import { dispatchHostInput } from "../src/host/overlay";
import { createSignal } from "../src/reactive";
import { mountForTest, renderToText } from "../src/testing";

describe("TabBarView", () => {
	it("wraps complete styled chunks without blank rows", () => {
		const rows = renderToText(
			() =>
				TabBarView({
					label: "Settings",
					active: "ttsr",
					tabs: [
						{ id: "display", label: "Display" },
						{ id: "agent", label: "Agent" },
						{ id: "input", label: "Input" },
						{ id: "tools", label: "Tools" },
						{ id: "config", label: "Config" },
						{ id: "services", label: "Services" },
						{ id: "bash", label: "Bash" },
						{ id: "lsp", label: "LSP" },
						{ id: "ttsr", label: "TTSR" },
						{ id: "plugins", label: "Plugins" },
					],
				}),
			55,
		);
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.every(row => row.trim().length > 0)).toBe(true);
		expect(rows.join("\n")).toContain("TTSR");
		expect(rows.join("\n")).toContain("(tab to cycle)");
	});

	it("collapses tabs farthest from the active tab before wrapping", () => {
		const rows = renderToText(
			() =>
				TabBarView({
					active: "tab0",
					showHint: false,
					tabs: Array.from({ length: 8 }, (_, index) => ({
						id: `tab${index}`,
						label: `⊕ Section ${index}`,
						short: "⊕",
					})),
				}),
			60,
		);
		const text = rows.join("\n");
		expect(rows).toHaveLength(1);
		expect(text).toContain("Section 0");
		expect(text).toContain("Section 1");
		expect(text).not.toContain("Section 2");
		expect(text).not.toContain("Section 7");
	});

	it("cycles enabled tabs through the controlled selection callback", () => {
		const selected: string[] = [];
		const mounted = mountForTest(() => {
			const [active, setActive] = createSignal<string>("a");
			return TabBarView({
				get active() {
					return active();
				},
				showHint: false,
				tabIndex: 0,
				tabs: [
					{ id: "a", label: "A" },
					{ id: "b", label: "B", disabled: true },
					{ id: "c", label: "C" },
				],
				onSelect(tab) {
					selected.push(tab.id);
					setActive(tab.id);
				},
			});
		});
		try {
			mounted.rows();
			focusNext(mounted.root.node);

			dispatchHostInput(mounted.root, "\t");
			expect(selected).toEqual(["c"]);

			mounted.text();
			dispatchHostInput(mounted.root, "\x1b[D");
			expect(selected).toEqual(["c", "a"]);
		} finally {
			mounted.dispose();
		}
	});

	it("highlights hovered enabled tabs and ignores disabled pointer selection", () => {
		const selected: string[] = [];
		const mounted = mountForTest(() => {
			const [active, setActive] = createSignal<string>("a");
			return TabBarView({
				get active() {
					return active();
				},
				showHint: false,
				tabs: [
					{ id: "a", label: "A" },
					{ id: "b", label: "Disabled", disabled: true },
					{ id: "c", label: "C" },
				],
				onSelect(tab) {
					selected.push(tab.id);
					setActive(tab.id);
				},
			});
		});
		try {
			const initial = mounted.rows().join("\n");

			dispatchMouse(mounted.root, new HostMouseEvent({ row: 0, col: 6, action: "down" }));
			expect(selected).toEqual([]);

			dispatchMouse(mounted.root, new HostMouseEvent({ row: 0, col: 18, action: "move" }));
			expect(mounted.rows().join("\n")).not.toEqual(initial);

			dispatchMouse(mounted.root, new HostMouseEvent({ row: 0, col: 18, action: "down" }));
			expect(selected).toEqual(["c"]);
		} finally {
			mounted.dispose();
		}
	});
});
