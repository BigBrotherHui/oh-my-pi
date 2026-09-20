import { describe, expect, it } from "bun:test";
import { dispatchHostInput } from "../src/host/overlay";
import { focusNext } from "../src/host/focus";
import { SelectOverlay } from "../src/overlays/select-overlay";
import { mountForTest } from "../src/testing";

describe("SelectOverlay", () => {
	it("requires a second confirmation and lets Escape clear it before cancellation", () => {
		const selected: string[] = [];
		let cancelled = 0;
		const root = mountForTest(() =>
			SelectOverlay({
				title: "Confirm",
				options: [{ value: "reset", label: "Reset" }],
				onSelect: value => selected.push(value),
				onCancel: () => {
					cancelled += 1;
				},
				confirmation: () => "Press Enter again",
			}),
		);
		try {
			focusNext(root.root.node);
			dispatchHostInput(root.root, "\n");
			expect(root.text().join("\n")).toContain("Press Enter again");
			expect(selected).toEqual([]);

			dispatchHostInput(root.root, "\x1b");
			expect(root.text().join("\n")).not.toContain("Press Enter again");
			expect(cancelled).toBe(0);

			dispatchHostInput(root.root, "\n");
			dispatchHostInput(root.root, "\n");
			expect(selected).toEqual(["reset"]);
		} finally {
			root.dispose();
		}
	});
});
