import { describe, expect, it } from "bun:test";
import { focusNext } from "../src/host/focus";
import { dispatchHostInput } from "../src/host/overlay";
import { createSelectController, SelectOverlay, type SelectController } from "../src/overlays/select-overlay";
import { createSignal } from "../src/reactive";
import { mountForTest } from "../src/testing";

describe("SelectOverlay", () => {
	it("uses aligned wide descriptions, hides them in narrow viewports, and shows a selected hint", () => {
		const root = mountForTest(() =>
			SelectOverlay({
				title: "Choose",
				maxRows: 3,
				onCancel() {},
				onSelect() {},
				options: [
					{ value: "one", label: "One", description: "first\nline", hint: "current" },
					{ value: "two", label: "Two", description: "second line" },
					{ value: "three", label: "Three" },
				],
			}),
		);
		try {
			const wide = root.text(80).join("\n");
			expect(wide).toContain("first line");
			expect(wide).toContain("second line");
			expect(wide).toContain("current");

			const narrow = root.text(40).join("\n");
			expect(narrow).toContain("One");
			expect(narrow).toContain("Two");
			expect(narrow).not.toContain("first line");
			expect(narrow).not.toContain("second line");
		} finally {
			root.dispose();
		}
	});

	it("wraps arrows, pages by visible rows, and confirms the retained selection", () => {
		const selected: string[] = [];
		const root = mountForTest(() =>
			SelectOverlay({
				title: "Choose",
				maxRows: 3,
				onCancel() {},
				onSelect(value) {
					selected.push(value);
				},
				options: Array.from({ length: 8 }, (_, index) => ({ value: `item-${index}`, label: `Item ${index}` })),
			}),
		);
		try {
			focusNext(root.root.node);
			dispatchHostInput(root.root, "\x1b[A");
			dispatchHostInput(root.root, "\n");
			expect(selected).toEqual(["item-7"]);

			dispatchHostInput(root.root, "\x1b[H");
			dispatchHostInput(root.root, "\x1b[6~");
			expect(root.text(80).join("\n")).toContain("Item 3");
			dispatchHostInput(root.root, "\n");
			expect(selected).toEqual(["item-7", "item-3"]);

			dispatchHostInput(root.root, "\x1b[F");
			expect(root.text(80).join("\n")).toContain("Item 7");
		} finally {
			root.dispose();
		}
	});

	it("fuzzy-filters overflowing lists with hint text", () => {
		const selected: string[] = [];
		const root = mountForTest(() =>
			SelectOverlay({
				title: "Providers",
				maxRows: 3,
				onCancel() {},
				onSelect(value) {
					selected.push(value);
				},
				options: [
					{ value: "ollama", label: "Ollama" },
					{ value: "kagi", label: "Kagi" },
					{ value: "opencode-go", label: "OpenCode Go", hint: "gateway" },
					{ value: "tavily", label: "Tavily" },
				],
			}),
		);
		try {
			focusNext(root.root.node);
			dispatchHostInput(root.root, "g");
			dispatchHostInput(root.root, "a");
			dispatchHostInput(root.root, "t");
			dispatchHostInput(root.root, "e");
			const filtered = root.text(80).join("\n");
			expect(filtered).toContain("Search: gate");
			expect(filtered).toContain("OpenCode Go");
			expect(filtered).not.toContain("Ollama");
			dispatchHostInput(root.root, "\x7f");
			expect(root.text(80).join("\n")).toContain("Search: gat");
			dispatchHostInput(root.root, "e");
			dispatchHostInput(root.root, "\n");
			expect(selected).toEqual(["opencode-go"]);
		} finally {
			root.dispose();
		}
	});

	it("centers selection and reconciles disabled rows reactively", () => {
		const initialOptions = Array.from({ length: 12 }, (_, index) => ({
			value: String(index),
			label: `Item ${index}`,
			disabled: index === 6,
		}));
		let controller!: SelectController;
		let setOptions!: (value: typeof initialOptions) => typeof initialOptions;
		const root = mountForTest(() => {
			const [options, set] = createSignal(initialOptions);
			setOptions = set;
			controller = createSelectController({
				options,
				maxRows: () => 5,
				scrollPolicy: "center",
			});
			return SelectOverlay({ title: "Choose", options: initialOptions, maxRows: 5, onSelect() {}, onCancel() {} });
		});
		try {
			controller.selectIndex(7);
			expect(controller.offset()).toBe(5);
			controller.selectIndex(11);
			expect(controller.offset()).toBe(7);
			controller.setHoveredIndex(6);
			expect(controller.hoveredIndex()).toBeUndefined();
			controller.setHoveredIndex(7);
			expect(controller.hoveredIndex()).toBe(7);

			setOptions(initialOptions.map(option => (option.value === "11" ? { ...option, disabled: true } : option)));
			root.flush();
			expect(controller.selectedIndex()).toBe(0);
			expect(controller.hoveredIndex()).toBeUndefined();
		} finally {
			root.dispose();
		}
	});
});
