import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { type MemoryRetainDetails, type RetainRenderArgs, retainToolView } from "@oh-my-pi/pi-tui/tools/memory";
import { createToolCallModel } from "@oh-my-pi/pi-tui/tools/model";

describe("retainToolView", () => {
	it("renders streamed memory content and its settled result", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const model = createToolCallModel<RetainRenderArgs, MemoryRetainDetails>({
			id: "mem-1",
			toolName: "retain",
			label: "retain",
		});
		model.applyArgsChunk({ items: [{ content: "Saved coordinate A" }] });
		const root = mountForTest(() => retainToolView.view(model), { width: 100, theme: theme! });
		try {
			expect(root.text().join("\n")).toContain("Saved coordinate A");
			model.applyResult({ content: [{ type: "text", text: "1 memory stored." }], details: { count: 1 } });
			root.flush();
			expect(root.text().join("\n")).toContain("1 memory stored");
		} finally {
			root.dispose();
		}
	});
});
