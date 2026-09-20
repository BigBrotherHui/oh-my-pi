import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { renderStatus, renderStatusLine } from "./helpers/status-line";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => resetSettingsForTest());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function fixture() {
	const model: Model = getBundledModel("deepseek", "deepseek-v4-flash");
	const state: { model: Model; messages: [] } = { model, messages: [] };
	const session = {
		state,
		get model() {
			return state.model;
		},
		messages: state.messages,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 1.25,
			}),
			getSessionName: () => undefined,
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
		getContextUsage: () => undefined,
		contextUsageRevision: 0,
	} as unknown as AgentSession;
	const component = new StatusLineComponent(session, statusLineHost);
	const showCost = () =>
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["cost"],
			sessionAccent: false,
		});
	showCost();
	return {
		component,
		state,
		showCost,
		render: () => stripVTControlCharacters(renderStatusLine(component, 80, "plain-full")),
		useFlatModel: () => {
			const { timeBased: _schedule, ...cost } = model.cost;
			state.model = { ...model, provider: "openrouter", cost };
			component.ingestSession();
		},
	};
}

describe("status line tariff boundary wakeup", () => {
	it("repaints and rearms while idle without polling or changing recorded dollars", () => {
		vi.useFakeTimers();
		let now = Date.parse("2026-09-10T03:59:59Z");
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const timers = vi.spyOn(globalThis, "setTimeout");
		const { component, render } = fixture();
		try {
			expect(render()).toContain("$1.25 ↑");
			const revision = component.revision();
			component.ingestSession();
			render();
			expect(timers).toHaveBeenCalledTimes(1);
			const timer = timers.mock.results[0]!.value as NodeJS.Timeout;
			expect(timer.hasRef()).toBe(false);

			now += 1000;
			vi.advanceTimersByTime(1000);
			expect(render()).toContain("$1.25 ↓");
			expect(component.revision()).toBeGreaterThan(revision);
			expect(timers).toHaveBeenCalledTimes(2);

			now += 2 * 60 * 60 * 1000;
			vi.advanceTimersByTime(2 * 60 * 60 * 1000);
			expect(render()).toContain("$1.25 ↑");
			expect(timers).toHaveBeenCalledTimes(3);
		} finally {
			component.dispose();
		}
	});

	it("removes the arrow immediately and cancels idle wakeups when the active model becomes unscheduled", () => {
		vi.useFakeTimers();
		let now = Date.parse("2026-09-10T03:59:59Z");
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const { component, render, useFlatModel } = fixture();
		try {
			expect(render()).toContain("$1.25 ↑");
			useFlatModel();
			const flat = render();
			expect(flat).toContain("$1.25");
			expect(flat).not.toMatch(/[↑↓]/);
			now += 1000;
			vi.advanceTimersByTime(1000);
			expect(render()).toContain("$1.25");
		} finally {
			component.dispose();
		}
	});

	it("cancels when cost is hidden, resumes when shown, and stays stopped after disposal", () => {
		vi.useFakeTimers();
		let now = Date.parse("2026-09-10T03:59:59Z");
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const { component, render, showCost } = fixture();
		try {
			expect(render()).toContain("$1.25 ↑");
			component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: [] });
			expect(render()).not.toContain("$1.25");
			now += 1000;
			vi.advanceTimersByTime(1000);
			expect(render()).not.toContain("$1.25");

			showCost();
			expect(render()).toContain("$1.25 ↓");
			now += 2 * 60 * 60 * 1000;
			vi.advanceTimersByTime(2 * 60 * 60 * 1000);
			expect(render()).toContain("$1.25 ↑");
			component.dispose();
			const revision = component.revision();
			component.ingestSession();
			now += 4 * 60 * 60 * 1000;
			vi.advanceTimersByTime(4 * 60 * 60 * 1000);
			expect(component.revision()).toBe(revision);
		} finally {
			component.dispose();
		}
	});
});
