import { describe, expect, test } from "bun:test";
import { createMessageNoticeModel, MessageNoticeView } from "../src/chrome/message-notice";
import { mountForTest } from "../src/testing";
import { cellGrid } from "./cell-grid";
import "../src/host/elements/box";
import "../src/host/elements/br";
import "../src/host/elements/stack";
import "../src/host/elements/text";

describe("MessageNoticeView", () => {
	test("preserves the historical inverse severity rows, icon prefix, and body separator", () => {
		const width = 48;
		const root = mountForTest(
			() => (
				<MessageNoticeView
					presentation={{
						icon: "!",
						header: "Warning",
						body: [<text italic>italic detail</text>, <text>plain follow-up</text>],
					}}
				/>
			),
			{ width },
		);
		try {
			const rows = root.rows();
			const plain = rows.map(Bun.stripANSI);
			const blank = " ".repeat(width);
			const header = " ! Warning";
			const italic = " italic detail";
			const followUp = " plain follow-up";
			expect(plain).toEqual([
				"",
				blank,
				`${header}${" ".repeat(width - Bun.stringWidth(header))}`,
				blank,
				`${italic}${" ".repeat(width - Bun.stringWidth(italic))}`,
				`${followUp}${" ".repeat(width - Bun.stringWidth(followUp))}`,
				blank,
			]);

			const cells = cellGrid(rows, width);
			expect(cells[0]![0]!.attrs.inverse).toBe(false);
			for (const row of cells.slice(1)) for (const cell of row) expect(cell.attrs.inverse).toBe(true);
			expect(cells[2]![2]!.attrs.bold).toBe(false);
			expect(cells[4]![2]!.attrs.italic).toBe(true);

			const narrow = root.rows(16).map(Bun.stripANSI);
			expect(narrow[0]).toBe("");
			for (const row of narrow.slice(1)) expect(Bun.stringWidth(row)).toBe(16);
			const narrowText = narrow.map(row => row.trim()).join(" ");
			expect(narrowText).toContain("italic detail");
			expect(narrowText).toContain("plain follow-up");
		} finally {
			root.dispose();
		}
	});

	test("uses the staged accent severity by default while retaining explicit severity overrides", () => {
		const presentation = { header: "Severity" };
		const defaultRoot = mountForTest(() => <MessageNoticeView presentation={presentation} />, { width: 32 });
		const accentRoot = mountForTest(() => <MessageNoticeView presentation={presentation} severity="accent" />, {
			width: 32,
		});
		const warningRoot = mountForTest(() => <MessageNoticeView presentation={presentation} severity="warning" />, {
			width: 32,
		});
		try {
			const defaultCells = cellGrid(defaultRoot.rows(), 32);
			expect(defaultCells).toEqual(cellGrid(accentRoot.rows(), 32));
			expect(defaultCells).not.toEqual(cellGrid(warningRoot.rows(), 32));
		} finally {
			defaultRoot.dispose();
			accentRoot.dispose();
			warningRoot.dispose();
		}
	});

	test("rebuilds controller-owned presentation on expansion and refresh, then hides as tool activity", () => {
		let detail = "preview";
		const model = createMessageNoticeModel({
			presentation: context => ({
				header: context.expanded ? "expanded" : "collapsed",
				body: <text>{context.expanded ? `full ${detail}` : detail}</text>,
			}),
		});
		const root = mountForTest(model.view, { width: 48 });
		try {
			expect(root.text().join("\n")).toContain("collapsed");
			expect(root.text().join("\n")).toContain("preview");
			expect(model.isExpanded()).toBe(false);

			model.setExpanded(true);
			expect(model.expanded).toBe(true);
			expect(root.text().join("\n")).toContain("expanded");
			expect(root.text().join("\n")).toContain("full preview");

			detail = "refreshed";
			model.refresh();
			expect(root.text().join("\n")).toContain("full refreshed");

			model.setToolActivityVisible(false);
			expect(model.visible).toBe(false);
			expect(root.text()).toEqual([]);
			model.setToolActivityVisible(true);
			expect(root.text().join("\n")).toContain("full refreshed");
		} finally {
			root.dispose();
		}
	});
});
