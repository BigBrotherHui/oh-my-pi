import * as os from "node:os";
import { describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	buildHeatmapLayout,
	buildProviderCards,
	formatActivityErrorDetail,
	UsageDashboardView,
	type DailyActivityPoint,
} from "../src/overlays/usage-dashboard";
import { dispatchKey, HostKeyEvent } from "../src/host/input";
import { mountForTest, type TestRoot } from "../src/testing";

function day(day: string, cost: number, requests = 1): DailyActivityPoint {
	return { day, cost, requests };
}

async function waitForText(root: TestRoot, text: string): Promise<void> {
	for (let attempt = 0; attempt < 4; attempt++) {
		root.flush();
		if (root.text().some(line => line.includes(text))) return;
		await Promise.resolve();
	}
	throw new Error(`Timed out waiting for ${text}`);
}

function report(provider: string, email: string, limits: UsageReport["limits"]): UsageReport {
	return { provider, fetchedAt: Date.now(), limits, metadata: { email } };
}

function limit(
	provider: string,
	accountId: string,
	windowId: string,
	label: string,
	usedFraction: number,
	status: "ok" | "warning" | "exhausted",
	resetsAt?: number,
): UsageReport["limits"][number] {
	return {
		id: `${provider}:${accountId}:${windowId}`,
		label,
		scope: { provider, accountId, windowId },
		window: { id: windowId, label: windowId, resetsAt },
		amount: { usedFraction, unit: "percent" },
		status,
	};
}

describe("buildHeatmapLayout", () => {
	const monday = new Date(2026, 7, 31, 12);

	it("aligns days Monday-first and marks future days null", () => {
		const layout = buildHeatmapLayout([day("2026-08-31", 5)], 2, monday);
		expect(layout.cells[0]![1]).toBe(4);
		for (let row = 1; row < 7; row++) expect(layout.cells[row]![1]).toBeNull();
		for (let row = 0; row < 7; row++) expect(layout.cells[row]![0]).toBe(0);
	});

	it("scales intensity by magnitude against the busiest day, not by rank", () => {
		const layout = buildHeatmapLayout(
			[day("2026-08-24", 100), day("2026-08-25", 30), day("2026-08-26", 6), day("2026-08-27", 0)],
			2,
			monday,
		);
		expect(layout.cells[0]![0]).toBe(4);
		expect(layout.cells[1]![0]).toBe(3);
		expect(layout.cells[2]![0]).toBe(1);
		expect(layout.cells[3]![0]).toBe(0);
	});

	it("falls back to request counts when nothing in range is priced", () => {
		const layout = buildHeatmapLayout([day("2026-08-24", 0, 50), day("2026-08-25", 0, 3)], 2, monday);
		expect(layout.cells[0]![0]).toBe(4);
		expect(layout.cells[1]![0]).toBe(1);
		expect(layout.totalRequests).toBe(53);
	});

	it("labels a column when its week starts a new month", () => {
		const layout = buildHeatmapLayout([], 6, monday);
		expect(layout.monthLabels[0]).toBe("Jul");
		expect(layout.monthLabels.filter(Boolean)).toEqual(["Jul", "Aug"]);
	});
});

