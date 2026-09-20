import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import { askToolView, askSummary, type AskRenderArgs, type AskToolDetails } from "../src/tools/ask";

describe("ask tool view", () => {
	it("renders question and answers via mountForTest", () => {
		const model = createToolCallModel<AskRenderArgs, AskToolDetails>({
			id: "ask-1",
			toolName: "ask",
			label: "ask",
		});
		model.applyArgsChunk({
			question: "Select database provider",
			options: [
				{ label: "PostgreSQL", description: "Recommended for relational" },
				{ label: "SQLite", description: "Embedded database" },
			],
		});
		model.setUi({ expanded: true });
		model.applyResult({
			content: [{ type: "text", text: "Answer received" }],
			details: {
				question: "Select database provider",
				options: ["PostgreSQL", "SQLite"],
				selectedOptions: ["PostgreSQL"],
			},
		});

		const root = mountForTest(() => askToolView.view(model), { width: 80 });
		const rows = root.text(80);
		expect(rows.some(r => r.includes("Select database provider"))).toBe(true);
		expect(rows.some(r => r.includes("PostgreSQL"))).toBe(true);
		root.dispose();
	});

	it("produces compact semantic summary", () => {
		const model = createToolCallModel<AskRenderArgs, AskToolDetails>({
			id: "ask-2",
			toolName: "ask",
			label: "ask",
		});
		model.applyArgsChunk({ question: "Confirm action?" });
		model.applyResult({
			content: [{ type: "text", text: "Yes" }],
			details: {
				question: "Confirm action?",
				selectedOptions: ["Yes"],
			},
		});

		const summary = askSummary(model);
		expect(summary.detail).toBe("1 answered");
		expect(summary.status).toBe("success");
	});
});
