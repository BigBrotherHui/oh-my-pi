import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { hubToolView } from "@oh-my-pi/pi-tui/tools/hub";
import type {
	CoordinationDetails,
	HubDetails,
	HubRenderArgs,
	LaunchToolDetails,
} from "@oh-my-pi/pi-tui/tools/hub-contract";
import { createToolCallModel } from "../src/tools/model";

describe("hubToolView messaging", () => {
	it("renders delivery outcomes, quoted outbound text, and a waited reply", () => {
		const model = createToolCallModel<HubRenderArgs, HubDetails>({
			id: "hub-send",
			toolName: "hub",
			label: "hub",
		});
		model.applyArgsChunk({ op: "send", to: "AuthLoader", message: "Can I update auth.ts?", await: true });
		const details: CoordinationDetails = {
			op: "send",
			from: "Main",
			to: "AuthLoader",
			receipts: [{ to: "AuthLoader", outcome: "revived" }],
			waited: {
				id: "reply-1",
				from: "AuthLoader",
				to: "Main",
				body: "Yes, it is yours.",
				ts: Date.now() - 1_000,
			},
		};
		model.applyResult({ content: [{ type: "text", text: "" }], details });
		const root = mountForTest(() => hubToolView.view(model), { width: 120 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("AuthLoader");
			expect(text).toContain("Can I update auth.ts?");
			expect(text).toContain("Yes, it is yours.");
		} finally {
			root.dispose();
		}
	});

	it("sorts peer roster rows and preserves unread and activity metadata", () => {
		const model = createToolCallModel<HubRenderArgs, HubDetails>({
			id: "hub-list",
			toolName: "hub",
			label: "hub",
		});
		model.applyArgsChunk({ op: "list" });
		const details: CoordinationDetails = {
			op: "list",
			peers: [
				{
					id: "ParkedWorker",
					displayName: "task",
					kind: "sub",
					status: "parked",
					parentId: "Main",
					unread: 2,
					lastActivity: Date.now() - 12_000,
				},
				{
					id: "AuthScout",
					displayName: "security reviewer",
					kind: "sub",
					status: "running",
					parentId: "Main",
					unread: 0,
					lastActivity: Date.now() - 2_000,
					activity: "auditing refresh tokens",
				},
			],
			counts: { running: 1, idle: 0, parked: 1, shown: 2, truncated: 0 },
		};
		model.applyResult({ content: [{ type: "text", text: "" }], details });
		const root = mountForTest(() => hubToolView.view(model), { width: 140 });
		try {
			const lines = root.text();
			const text = lines.join("\n");
			expect(text).toContain("1 running · 0 idle · 1 parked");
			expect(text).toContain("2 unread");
			expect(text).toContain("auditing refresh tokens");
			expect(lines.findIndex(line => line.includes("AuthScout"))).toBeLessThan(
				lines.findIndex(line => line.includes("ParkedWorker")),
			);
		} finally {
			root.dispose();
		}
	});

	describe("launch logs", () => {
		it("uses terminal rows, preserves their ANSI text, and caps the collapsed row budget", () => {
			const model = createToolCallModel<HubRenderArgs, HubDetails>({
				id: "hub-logs",
				toolName: "hub",
				label: "hub",
			});
			model.applyArgsChunk({ op: "logs", name: "web", follow: true });
			const details: LaunchToolDetails = {
				op: "logs",
				state: "ready",
				cursor: 41,
				terminalRows: Array.from({ length: 12 }, (_, index) => `\u001b[32mrow ${index + 1}\u001b[0m`),
			};
			model.applyResult({ content: [{ type: "text", text: "ignored fallback" }], details });
			const root = mountForTest(() => hubToolView.view(model), { width: 120, height: 30 });
			try {
				const text = root.text().join("\n");
				expect(text).toContain("Launch logs");
				expect(text).toContain("row 1");
				expect(text).toContain("row 10");
				expect(text).not.toContain("row 12");
				expect(text).toContain("2 more lines");
			} finally {
				root.dispose();
			}
		});
	});
});
