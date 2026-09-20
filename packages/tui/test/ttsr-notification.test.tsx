import { describe, expect, test } from "bun:test";
import {
	createTtsrNotificationModel,
	TtsrNotificationView,
	type NotificationRule,
} from "../src/chat/ttsr-notification";
import { mountForTest } from "../src/testing";
import { cellGrid } from "./cell-grid";
import "../src/host/elements/box";
import "../src/host/elements/br";
import "../src/host/elements/icon";
import "../src/host/elements/span";
import "../src/host/elements/stack";
import "../src/host/elements/text";

function renderNotification(rules: readonly NotificationRule[], expanded = false, visible = true, width = 96) {
	return mountForTest(() => <TtsrNotificationView rules={rules} expanded={expanded} visible={visible} />, { width });
}

describe("TtsrNotificationView", () => {
	test("keeps the historical single-rule header, inverse warning shell, and two-line preview", () => {
		const root = renderNotification([
			{ name: "no-tiny-functions", description: "first line\nsecond line\nthird line" },
		]);
		try {
			const rows = root.text();
			const text = rows.join("\n");
			expect(text).toContain(
				`${root.root.theme.symbol("icon.warning")} Injecting rule: no-tiny-functions  ${root.root.theme.symbol("icon.rewind")}`,
			);
			expect(rows.some(row => row.includes("first line"))).toBe(true);
			expect(rows.some(row => row.includes("second line…"))).toBe(true);
			expect(text).not.toContain("third line");
			expect(text).toContain(" (ctrl+o to expand)");
			const headerRow = rows.findIndex(row => row.includes("Injecting rule:"));
			const firstDetailRow = rows.findIndex(row => row.includes("first line"));
			const cells = cellGrid(root.rows(), 96);
			const nameColumn = rows[headerRow]!.indexOf("no-tiny-functions");
			const detailColumn = rows[firstDetailRow]!.indexOf("first line");
			expect(cells[headerRow]![nameColumn]!.attrs.bold).toBe(true);
			expect(cells[headerRow]![nameColumn]!.attrs.inverse).toBe(true);
			expect(cells[firstDetailRow]![detailColumn]!.attrs.italic).toBe(true);
		} finally {
			root.dispose();
		}
	});

	test("uses content as the fallback detail and expands every single-rule line", () => {
		const collapsed = renderNotification([{ name: "fallback", content: "  alpha\nbeta\ngamma  " }]);
		const expanded = renderNotification([{ name: "fallback", content: "  alpha\nbeta\ngamma  " }], true);
		try {
			const collapsedRows = collapsed.text();
			const expandedRows = expanded.text();
			expect(collapsedRows.some(row => row.includes("alpha"))).toBe(true);
			expect(collapsedRows.some(row => row.includes("beta…"))).toBe(true);
			expect(expandedRows.some(row => row.includes("alpha"))).toBe(true);
			expect(expandedRows.some(row => row.includes("beta"))).toBe(true);
			expect(expandedRows.some(row => row.includes("gamma"))).toBe(true);
			expect(expandedRows.join("\n")).not.toContain("ctrl+o to expand");
		} finally {
			collapsed.dispose();
			expanded.dispose();
		}
	});

	test("caps multi-rule summaries while preserving their names and detail rules", () => {
		const rules = [
			{ name: "one", description: "first\nrest" },
			{ name: "two", content: "  fallback content  " },
			{ name: "three" },
			{ name: "four", description: "fourth" },
			{ name: "five", description: "fifth" },
		];
		const collapsed = renderNotification(rules);
		const expanded = renderNotification(rules, true);
		try {
			const collapsedText = collapsed.text().join("\n");
			expect(collapsedText).toContain(`Injecting 5 rules:  ${collapsed.root.theme.symbol("icon.rewind")}`);
			expect(collapsedText).toContain("one: first…");
			expect(collapsedText).toContain("two: fallback content");
			expect(collapsedText).not.toContain("rest");
			expect(collapsedText).not.toContain("five: fifth");
			expect(collapsedText).toContain("… +1 more (ctrl+o to expand)");

			const expandedRows = expanded.text();
			const expandedText = expandedRows.join("\n");
			expect(expandedRows.some(row => row.includes("one: first"))).toBe(true);
			expect(expandedRows.some(row => row.includes("rest"))).toBe(true);
			expect(expandedText).toContain("five: fifth");
			expect(expandedText).not.toContain("ctrl+o to expand");
		} finally {
			collapsed.dispose();
			expanded.dispose();
		}
	});

	test("updates the mounted live block, deduplicates merged names, and obeys visibility", () => {
		const model = createTtsrNotificationModel([{ name: "first", description: "first detail" }]);
		const root = mountForTest(model.view, { width: 96 });
		try {
			model.addRules([
				{ name: "first", description: "replacement that must not appear" },
				{ name: "second", description: "second detail" },
			]);
			let text = root.text().join("\n");
			expect(text).toContain("Injecting 2 rules");
			expect(text).toContain("first: first detail");
			expect(text).toContain("second: second detail");
			expect(text).not.toContain("replacement that must not appear");

			model.setExpanded(true);
			text = root.text().join("\n");
			expect(text).toContain("second: second detail");
			model.setVisible(false);
			expect(root.text()).toEqual([]);
		} finally {
			root.dispose();
		}
	});
});
