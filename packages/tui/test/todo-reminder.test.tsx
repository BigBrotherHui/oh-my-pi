import { describe, expect, test } from "bun:test";
import { TodoReminderView } from "../src/chat/todo-reminder";
import { createSignal, type Setter } from "../src/reactive";
import type { TodoItem } from "../src/tools/todo";
import { mountForTest } from "../src/testing";
import { cellGrid } from "./cell-grid";
import "../src/host/elements/box";
import "../src/host/elements/stack";
import "../src/host/elements/text";

describe("TodoReminderView", () => {
	test("preserves the historical inverse notice frame, task indentation, and narrow wrapping", () => {
		const width = 64;
		const todos: readonly TodoItem[] = [
			{ content: "Audit the restored transcript layout", status: "pending" },
			{ content: "Finish the remaining migration", status: "in_progress" },
		];
		const root = mountForTest(
			() => <TodoReminderView todos={todos} attempt={2} maxAttempts={3} visible={() => true} />,
			{ width },
		);
		try {
			const rows = root.rows();
			const plain = rows.map(Bun.stripANSI);
			const warning = root.root.theme.symbol("icon.warning");
			const checkbox = root.root.theme.symbol("checkbox.unchecked");
			const header = `${warning} 2 incomplete todos - reminder 2/3`;
			const headerRow = ` ${header}`;
			const firstTask = `   ${checkbox} ${todos[0]!.content}`;
			const secondTask = `   ${checkbox} ${todos[1]!.content}`;

			expect(plain).toEqual([
				"",
				" ".repeat(width),
				`${headerRow}${" ".repeat(width - Bun.stringWidth(headerRow))}`,
				" ".repeat(width),
				`${firstTask}${" ".repeat(width - Bun.stringWidth(firstTask))}`,
				`${secondTask}${" ".repeat(width - Bun.stringWidth(secondTask))}`,
				" ".repeat(width),
			]);

			const cells = cellGrid(rows, width);
			expect(cells[0]![0]!.attrs.inverse).toBe(false);
			for (const cell of cells.slice(1).flat()) expect(cell.attrs.inverse).toBe(true);
			expect(cells[2]![1]!.attrs).toMatchObject({ bold: false, italic: false, inverse: true });
			expect(cells[4]![3]!.attrs).toMatchObject({ bold: false, italic: true, inverse: true });

			const narrow = root.rows(20).map(Bun.stripANSI);
			expect(narrow.length).toBeGreaterThan(7);
			expect(narrow[0]).toBe("");
			for (const row of narrow.slice(1)) expect(Bun.stringWidth(row)).toBe(20);
			const narrowText = narrow.map(row => row.trim()).join(" ");
			expect(narrowText).toContain(todos[0]!.content);
			expect(narrowText).toContain(todos[1]!.content);
		} finally {
			root.dispose();
		}
	});

	test("hides and restores the complete committed reminder with tool activity", () => {
		let setVisible: Setter<boolean> | undefined;
		const root = mountForTest(() => {
			const [visible, set] = createSignal(false);
			setVisible = set;
			return (
				<TodoReminderView
					todos={[{ content: "Finish migration", status: "pending" }]}
					attempt={3}
					maxAttempts={3}
					visible={visible}
				/>
			);
		});
		try {
			expect(root.text()).toEqual([]);
			if (setVisible === undefined) throw new Error("visibility signal was not initialized");
			setVisible(true);
			expect(root.text().join("\n")).toContain("1 incomplete todo - reminder 3/3");
			expect(root.text().join("\n")).toContain("Finish migration");
			setVisible(false);
			expect(root.text()).toEqual([]);
		} finally {
			root.dispose();
		}
	});
});
