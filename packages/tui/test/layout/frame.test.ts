import { beforeAll, describe, expect, it } from "bun:test";
import { boxElement } from "../../src/host/elements/box";
import { frameElement } from "../../src/host/elements/frame";
import { hrElement } from "../../src/host/elements/hr";
import { spanElement } from "../../src/host/elements/span";
import { stackElement } from "../../src/host/elements/stack";
import { textElement } from "../../src/host/elements/text";
import { initTheme } from "../../src/theme/theme";
import { cellGrid } from "../cell-grid";
import { elementRows, elementText, hostElement, hostText } from "./host-harness";

void boxElement;
void frameElement;
void hrElement;
void spanElement;
void stackElement;
void textElement;

beforeAll(async () => {
	await initTheme(false);
});

describe("retained frame", () => {
	it("clips a JSX title so the ellipsis lands directly before the corner", () => {
		const title = hostElement("span", {}, [hostText("a title much too long")]);
		const body = hostElement("text", { wrap: "none" }, [hostText("x")]);
		const frame = hostElement("frame", { title, paddingX: 0, paddingY: 0 }, [body]);
		const rows = elementText(frame, 10);
		expect(rows[0]).toHaveLength(10);
		expect(rows[0]).toEndWith("…╮");
	});

	it("extends a frame tint across complete rows including border cells", () => {
		const body = hostElement("text", { wrap: "none" }, [hostText("ok")]);
		const frame = hostElement(
			"frame",
			{ background: "toolSuccessBg", backgroundBorder: true, paddingX: 1, paddingY: 0 },
			[body],
		);
		const rows = elementRows(frame, 8);
		const grid = cellGrid(rows, 8);
		expect(grid.length).toBe(3);
		for (const row of grid) {
			expect(row).toHaveLength(8);
			for (const cell of row) expect(cell.bg).not.toBeNull();
		}
	});

	it("joins nested section rules to the enclosing frame without inheriting border label color", () => {
		const divider = hostElement("hr", { variant: "frame", label: "Output" });
		const stack = hostElement("stack", {}, [
			hostElement("text", {}, [hostText("command")]),
			divider,
			hostElement("text", {}, [hostText("result")]),
		]);
		const frame = hostElement("frame", { paddingX: 1, paddingY: 0, borderColor: "error" }, [stack]);
		const grid = cellGrid(elementRows(frame, 20), 20);
		expect(grid).toHaveLength(5);
		expect(grid[2]!.map(cell => cell.ch).join("")).toBe("├─── Output ───────┤");
		expect(grid[2]![0]!.fg).not.toBeNull();
		expect(grid[2]![5]!.fg).toBeNull();
		expect(grid[2]![5]!.attrs.bold).toBe(false);
	});

	it("renders frame dividers in child order", () => {
		const first = hostElement("text", { wrap: "none" }, [hostText("one")]);
		const divider = hostElement("hr", { variant: "frame", label: "next" });
		const second = hostElement("text", { wrap: "none" }, [hostText("two")]);
		const frame = hostElement("frame", { paddingX: 0, paddingY: 0 }, [first, divider, second]);
		const rows = elementText(frame, 12);
		expect(rows).toHaveLength(5);
		expect(rows[2]).toContain("next");
		expect(rows[2]?.startsWith("├")).toBe(true);
		expect(rows[2]?.endsWith("┤")).toBe(true);
	});
});
