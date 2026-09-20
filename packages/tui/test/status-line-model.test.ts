import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { SegmentContext } from "../src/status-line/segments";
import { renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";
import { visibleWidth } from "../src/utils";
import type { JSX } from "../src/reactive";
import { cellGrid, expectSameCells } from "./cell-grid";
import { renderVNode } from "./helpers/render-vnode";

beforeAll(async () => {
	await initTheme();
});

function createModelContext(advisorActive: boolean): SegmentContext {
	return {
		session: {
			state: { model: { id: "test-model", name: "Test Model" } },
			isFastModeActive: () => false,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isAdvisorActive: () => advisorActive,
			getAdvisorStatusOverview: () => ({
				configured: advisorActive,
				advisors: advisorActive ? [{ name: "default", status: "running", yielded: false }] : [],
			}),
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		vim: null,
		collab: null,
		stream: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

function expectGlyphStyle(view: JSX.Element, glyph: string, expected: string): void {
	const content = renderVNode(view);
	const plain = Bun.stripANSI(content);
	const index = plain.indexOf(glyph);
	expect(index).toBeGreaterThanOrEqual(0);
	const column = visibleWidth(plain.slice(0, index));
	const actualCell = cellGrid([content], Math.max(120, column + 2))[0]![column]!;
	const expectedCell = cellGrid([expected], 120)[0]![0]!;
	expect(actualCell.fg).toEqual(expectedCell.fg);
	expect(actualCell.attrs).toEqual(expectedCell.attrs);
}

describe("status line stream segment", () => {
	it("renders the live viewer badge only while attached", () => {
		const ctx = createModelContext(false);
		ctx.stream = { viewers: 7 };
		const rendered = renderSegment("stream", ctx);
		expect(rendered.visible).toBe(true);
		expectSameCells([theme.fg("thinkingHigh", "● LIVE 7")], [renderVNode(rendered.content)], 120);
		ctx.stream = null;
		const hidden = renderSegment("stream", ctx);
		expect(hidden.visible).toBe(false);
		expect(renderVNode(hidden.content)).toBe("");
	});
});

describe("status line model segment advisor badge", () => {
	it("appends a success-colored advisor symbol when all advisors run", () => {
		const rendered = renderSegment("model", createModelContext(true));
		expect(renderVNode(rendered.content)).toContain("Test Model");
		expectGlyphStyle(rendered.content, theme.icon.advisor, theme.fg("success", theme.icon.advisor));
	});

	it("colors the badge by the worst roster status", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "running", yielded: false },
				{ name: "b", status: "quota_exhausted", yielded: false },
			],
		});
		expectGlyphStyle(
			renderSegment("model", ctx).content,
			theme.icon.advisor,
			theme.fg("warning", theme.icon.advisor),
		);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "error", yielded: false },
				{ name: "b", status: "quota_exhausted", yielded: false },
			],
		});
		expectGlyphStyle(renderSegment("model", ctx).content, theme.icon.advisor, theme.fg("error", theme.icon.advisor));
	});
	it("closes the eye once every advisor has yielded its review", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [{ name: "default", status: "running", yielded: true }],
		});
		const view = renderSegment("model", ctx).content;
		const rendered = renderVNode(view);
		expectGlyphStyle(view, theme.icon.advisorClosed, theme.fg("success", theme.icon.advisorClosed));
		// ASCII mode resolves both icons to `(adv)`, so absence is only provable
		// when the two tokens differ.
		if (theme.icon.advisorClosed !== theme.icon.advisor) {
			expect(rendered).not.toContain(theme.icon.advisor);
		}
	});

	it("keeps the eye open while any advisor may still comment", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "running", yielded: true },
				{ name: "b", status: "running", yielded: false },
			],
		});
		const view = renderSegment("model", ctx).content;
		const rendered = renderVNode(view);
		expectGlyphStyle(view, theme.icon.advisor, theme.fg("success", theme.icon.advisor));
		if (theme.icon.advisorClosed !== theme.icon.advisor) {
			expect(rendered).not.toContain(theme.icon.advisorClosed);
		}
	});

	it("omits the badge when the advisor is inactive", () => {
		const rendered = renderVNode(renderSegment("model", createModelContext(false)).content);
		expect(rendered).toContain("Test Model");
		expect(rendered).not.toContain(theme.icon.advisor);
	});
});

describe("status line model segment compact thinking level", () => {
	function createThinkingContext(compactThinkingLevel: boolean): SegmentContext {
		return {
			...createModelContext(false),
			compactThinkingLevel,
			session: {
				state: {
					model: { id: "test-model", name: "Test Model", thinking: true },
					thinkingLevel: ThinkingLevel.High,
				},
				isFastModeActive: () => false,
				isAutoThinking: false,
				autoResolvedThinkingLevel: () => undefined,
				isAdvisorActive: () => false,
				getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
			} as unknown as SegmentContext["session"],
		};
	}

	it("trails the level as a ` · <level>` suffix when compact mode is off", () => {
		const display = theme.thinking.high;
		const modelPrefix = theme.icon.model ? `${theme.icon.model} ` : "";
		const rendered = renderSegment("model", createThinkingContext(false));
		expect(Bun.stripANSI(renderVNode(rendered.content))).toBe(`${modelPrefix}Test Model${theme.sep.dot}${display}`);
	});

	it("swaps the model icon for the level glyph and drops the suffix when compact", () => {
		const display = theme.thinking.high;
		const glyph = display.includes(" ") ? display.slice(0, display.indexOf(" ")) : display;
		const rendered = renderSegment("model", createThinkingContext(true));
		expect(Bun.stripANSI(renderVNode(rendered.content))).toBe(`${glyph} Test Model`);
		expect(Bun.stripANSI(renderVNode(rendered.content))).not.toContain(theme.sep.dot);
	});
});
