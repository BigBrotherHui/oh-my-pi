import { describe, expect, it } from "bun:test";
import { createHookSelectorController, HookSelectorView } from "../src/overlays/hook-selector";
import { HostMouseEvent } from "../src/host/input";
import { mountForTest } from "../src/testing";

describe("hook selector", () => {
	it("keeps a bounded selectable cursor", () => {
		const controller = createHookSelectorController(
			"Choose",
			["One", "Two"],
			() => {},
			() => {},
			{ initialIndex: 1 },
		);
		expect(controller.selectedIndex()).toBe(1);
	});

	it("skips disabled options without wrapping at the list edge", () => {
		const controller = createHookSelectorController(
			"Choose",
			["First", "Disabled", "Third"],
			() => {},
			() => {},
			{ disabledIndices: [1] },
		);

		controller.selection.move(1, false);
		expect(controller.selectedIndex()).toBe(2);

		controller.selection.move(1, false);
		expect(controller.selectedIndex()).toBe(2);
	});

	it("confirms numbered options but leaves checkbox menus on their cursor", () => {
		const selected: string[] = [];
		const single = createHookSelectorController(
			"Choose",
			["Detected", "1. First", "2. Second"],
			option => selected.push(option),
			() => {},
		);
		single.handleInput("2");
		expect(selected).toEqual(["2. Second"]);

		const many = createHookSelectorController(
			"Choose",
			["1. First", "2. Second"],
			option => selected.push(option),
			() => {},
			{ selectionMarker: "checkbox" },
		);
		many.handleInput("2");
		expect(many.selectedIndex()).toBe(1);
		expect(selected).toEqual(["2. Second"]);
		many.select();
		expect(selected).toEqual(["2. Second", "2. Second"]);
	});

	it("filters overflowing option lists through the shared selector state", () => {
		const selected: string[] = [];
		const controller = createHookSelectorController(
			"Choose provider",
			["Ollama", "Kagi", "OpenCode Go", "Tavily"],
			option => selected.push(option),
			() => {},
			{ maxVisible: 3 },
		);

		controller.handleInput("o");
		controller.handleInput("g");
		expect(controller.query()).toBe("og");
		controller.select();
		expect(selected).toEqual(["OpenCode Go"]);
	});

	it("activates the row hit by a mouse click", () => {
		const selected: string[] = [];
		const controller = createHookSelectorController(
			"Choose",
			["First", "Second"],
			option => selected.push(option),
			() => {},
		);

		controller.handleMouse(new HostMouseEvent({ row: 0, col: 0, action: "down" }), 1);
		expect(selected).toEqual(["Second"]);
	});

	it("enables freeform filtering when option descriptions consume the row budget", () => {
		const controller = createHookSelectorController(
			"Choose",
			[
				{ label: "Path A", description: "Reuse existing credentials." },
				{ label: "Path B", description: "Open a browser authorization flow." },
				{ label: "Path C", description: "Edit provider keys manually." },
				{ label: "Path D", description: "Continue without provider access." },
			],
			() => {},
			() => {},
			{ maxVisible: 6 },
		);

		for (const key of "browser") controller.handleInput(key);
		expect(controller.searchEnabled()).toBe(true);
		expect(controller.query()).toBe("browser");
		expect(controller.selection.options().map(option => option.label)).toEqual(["Path B"]);
	});

	it("keeps every compact option label while expanding only the selected description", () => {
		const root = mountForTest(
			() => {
				const controller = createHookSelectorController(
					"Choose",
					[
						{ label: "Path A", description: "Reuse existing credentials." },
						{ label: "Path B", description: "Open a browser authorization flow." },
						{ label: "Path C", description: "Edit provider keys manually." },
						{ label: "Path D", description: "Continue without provider access." },
					],
					() => {},
					() => {},
					{ outline: true, maxVisible: 6 },
				);
				return HookSelectorView({
					title: "Choose",
					options: [
						{ label: "Path A", description: "Reuse existing credentials." },
						{ label: "Path B", description: "Open a browser authorization flow." },
						{ label: "Path C", description: "Edit provider keys manually." },
						{ label: "Path D", description: "Continue without provider access." },
					],
					controller,
					settings: { outline: true, maxVisible: 6 },
				});
			},
			{ width: 76 },
		);

		try {
			const rendered = root.text().join("\n");
			expect(rendered).toContain("Path A");
			expect(rendered).toContain("Path D");
			expect(rendered).toContain("Reuse existing credentials.");
			expect(rendered).not.toContain("Open a browser authorization flow.");
		} finally {
			root.dispose();
		}
	});

	it("keeps multiline detail, outlined rows, and selection markers visible", () => {
		const root = mountForTest(() => {
			const controller = createHookSelectorController(
				"Choose account\nThe selected account will receive the request.",
				[
					{ label: "Primary", description: "Use the primary account." },
					{ label: "Secondary", description: "Use a separate account." },
					"Other",
				],
				() => {},
				() => {},
				{ initialIndex: 2, outline: true, selectionMarker: "radio", markableCount: 2 },
			);
			return HookSelectorView({
				title: "Choose account\nThe selected account will receive the request.",
				options: [
					{ label: "Primary", description: "Use the primary account." },
					{ label: "Secondary", description: "Use a separate account." },
					"Other",
				],
				controller,
				settings: { initialIndex: 2, outline: true, selectionMarker: "radio", markableCount: 2 },
			});
		});

		try {
			const rendered = root.text().join("\n");
			expect(rendered).toContain("The selected account will receive the request.");
			expect(rendered).toContain(`${root.root.theme.symbol("radio.unselected")} Primary`);
			expect(rendered).toContain(`${root.root.theme.symbol("nav.cursor")} Other`);
		} finally {
			root.dispose();
		}
	});
});
