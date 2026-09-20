import { describe, expect, test } from "bun:test";
import { focusNext } from "../src/host/focus";
import { dispatchHostInput } from "../src/host/overlay";
import type { SelectOption } from "../src/host/elements/select";
import { createSelectController, type SelectController, SelectOverlay } from "../src/overlays/select-overlay";
import { createRoot, createSignal } from "../src/reactive";
import { mountForTest } from "../src/testing";

const items: SelectOption[] = [
	{ value: "a", label: "a" },
	{ value: "disabled", label: "disabled", disabled: true },
	{ value: "b", label: "b" },
	{ value: "c", label: "c" },
];

function withController(
	run: (controller: SelectController, setOptions: (options: readonly SelectOption[]) => void) => void,
): void {
	createRoot(dispose => {
		const [options, setOptions] = createSignal<readonly SelectOption[]>(items);
		const controller = createSelectController({
			options,
			maxRows: () => 4,
			scrollPolicy: "center",
		});
		try {
			run(controller, setOptions);
		} finally {
			dispose();
		}
	});
}

describe("native selection", () => {
	test("skips disabled options, wraps, and requires confirmation before selecting", () => {
		const selected: string[] = [];
		const root = mountForTest(() =>
			SelectOverlay({
				title: "Choose",
				options: items,
				maxRows: 4,
				confirmation: value => (value === "b" ? "Confirm b" : undefined),
				onSelect: value => selected.push(value),
				onCancel() {},
			}),
		);
		try {
			focusNext(root.root.node);
			dispatchHostInput(root.root, "\x1b[B");
			dispatchHostInput(root.root, "\n");
			expect(selected).toEqual([]);
			expect(root.text().join("\n")).toContain("Confirm b");

			dispatchHostInput(root.root, "\n");
			expect(selected).toEqual(["b"]);

			dispatchHostInput(root.root, "\x1b[B");
			dispatchHostInput(root.root, "\x1b[B");
			dispatchHostInput(root.root, "\n");
			expect(selected).toEqual(["b", "a"]);
		} finally {
			root.dispose();
		}
	});

	test("retains the selected value through reordered options and keeps it inside the centered row window", () => {
		withController((controller, setOptions) => {
			controller.selectValue("b");
			setOptions([items[3]!, items[0]!, items[2]!]);
			expect(controller.selectedIndex()).toBe(2);

			setOptions(Array.from({ length: 12 }, (_, index) => ({ value: `item-${index}`, label: `Item ${index}` })));
			controller.selectIndex(7);
			expect(controller.offset()).toBe(5);
		});
	});
});