describe("buildProviderCards", () => {
	const now = Date.now();

	it("averages a window across accounts instead of showing the worst account", () => {
		const cards = buildProviderCards(
			[
				report("anthropic", "a@x.test", [
					limit("anthropic", "a", "7d", "Claude 7 Day", 1, "exhausted", now + 1_000),
				]),
				report("anthropic", "b@x.test", [limit("anthropic", "b", "7d", "Claude 7 Day", 0, "ok", now + 99_000)]),
			],
			now,
		);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.windows).toHaveLength(1);
		expect(cards[0]!.windows[0]!.fraction).toBeCloseTo(0.5);
		expect(cards[0]!.windows[0]!.status).toBe("warning");
		expect(cards[0]!.windows[0]!.resetMs).toBe(1_000);
	});

	it("sorts pressured providers first and collapses untouched providers", () => {
		const cards = buildProviderCards(
			[
				report("cursor", "c@x.test", [limit("cursor", "c", "monthly", "Cursor Models", 0, "ok")]),
				report("openai-codex", "o@x.test", [limit("openai-codex", "o", "7d", "7 days", 0.4, "ok")]),
				report("ollama-cloud", "l@x.test", []),
			],
			now,
		);
		expect(cards[0]!.provider).toBe("openai-codex");
		expect(cards[0]!.idle).toBe(false);
		expect(
			cards
				.filter(card => card.idle)
				.map(card => card.provider)
				.sort(),
		).toEqual(["cursor", "ollama-cloud"]);
		expect(cards.find(card => card.provider === "ollama-cloud")?.unlimited).toBe(true);
	});

	it("shows a prepaid balance rather than an unavailable quota", () => {
		const cards = buildProviderCards(
			[
				report("charm-hyper", "a@x.test", [
					{
						id: "charm-hyper:credits",
						label: "Credit balance",
						scope: { provider: "charm-hyper", windowId: "balance", shared: true },
						amount: { remaining: 100, unit: "credits" },
					},
				]),
			],
			now,
		);
		expect(cards[0]!.windows[0]!.usedText).toBe("100 credits left");
		expect(cards[0]!.windows[0]!.fraction).toBeUndefined();
		expect(cards[0]!.idle).toBe(false);
	});

	it("collapses an account-wide balance reported once per key regardless of probe order", () => {
		const balance = (remaining: number): UsageReport["limits"][number] => ({
			id: "charm-hyper:credits",
			label: "Credit balance",
			scope: { provider: "charm-hyper", windowId: "balance", shared: true },
			amount: { remaining, unit: "credits" },
		});
		const forward = buildProviderCards(
			[report("charm-hyper", "a@x.test", [balance(100)]), report("charm-hyper", "b@x.test", [balance(95)])],
			now,
		);
		const reversed = buildProviderCards(
			[report("charm-hyper", "b@x.test", [balance(95)]), report("charm-hyper", "a@x.test", [balance(100)])],
			now,
		);
		expect(forward[0]!.windows[0]!.usedText).toBe("100 credits left");
		expect(reversed[0]!.windows[0]!.usedText).toBe("100 credits left");
	});

	it("keeps independent shared quota windows distinct", () => {
		const sharedLimit = (counter: "anthropic" | "openai", windowId: "5h" | "7d"): UsageReport["limits"][number] => {
			const value = limit("google-antigravity", "account", windowId, "Claude & GPT (shared)", 0.25, "ok");
			return {
				...value,
				id: `google-antigravity:${counter}:default:3p-${windowId}`,
				scope: { ...value.scope, shared: true, sharedGroup: `3p-${windowId}` },
			};
		};
		const reports = [
			report("google-antigravity", "user@example.test", [
				limit("google-antigravity", "account", "5h", "Gemini", 0.25, "ok"),
				limit("google-antigravity", "account", "7d", "Gemini", 0.25, "ok"),
				sharedLimit("anthropic", "5h"),
				sharedLimit("openai", "5h"),
				sharedLimit("anthropic", "7d"),
				sharedLimit("openai", "7d"),
			]),
		];
		expect(
			buildProviderCards(reports, now)[0]!
				.windows.map(window => `${window.label} — ${window.windowTag}`)
				.sort(),
		).toEqual(["Claude & GPT (shared) — 5h", "Claude & GPT (shared) — 7d", "Gemini — 5h", "Gemini — 7d"]);
	});
});

