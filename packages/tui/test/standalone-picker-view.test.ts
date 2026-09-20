import { describe, expect, it } from "bun:test";
import { dispatchHostInput } from "../src/host/overlay";
import { dispatchMouse, HostMouseEvent } from "../src/host/input";
import { StandaloneInputView, StandaloneSelectView } from "../src/apps/standalone-picker-view";
import { mountForTest } from "../src/testing";

describe("standalone picker views", () => {
	it("keeps the preselected entry centered, preserves wide/narrow descriptions, and confirms it", () => {
		const selected: Array<string | null> = [];
		const root = mountForTest(() =>
			StandaloneSelectView({
				items: Array.from({ length: 8 }, (_, index) => ({
					value: `item-${index}`,
					label: `Item ${index}`,
					description: `Description ${index}`,
				})),
				options: { currentValue: "item-5", maxVisible: 3 },
				onFinish(value) {
					selected.push(value);
				},
			}),
		);
		try {
			const wide = root.text(80).join("\n");
			expect(wide).toContain("Item 5");
			expect(wide).toContain("Description 5");
			expect(wide).not.toContain("Item 0");
			expect(wide).not.toContain("↑/↓ select");
			expect(wide).not.toContain("┌");

			const narrow = root.text(40).join("\n");
			expect(narrow).toContain("Item 5");
			expect(narrow).not.toContain("Description 5");

			dispatchHostInput(root.root, "\n");
			expect(selected).toEqual(["item-5"]);
		} finally {
			root.dispose();
		}
	});

	it("filters overflow and renders historical status and empty rows", () => {
		const finished: Array<string | null> = [];
		const root = mountForTest(() =>
			StandaloneSelectView({
				items: [
					{ value: "alpha", label: "Alpha" },
					{ value: "beta", label: "Beta" },
					{ value: "gateway", label: "Gateway" },
					{ value: "delta", label: "Delta" },
				],
				options: { maxVisible: 2 },
				onFinish(value) {
					finished.push(value);
				},
			}),
		);
		try {
			dispatchHostInput(root.root, "z");
			const filtered = root.text(80).join("\n");
			expect(filtered).toContain("  Search: z");
			expect(filtered).toContain("  No matching items");

			dispatchHostInput(root.root, "\x1b");
			expect(finished).toEqual([null]);
		} finally {
			root.dispose();
		}
	});

	it("honors direct row clicks", () => {
		const selected: Array<string | null> = [];
		const root = mountForTest(() =>
			StandaloneSelectView({
				items: [
					{ value: "alpha", label: "Alpha" },
					{ value: "beta", label: "Beta" },
				],
				options: {},
				onFinish(value) {
					selected.push(value);
				},
			}),
		);
		try {
			root.rows();
			dispatchMouse(root.root, new HostMouseEvent({ row: 1, col: 0 }));
			expect(selected).toEqual(["beta"]);
		} finally {
			root.dispose();
		}
	});

	it("submits trimmed text", () => {
		const finished: Array<string | null> = [];
		const root = mountForTest(() =>
			StandaloneInputView({
				onFinish(value) {
					finished.push(value);
				},
			}),
		);
		try {
			dispatchHostInput(root.root, "  keep me  ");
			dispatchHostInput(root.root, "\n");
			expect(finished).toEqual(["keep me"]);
		} finally {
			root.dispose();
		}
	});

	it("cancels text entry", () => {
		const finished: Array<string | null> = [];
		const root = mountForTest(() =>
			StandaloneInputView({
				onFinish(value) {
					finished.push(value);
				},
			}),
		);
		try {
			dispatchHostInput(root.root, "\x1b");
			expect(finished).toEqual([null]);
		} finally {
			root.dispose();
		}
	});
});
