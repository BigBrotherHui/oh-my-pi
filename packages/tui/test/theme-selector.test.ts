import { describe, expect, it } from "bun:test";
import { focusNext } from "../src/host/focus";
import { dispatchHostInput } from "../src/host/overlay";
import { dispatchMouse, HostMouseEvent } from "../src/host/input";
import { ThemeSelectorView } from "../src/overlays/theme-selector";
import { mountForTest } from "../src/testing";

describe("theme selector", () => {
	it("previews navigation, selects the highlighted theme, and delegates cancellation", () => {
		const selected: string[] = [];
		const previews: string[] = [];
		let cancelled = 0;
		const root = mountForTest(() =>
			ThemeSelectorView({
				currentTheme: "dark",
				themes: ["dark", "light", "nord"],
				onSelect: theme => selected.push(theme),
				onCancel: () => {
					cancelled += 1;
				},
				onPreview: theme => previews.push(theme),
			}),
		);
		try {
			focusNext(root.root.node);
			dispatchHostInput(root.root, "\x1b[B");
			expect(previews).toEqual(["light"]);
			dispatchHostInput(root.root, "\n");
			expect(selected).toEqual(["light"]);
			dispatchHostInput(root.root, "\x1b");
			expect(cancelled).toBe(1);
		} finally {
			root.dispose();
		}
	});

	it("keeps the historical one-row border offset for mouse activation", () => {
		const selected: string[] = [];
		const root = mountForTest(() =>
			ThemeSelectorView({
				currentTheme: "alpha",
				themes: ["alpha", "beta"],
				onSelect: theme => selected.push(theme),
				onCancel: () => {},
				onPreview: () => {},
			}),
		);
		try {
			root.rows();
			dispatchMouse(root.root, new HostMouseEvent({ row: 0, col: 0 }));
			expect(selected).toEqual([]);

			dispatchMouse(root.root, new HostMouseEvent({ row: 1, col: 0 }));
			expect(selected).toEqual(["alpha"]);
		} finally {
			root.dispose();
		}
	});

	it("fuzzy-filters overflowing themes while retaining the selected preview", () => {
		const previews: string[] = [];
		const themes = ["dark", "light", "nord", "one", "two", "three", "four", "five", "six", "seven", "eight"];
		const root = mountForTest(() =>
			ThemeSelectorView({
				currentTheme: "dark",
				themes,
				onSelect: () => {},
				onCancel: () => {},
				onPreview: theme => previews.push(theme),
			}),
		);
		try {
			focusNext(root.root.node);
			dispatchHostInput(root.root, "d");
			expect(root.text().join("\n")).toContain("Search: d");
			expect(previews).toEqual([]);
		} finally {
			root.dispose();
		}
	});

	it("renders the current marker, overflow search affordance, and a clipped narrow frame", () => {
		const themes = ["dark", "light", "nord", "one", "two", "three", "four", "five", "six", "seven", "eight"];
		const root = mountForTest(() =>
			ThemeSelectorView({
				currentTheme: "dark",
				themes,
				onSelect: () => {},
				onCancel: () => {},
				onPreview: () => {},
			}),
		);
		try {
			expect(root.text(80).join("\n")).toContain("dark");
			expect(root.text(80).join("\n")).toContain("(current)");
			expect(root.text(80).join("\n")).toContain("Type to search");
			for (const row of root.text(12)) expect(row.length).toBeLessThanOrEqual(12);
		} finally {
			root.dispose();
		}
	});
});