describe("UsageDashboardView", () => {
	it("reflows provider cards into one column at narrow widths", () => {
		const reports = [
			report("anthropic", "a@x.test", [limit("anthropic", "a", "5h", "Five hours", 0.5, "ok")]),
			report("openai-codex", "o@x.test", [limit("openai-codex", "o", "5h", "Five hours", 0.5, "ok")]),
		];
		const root = mountForTest(
			() =>
				UsageDashboardView({
					options: { reports, renderDetail: () => "detail", loadActivity: async push => push([]), onClose() {} },
				}),
			{ width: 80 },
		);
		try {
			const wide = root.text(80);
			expect(wide.some(line => line.includes("Anthropic") && line.includes("Openai Codex"))).toBe(true);
			const narrow = root.text(35);
			expect(narrow.some(line => line.includes("Anthropic") && line.includes("Openai Codex"))).toBe(false);
			expect(narrow.some(line => line.includes("Anthropic"))).toBe(true);
			expect(narrow.some(line => line.includes("Openai Codex"))).toBe(true);
		} finally {
			root.dispose();
		}
	});

	it("retains distinct window tags when the card contracts", () => {
		const reports = [
			report("google-antigravity", "a@x.test", [
				limit("google-antigravity", "a", "5h", "Gemini", 0.5, "ok"),
				limit("google-antigravity", "a", "7d", "Gemini", 0.25, "ok"),
			]),
		];
		const root = mountForTest(
			() =>
				UsageDashboardView({
					options: { reports, renderDetail: () => "detail", loadActivity: async push => push([]), onClose() {} },
				}),
			{ width: 80 },
		);
		try {
			const narrow = root.text(35).join("\n");
			expect(narrow).toContain("5h");
			expect(narrow).toContain("7d");
			expect(narrow).toContain("Gemini");
		} finally {
			root.dispose();
		}
	});

	it("streams history, restores the detailed report with Tab, and aborts the load on cleanup", () => {
		const pending = Promise.withResolvers<void>();
		let push: ((points: DailyActivityPoint[]) => void) | undefined;
		let signal: AbortSignal | undefined;
		let closeCount = 0;
		const root = mountForTest(
			() =>
				UsageDashboardView({
					options: {
						reports: [],
						renderDetail: () => "full report",
						loadActivity(next, receivedSignal) {
							push = next;
							signal = receivedSignal;
							return pending.promise;
						},
						onClose() {
							closeCount++;
						},
					},
				}),
			{ width: 80 },
		);
		try {
			root.text();
			expect(push).toBeDefined();
			push?.([day("2026-08-31", 2, 3)]);
			expect(root.text().join("\n")).toContain("Activity");
			dispatchKey(root.root, new HostKeyEvent("\t"));
			expect(root.text().join("\n")).toContain("full report");
			dispatchKey(root.root, new HostKeyEvent("\x1b"));
			expect(root.text().join("\n")).toContain("Activity");
			dispatchKey(root.root, new HostKeyEvent("\x1b"));
			expect(closeCount).toBe(1);
		} finally {
			root.dispose();
		}
		expect(signal?.aborted).toBe(true);
	});

	it("renders the actual activity loader failure in the dashboard", async () => {
		const root = mountForTest(() =>
			UsageDashboardView({
				options: {
					reports: [],
					renderDetail: () => "",
					loadActivity: () => Promise.reject(new Error("worker spawn failed")),
					onClose() {},
				},
			}),
		);
		try {
			await waitForText(root, "Usage history unavailable (worker spawn failed).");
			expect(root.text().join("\n")).toContain("Usage history unavailable (worker spawn failed).");
		} finally {
			root.dispose();
		}
	});
});

describe("formatActivityErrorDetail", () => {
	it("strips ANSI control sequences and collapses multiline error text", () => {
		expect(formatActivityErrorDetail("worker spawn failed\ntrace\x1b[2J\r\n\tsecond line")).toBe(
			"worker spawn failed trace second line",
		);
	});

	it("shortens home directory paths and removes trailing dots", () => {
		const home = "/Users/testuser";
		expect(formatActivityErrorDetail(`Error: failed to open ${home}/.omp/stats.db...`, home)).toBe(
			"Error: failed to open ~/.omp/stats.db",
		);
	});

	it("renders sanitized loader details without leaking a home directory", async () => {
		const raw = `subprocess crashed at ${os.homedir()}/.omp/stats.db:\n\tfailed to open\x1b[2J\r\nline 2\x1b[31m...`;
		const root = mountForTest(() =>
			UsageDashboardView({
				options: {
					reports: [],
					renderDetail: () => "",
					loadActivity: () => Promise.reject(new Error(raw)),
					onClose() {},
				},
			}),
		);
		try {
			await waitForText(root, "Usage history unavailable");
			const content = root.text(140).find(line => line.includes("Usage history unavailable"));
			expect(content).toBeDefined();
			expect(content).not.toContain("\x1b[2J");
			expect(content).not.toContain("\t");
			expect(content).not.toContain(os.homedir());
			expect(content).toContain("~/.omp/stats.db");
		} finally {
			root.dispose();
		}
	});
});
