import { describe, expect, it } from "bun:test";
import { HostMouseEvent, dispatchMouse } from "../src/host/input";
import { WizardStepView } from "../src/components/wizard-step";
import { mountForTest } from "../src/testing";

describe("WizardStepView", () => {
	it("retains the historical slot order, spacing, and caller-provided status symbols", () => {
		const root = mountForTest(
			() =>
				WizardStepView({
					heading: "Heading",
					intro: "Intro",
					preview: {
						children: "Preview one\nPreview two",
					},
					content: "Content",
					status: "✓ Saved",
					footer: "Press enter",
					maxHeight: 20,
				}),
			{ width: 40, height: 20 },
		);

		expect(root.text().map(row => row.trimEnd())).toEqual([
			"Heading",
			"",
			"Intro",
			"",
			"Preview one",
			"Preview two",
			"",
			"Content",
			"",
			"✓ Saved",
			"",
			"Press enter",
		]);
		root.dispose();
	});

	it("drops an optional preview before clipping content and reports the remaining content budget", () => {
		const budgets: number[] = [];
		const root = mountForTest(
			() =>
				WizardStepView({
					intro: "Intro",
					preview: {
						optional: true,
						children: "Preview one\nPreview two",
					},
					content: "First\nSecond\nThird",
					minContentLines: 1,
					maxHeight: 4,
					fitContent: rows => {
						if (rows !== undefined) budgets.push(rows);
					},
				}),
			{ width: 40, height: 4 },
		);

		expect(root.text().map(row => row.trimEnd())).toEqual(["Intro", "", "First", "Second"]);
		expect(budgets[budgets.length - 1]).toBe(2);
		root.dispose();
	});

	it("translates pointer rows into the visible content while routing wheel input from surrounding slots", () => {
		const rows: number[] = [];
		const root = mountForTest(
			() =>
				WizardStepView({
					heading: "Heading",
					content: "First\nSecond",
					maxHeight: 12,
					onMouse: (_event, contentRow) => {
						rows.push(contentRow);
					},
				}),
			{ width: 40, height: 12 },
		);

		root.text();
		dispatchMouse(root.root, new HostMouseEvent({ row: 2, col: 0, action: "down" }));
		dispatchMouse(root.root, new HostMouseEvent({ row: 0, col: 0, action: "wheel", wheel: 1 }));
		expect(rows).toEqual([0, -2]);
		root.dispose();
	});
});
