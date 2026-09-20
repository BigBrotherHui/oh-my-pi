import { describe, expect, it } from "bun:test";
import { createWelcomeStore, pickWeightedTip, WelcomeView } from "@oh-my-pi/pi-tui/prompt/welcome";
import { renderToText } from "../src/testing";

describe("pickWeightedTip", () => {
	it("weights announced tips above ordinary tips", () => {
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;
		const counts = new Map<string, number>();
		for (let index = 0; index < 10_000; index++) {
			const tip = pickWeightedTip(tips, (index + 0.5) / 10_000);
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}
		expect(counts.get("shiny thing [NEW]")).toBeGreaterThan(counts.get("plain one") ?? 0);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});
});

describe("welcome layout", () => {
	const store = () =>
		createWelcomeStore({
			random: () => 0,
			version: "1.2.3",
			modelName: "Model Name",
			providerName: "Provider Name",
			lspServers: [{ name: "typescript", status: "ready", fileTypes: ["ts", "tsx"] }],
			recentSessions: [{ name: "A recent session", timeAgo: "just now" }],
		});

	it("keeps the compact two-column information panel at normal widths", () => {
		const rows = renderToText(() => WelcomeView({ store: store() }), 100);
		expect(rows.some(row => row.includes("Model Name"))).toBe(true);
		expect(rows.some(row => row.includes("typescript") && row.includes("│"))).toBe(true);
		expect(rows.some(row => row.includes("A recent session"))).toBe(true);
		expect(rows.every(row => Bun.stringWidth(row) <= 100)).toBe(true);
		expect(rows.length).toBeLessThanOrEqual(22);
	});

	it("collapses to the legacy compact left column when the terminal is narrow", () => {
		const rows = renderToText(() => WelcomeView({ store: store() }), 30);
		expect(rows.some(row => row.includes("Model Name"))).toBe(true);
		expect(rows.some(row => row.includes("typescript") || row.includes("A recent session"))).toBe(false);
		expect(rows.every(row => Bun.stringWidth(row) <= 30)).toBe(true);
		expect(rows.length).toBeLessThan(20);
	});
});
