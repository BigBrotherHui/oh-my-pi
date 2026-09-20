import { describe, expect, it } from "bun:test";
import { ToolBlock } from "../src/chat/tool-block";
import { mountForTest } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";
import { createToolCallModel } from "../src/tools/model";
import { thinkToolView, type ThinkRenderArgs } from "../src/tools/think";
import { cellGrid } from "./cell-grid";

describe("think tool view", () => {
	it("renders streamed thoughts with the historical inset, color, and normal style", () => {
		const text = "Cache the parsed config, then check invalidation.";
		const theme = loadThemeSync("dark");
		const model = createToolCallModel<ThinkRenderArgs>({ id: "think-1", toolName: "think", label: "Think" });
		model.applyArgsChunk({ thoughts: text });

		const root = mountForTest(() => thinkToolView.view(model), { width: 100, theme });
		try {
			const rows = root.rows();
			const grid = cellGrid(rows, 100);
			const row = grid.find(cells =>
				cells
					.map(cell => cell.ch)
					.join("")
					.includes(text),
			);
			const firstColumn = row?.findIndex(cell => cell.ch === "C");
			const first = firstColumn === undefined || firstColumn < 0 ? undefined : row?.[firstColumn];

			expect(firstColumn).toBe(1);
			expect(first?.attrs.italic).toBe(false);
			expect(first?.fg).toEqual(cellGrid([theme.fg("thinkingText", "C")], 1)[0]?.[0]?.fg);
		} finally {
			root.dispose();
		}
	});

	it("updates the retained markdown document as thought snapshots stream", () => {
		const model = createToolCallModel<ThinkRenderArgs>({ id: "think-2", toolName: "think", label: "Think" });
		const root = mountForTest(() => thinkToolView.view(model), { width: 100 });
		try {
			expect(root.rows()).toEqual([]);

			model.applyArgsChunk({ thoughts: "Inspect the cache key." });
			expect(root.text().join("\n")).toContain("Inspect the cache key.");

			model.applyArgsChunk({ thoughts: "Inspect the cache key, then invalidate it." });
			const text = root.text().join("\n");
			expect(text).toContain("Inspect the cache key, then invalidate it.");
			expect(text).not.toContain("Inspect the cache key.\n");
		} finally {
			root.dispose();
		}
	});

	it("stays inline at a compact row allocation without lifecycle card chrome", () => {
		const thought = "Check the lock.";
		const model = createToolCallModel<ThinkRenderArgs>({ id: "think-inline", toolName: "think", label: "Think" });
		model.applyArgsChunk({ thoughts: thought });
		model.setUi({ allocation: 1, expanded: false, showImages: false });

		const root = mountForTest(() => ToolBlock({ model }), { width: 80, theme: loadThemeSync("dark") });
		try {
			const liveRows = root.rows();
			expect(liveRows.join("\n")).toContain(thought);

			model.applyResult({ content: [{ type: "text", text: "This generic result must stay hidden." }] });
			const settledRows = root.rows();
			model.setUi({ expanded: true });
			const replayRows = root.rows();
			const grid = cellGrid(replayRows, 80);
			const row = grid.find(cells =>
				cells
					.map(cell => cell.ch)
					.join("")
					.includes(thought),
			);
			const firstColumn = row?.findIndex(cell => cell.ch === "C");
			const first = firstColumn === undefined || firstColumn < 0 ? undefined : row?.[firstColumn];

			expect(settledRows.join("\n")).toContain(thought);
			expect(replayRows.join("\n")).toContain(thought);
			expect(replayRows.join("\n")).not.toContain("Thinking");
			expect(replayRows.join("\n")).not.toContain("This generic result must stay hidden.");
			expect(first?.bg).toBeNull();
		} finally {
			root.dispose();
		}
	});

	it("does not allocate rows before thoughts arrive", () => {
		const model = createToolCallModel<ThinkRenderArgs>({ id: "think-3", toolName: "think", label: "Think" });
		const root = mountForTest(() => thinkToolView.view(model), { width: 100 });
		try {
			expect(root.rows()).toEqual([]);
		} finally {
			root.dispose();
		}
	});

	it("never renders a tool result below the private scratchpad", () => {
		const model = createToolCallModel<ThinkRenderArgs>({ id: "think-4", toolName: "think", label: "Think" });
		model.applyArgsChunk({ thoughts: "Check whether the lock is held." });
		model.applyResult({ content: [{ type: "text", text: "This result must not be rendered." }], isError: true });

		const root = mountForTest(() => thinkToolView.view(model), { width: 100 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("Check whether the lock is held.");
			expect(text).not.toContain("This result must not be rendered.");
		} finally {
			root.dispose();
		}
	});
});
