import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getTimeBasedPricingPeriod } from "@oh-my-pi/pi-catalog/models";
import { TERMINAL } from "../terminal-capabilities";
import {
	formatDuration,
	formatNumber,
	getProjectDir,
	normalizePathForComparison,
	relativePathWithinNormalizedRoot,
	relativePathWithinRoot,
} from "@oh-my-pi/pi-utils";
import { type SymbolKey, type Theme, type ThemeColor, theme } from "../theme";
import { shortenPath, TRUNCATE_LENGTHS } from "../render/render-utils";
import { fileHyperlinkStyle } from "../render/hyperlink";
import { skipCells, takeCells } from "../core/out";
import { cellWidth } from "../core/richtext";
import { linkId, parseColor, Style } from "../core/style";
import type { JSX } from "../reactive";
import { getSessionAccentHex } from "../theme/session-color";
import { summarizeLoopCondition } from "./loop";
import { formatMetric } from "../components/metric";
import { formatBillingSummary } from "./metrics";
import { sanitizeText as sanitizeStatusText } from "@oh-my-pi/pi-utils";
import { formatContextUsage, getContextUsageLevel, getContextUsageThemeColor } from "../chrome/context-thresholds";
import { STATUS_LINE_SEGMENT_IDS } from "./schema";
import type { RenderedSegment, SegmentContext, StatusLineSegment, StatusLineSegmentId } from "./types";

export type { SegmentContext } from "./types";

const SPINNER_ADVANCE_MS = 80;

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

const STARTUP_PLACEHOLDER = "…";

function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}

function statusValue(ctx: SegmentContext, value: string): string {
	return ctx.startupPlaceholder ? STARTUP_PLACEHOLDER : value;
}

/** Left-truncate a path/label to `maxLen`, prefixing an ellipsis when clipped. */
function clampPathLength(pwd: string, maxLen: number): string {
	const width = cellWidth(pwd);
	if (width <= maxLen) return pwd;
	if (maxLen <= 0) return "";
	if (maxLen === 1) return "…";
	return `…${skipCells(pwd, width - maxLen + 1)}`;
}

/**
 * Leading glyph of a thinking-level display string (e.g. "◉ xhigh" → "◉").
 * Compact mode promotes this glyph to the model-segment icon so the level
 * stays visible without the verbose " · <level>" tail.
 */
function leadingGlyph(display: string): string {
	const space = display.indexOf(" ");
	return space === -1 ? display : display.slice(0, space);
}

function stripDisplayRoot(pwd: string): string {
	for (const root of [join(homedir(), "Projects"), "/work"]) {
		const relative = relativePathWithinRoot(root, pwd);
		if (relative) return relative;
	}
	return pwd;
}

const NORMALIZED_SCRATCH_ROOTS: readonly string[] = (() => {
	const roots = new Set<string>([tmpdir(), join(homedir(), "tmp")]);
	if (process.platform === "win32") {
		const { TEMP, TMP, SystemRoot } = process.env;
		if (TEMP) roots.add(TEMP);
		if (TMP) roots.add(TMP);
		if (SystemRoot) roots.add(join(SystemRoot, "Temp"));
	} else {
		roots.add("/tmp");
		roots.add("/var/tmp");
		if (process.platform === "darwin") {
			roots.add("/private/tmp");
			roots.add("/private/var/tmp");
		}
	}
	return [...new Set(Array.from(roots, normalizePathForComparison))];
})();

interface ProjectDirClassification {
	scratch: boolean;
	relative: string | null;
}

const PROJECT_DIR_CLASSIFICATIONS = new Map<string, ProjectDirClassification>();

function classifyProjectDir(projectDir: string): ProjectDirClassification {
	const cached = PROJECT_DIR_CLASSIFICATIONS.get(projectDir);
	if (cached) return cached;

	const normalizedProjectDir = normalizePathForComparison(projectDir);
	let classification: ProjectDirClassification = { scratch: false, relative: null };
	for (const normalizedRoot of NORMALIZED_SCRATCH_ROOTS) {
		const relative = relativePathWithinNormalizedRoot(normalizedRoot, normalizedProjectDir);
		if (relative !== null) {
			classification = { scratch: true, relative: relative || null };
			break;
		}
	}
	PROJECT_DIR_CLASSIFICATIONS.set(projectDir, classification);
	return classification;
}

// ═══════════════════════════════════════════════════════════════════════════
// Segment Implementations
// ═══════════════════════════════════════════════════════════════════════════

/** Current braille-spinner glyph on the shared clock, at the Loader's 80ms cadence. */
function brandSpinnerFrame(nowMs?: number): string {
	const ms = nowMs ?? 0;
	const frames = theme.getSpinnerFrames("activity");
	return frames[Math.floor(ms / SPINNER_ADVANCE_MS) % frames.length] ?? "";
}

/** Turn timer in omp's brand format: whole seconds → minutes → hours (capped at 99h). */
function brandTimer(elapsedMs: number): string {
	const seconds = Math.floor(elapsedMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	return `${Math.min(99, Math.floor(seconds / 3600))}h`;
}

function formatGoalBudget(current: number, budget?: number): string {
	const used = formatNumber(current);
	if (budget === undefined) return used;
	return `${used}/${formatNumber(budget)}`;
}

function formatLoopLimit(limit: NonNullable<SegmentContext["loopMode"]>["limit"], nowMs?: number): string | undefined {
	if (!limit) return undefined;
	if (limit.kind === "iterations") return `${limit.remaining}/${limit.initial}`;

	const currentMs = nowMs ?? 0;
	const totalSeconds = Math.max(0, Math.ceil((limit.deadlineMs - currentMs) / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""} left`;
	if (minutes > 0) return `${minutes}m${seconds > 0 ? `${seconds}s` : ""} left`;
	return `${seconds}s left`;
}

/**
 * Vim modal state, in the shape Vim itself uses: the mode, the half-typed command echoed beside it
 * (`showcmd`), and the Visual selection size. Hidden entirely when `tui.vimMode` is off, so it
 * costs nothing for everyone else. `tui.vimModeDisplay` picks the mode's presentation.
 */
const VIM_MODE_LABELS: Record<NonNullable<SegmentContext["vim"]>["mode"], string> = {
	insert: "INSERT",
	normal: "NORMAL",
	visual: "VISUAL",
	"visual-line": "V-LINE",
};

/**
 * The `icon` display resolves through the theme's symbol map, so each mode picks up the active
 * symbol preset (nerd / unicode / ascii) and honours per-theme `symbols` overrides — same mechanism
 * as every other status-line icon. Glyph choices live in `SYMBOL_PRESETS`.
 */
const VIM_MODE_ICON_KEYS: Record<NonNullable<SegmentContext["vim"]>["mode"], SymbolKey> = {
	insert: "icon.vimInsert",
	normal: "icon.vimNormal",
	visual: "icon.vimVisual",
	"visual-line": "icon.vimVisualLine",
};

const VIM_MODE_COLORS: Record<NonNullable<SegmentContext["vim"]>["mode"], ThemeColor> = {
	insert: "success",
	normal: "accent",
	visual: "warning",
	"visual-line": "warning",
};

function pickUsageColor(percent: number): "muted" | "warning" | "error" {
	if (percent >= 80) return "error";
	if (percent >= 50) return "warning";
	return "muted";
}

/** Format quota reset duration using the provider window's native unit. */
function formatUsageReset(value: number, unit: "m" | "h"): string {
	if (unit === "m") {
		// Short-window reset timers retain minute precision.
		if (value < 60) return `${value}m`;
		const hours = Math.floor(value / 60);
		const mins = value % 60;
		return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	}
	// total hours (7d window: max 168)
	if (value < 24) return `${value}h`;
	const days = Math.floor(value / 24);
	const hours = value % 24;
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Segment Registry
// ═══════════════════════════════════════════════════════════════════════════

export function renderSegment(id: StatusLineSegmentId, ctx: SegmentContext): RenderedSegment {
	const node = statusSegmentNode(id, ctx);
	return node === null
		? { content: <span />, visible: false }
		: { content: <text wrap="none">{node}</text>, visible: true };
}

function runAccentStyle(ctx: SegmentContext, fallback: ThemeColor): Style {
	if (ctx.sessionAccent !== false) {
		const name = ctx.session?.sessionManager?.getSessionName() || ctx.previewTitle;
		if (name) {
			try {
				return Style.of({ fg: parseColor(getSessionAccentHex(name, theme.sessionAccentInputs)) });
			} catch {
				// Fall through to the active theme color.
			}
		}
	}
	return theme.style(fallback);
}

function iconNode(style: Style, icon: string, text: string): JSX.Element {
	return (
		<span style={style}>
			{icon ? `${icon} ` : ""}
			{text}
		</span>
	);
}

function singleStatNode(
	ctx: SegmentContext,
	field: "input" | "output" | "cacheRead" | "cacheWrite",
	iconKey: "input" | "output" | "cache",
	color: ThemeColor,
): JSX.Element | null {
	const value = ctx.usageStats[field];
	if (!value) return null;
	const content = formatMetric({
		leading: theme.icon[iconKey] || undefined,
		value: statusValue(ctx, formatNumber(value)),
	});
	return content ? <span color={color}>{content}</span> : null;
}

export interface StatusSegmentViewProps {
	readonly id: StatusLineSegmentId;
	readonly ctx: SegmentContext;
}

/** One status-line segment rendered as inline style transitions. */
export function StatusSegmentView(props: StatusSegmentViewProps): JSX.Element {
	return statusSegmentNode(props.id, props.ctx);
}

/** Build the inline tree and visibility of one configured segment. */
export function statusSegmentNode(id: StatusLineSegmentId, ctx: SegmentContext): JSX.Element | null {
	switch (id) {
		case "pi": {
			if (ctx.focusedAgentId) {
				return iconNode(theme.style("warning"), theme.icon.ghost, statusValue(ctx, ctx.focusedAgentId));
			}
			const style = ctx.brandFg !== undefined ? Style.of({ fg: ctx.brandFg }) : theme.style("dim");
			const content =
				ctx.turnElapsedMs != null
					? `${brandSpinnerFrame(ctx.now?.getTime())} ${statusValue(ctx, brandTimer(ctx.turnElapsedMs))}`
					: theme.icon.omp || "";
			return content ? <span style={style}>{content}</span> : null;
		}
		case "status": {
			const statuses = (ctx.hookStatuses ?? []).map(sanitizeStatusText).filter(Boolean);
			if (statuses.length === 0) return null;
			const style = runAccentStyle(ctx, "accent");
			return (
				<>
					{statuses.map((status, index) => (
						<span key={index} style={style}>
							{index > 0 ? theme.sep.dot : ""}
							{status}
						</span>
					))}
				</>
			);
		}
		case "model": {
			const state = ctx.session.state;
			const opts = ctx.options.model ?? {};
			let modelName = state.model?.name || state.model?.id || "no-model";
			if (modelName.startsWith("Claude ")) modelName = modelName.slice(7);
			modelName = statusValue(ctx, modelName);
			let thinkingDisplay = "";
			if (opts.showThinkingLevel !== false && state.model?.thinking) {
				if (ctx.session.isAutoThinking) {
					const resolved = ctx.session.autoResolvedThinkingLevel();
					thinkingDisplay = resolved
						? (theme.thinking[resolved as keyof Theme["thinking"]] ?? resolved)
						: `${theme.thinking.autoPending} auto`;
				} else {
					const level = state.thinkingLevel ?? ThinkingLevel.Off;
					thinkingDisplay =
						level === ThinkingLevel.Off
							? `${theme.status.disabled} off`
							: (theme.thinking[level as keyof Theme["thinking"]] ?? level);
				}
			}
			if (ctx.startupPlaceholder && thinkingDisplay) {
				thinkingDisplay = withIcon(leadingGlyph(thinkingDisplay), STARTUP_PLACEHOLDER);
			}
			const compact = ctx.compactThinkingLevel && thinkingDisplay !== "";
			const modelIcon = compact ? leadingGlyph(thinkingDisplay) : theme.icon.model;
			const modelStyle = runAccentStyle(ctx, "statusLineModel");
			const advisorStats = ctx.session.getAdvisorStatusOverview?.();
			let advisor: JSX.Element | null = null;
			if (advisorStats?.configured && advisorStats.advisors.length > 0) {
				const statuses = advisorStats.advisors.map(a => a.status);
				const badgeColor = statuses.includes("error")
					? "error"
					: statuses.includes("quota_exhausted")
						? "warning"
						: statuses.includes("running")
							? "success"
							: "dim";
				const allYielded = advisorStats.advisors.every(a => a.yielded);
				const advisorIcon = allYielded ? theme.icon.advisorClosed || theme.icon.advisor : theme.icon.advisor;
				if (advisorIcon) advisor = <span color={badgeColor}> {advisorIcon}</span>;
			}
			return (
				<>
					{iconNode(modelStyle, modelIcon, modelName)}
					{advisor}
					{ctx.session.isFastModeActive() && theme.icon.fast ? (
						<span style={modelStyle}> {theme.icon.fast}</span>
					) : null}
					{!compact && thinkingDisplay ? (
						<span style={modelStyle}>
							{theme.sep.dot}
							{thinkingDisplay}
						</span>
					) : null}
				</>
			);
		}
		case "mode": {
			const pauseSuffix = theme.icon.pause ? ` ${theme.icon.pause}` : " (paused)";
			const plan = ctx.planMode;
			if (plan && (plan.enabled || plan.paused)) {
				return iconNode(
					plan.paused ? theme.style("warning") : runAccentStyle(ctx, "accent"),
					theme.icon.plan,
					plan.paused ? `Plan${pauseSuffix}` : "Plan",
				);
			}
			if (ctx.prewalk?.enabled) return iconNode(runAccentStyle(ctx, "accent"), theme.icon.prewalk, "Prewalk");
			const goalMode = ctx.goalMode;
			if (goalMode && (goalMode.enabled || goalMode.paused)) {
				const goal = ctx.session.getGoalModeState()?.goal;
				const status = goal?.status ?? (goalMode.paused ? "paused" : "active");
				let icon = theme.icon.goal;
				let color: ThemeColor = "accent";
				if (status === "paused") {
					icon = theme.icon.pause || theme.symbol("status.pending");
					color = "warning";
				} else if (status === "complete") {
					icon = theme.symbol("status.success");
					color = "success";
				} else if (status === "budget-limited") {
					icon = theme.symbol("status.warning");
					color = "warning";
				} else if (status === "dropped") {
					icon = theme.symbol("status.aborted");
					color = "dim";
				}
				const parts = [withIcon(icon, "Goal")];
				if (ctx.goalStatusInFooter === true && goal) {
					parts.push(statusValue(ctx, formatGoalBudget(goal.tokensUsed, goal.tokenBudget)));
				}
				return (
					<span style={color === "accent" ? runAccentStyle(ctx, color) : theme.style(color)}>
						{parts.join(" ")}
					</span>
				);
			}
			if (ctx.vibeMode?.enabled) return iconNode(runAccentStyle(ctx, "accent"), theme.icon.agents, "Vibe");
			const loop = ctx.loopMode;
			if (!loop) return null;
			const icon = loop.state === "paused" ? theme.icon.pause || theme.icon.loop : theme.icon.loop;
			const color: ThemeColor = loop.state === "paused" ? "warning" : "customMessageLabel";
			const parts = [withIcon(icon, `Loop ${statusValue(ctx, loop.state)}`)];
			const limit = formatLoopLimit(loop.limit, ctx.now?.getTime());
			if (limit) parts.push(statusValue(ctx, limit));
			if (loop.condition) parts.push(statusValue(ctx, summarizeLoopCondition(loop.condition)));
			return <span color={color}>{parts.join(" ")}</span>;
		}
		case "path": {
			const opts = ctx.options.path ?? {};
			const stripPrefix = opts.stripWorkPrefix !== false;
			const pathStyle = theme.style("statusLinePath");
			if (stripPrefix && ctx.worktree) {
				const { projectName, worktreeName } = ctx.worktree;
				const label = ctx.git.branch === worktreeName ? projectName : `${projectName}/${worktreeName}`;
				const text = ctx.startupPlaceholder ? STARTUP_PLACEHOLDER : clampPathLength(label, opts.maxLength ?? 40);
				return (
					<>
						{theme.icon.worktree ? <span style={pathStyle}>{theme.icon.worktree} </span> : null}
						<span
							style={
								ctx.startupPlaceholder ? pathStyle : fileHyperlinkStyle(getProjectDir(), undefined, pathStyle)
							}
						>
							{text}
						</span>
					</>
				);
			}
			const projectDir = ctx.activeRepo?.cwd ?? getProjectDir();
			const { scratch, relative } = classifyProjectDir(projectDir);
			let pwd = projectDir;
			if (stripPrefix) {
				if (scratch) {
					if (relative) pwd = relative;
				} else {
					pwd = stripDisplayRoot(pwd);
				}
			}
			const repoSuffix = ctx.activeRepo ? ` ↳ ${ctx.activeRepo.relativeRepoRoot}` : "";
			if (opts.abbreviate !== false) pwd = shortenPath(pwd);
			pwd = clampPathLength(pwd, opts.maxLength ?? 40);
			const icon = scratch && stripPrefix ? theme.icon.scratchFolder : theme.icon.folder;
			return (
				<>
					{icon ? <span style={pathStyle}>{icon} </span> : null}
					{ctx.startupPlaceholder ? (
						<span style={pathStyle}>{STARTUP_PLACEHOLDER}</span>
					) : (
						<>
							<span style={fileHyperlinkStyle(projectDir, undefined, pathStyle)}>{pwd}</span>
							{repoSuffix ? <span style={pathStyle}>{repoSuffix}</span> : null}
						</>
					)}
				</>
			);
		}
		case "git": {
			const { branch, status } = ctx.git;
			if (!branch && !status) return null;
			const opts = ctx.options.git ?? {};
			const dirty = !!status && (status.staged > 0 || status.unstaged > 0 || status.untracked > 0);
			const base = theme.style(dirty ? "statusLineGitDirty" : "statusLineGitClean");
			const runs: JSX.Element[] = [];
			if (opts.showBranch !== false && branch) {
				runs.push(iconNode(base, theme.icon.branch, statusValue(ctx, branch)));
			}
			const indicators: Array<readonly [Style, string]> = [];
			if (status && opts.showUnstaged !== false && status.unstaged > 0)
				indicators.push([theme.style("statusLineDirty"), `*${statusValue(ctx, `${status.unstaged}`)}`]);
			if (status && opts.showStaged !== false && status.staged > 0)
				indicators.push([theme.style("statusLineStaged"), `+${statusValue(ctx, `${status.staged}`)}`]);
			if (status && opts.showUntracked !== false && status.untracked > 0)
				indicators.push([theme.style("statusLineUntracked"), `?${statusValue(ctx, `${status.untracked}`)}`]);
			if (indicators.length > 0) {
				if (runs.length > 0)
					runs.push(
						<span key="branch-gap" style={base}>
							{" "}
						</span>,
					);
				else if (opts.showBranch === false && theme.icon.git)
					runs.push(
						<span key="git-icon" style={base}>
							{theme.icon.git}{" "}
						</span>,
					);
				for (let i = 0; i < indicators.length; i++) {
					const indicator = indicators[i]!;
					runs.push(
						<span key={`indicator:${i}`}>
							{i > 0 ? " " : null}
							<span style={indicator[0]}>{indicator[1]}</span>
						</span>,
					);
				}
			}
			return runs.length > 0 ? <>{runs}</> : null;
		}
		case "pr": {
			const pr = ctx.git.pr;
			if (!pr) return null;
			const style =
				!ctx.startupPlaceholder && TERMINAL.hyperlinks
					? runAccentStyle(ctx, "accent").withLink(linkId(pr.url))
					: runAccentStyle(ctx, "accent");
			return iconNode(style, theme.icon.pr, `#${statusValue(ctx, `${pr.number}`)}`);
		}
		case "subagents":
			return ctx.subagentCount === 0
				? null
				: iconNode(theme.style("statusLineSubagents"), theme.icon.agents, statusValue(ctx, `${ctx.subagentCount}`));
		case "token_in":
			return singleStatNode(ctx, "input", "input", "statusLineSpend");
		case "token_out":
			return singleStatNode(ctx, "output", "output", "statusLineOutput");
		case "token_total": {
			const { input, output, cacheWrite, orchestrationInput, orchestrationOutput } = ctx.usageStats;
			const total = input + output + cacheWrite + orchestrationInput + orchestrationOutput;
			return total
				? iconNode(theme.style("statusLineSpend"), theme.icon.tokens, statusValue(ctx, formatNumber(total)))
				: null;
		}
		case "token_rate": {
			const value = ctx.usageStats.tokensPerSecond;
			return value
				? iconNode(
						theme.style("statusLineOutput"),
						theme.icon.throughput,
						`${statusValue(ctx, value.toFixed(1))} tok/s`,
					)
				: null;
		}
		case "cost": {
			const { cost, premiumRequests } = ctx.usageStats;
			const advisorCost = ctx.session.getAdvisorCost?.() ?? 0;
			const state = ctx.session.state;
			const pricingPeriod = state.model?.cost
				? getTimeBasedPricingPeriod(state.model.cost, ctx.now?.getTime())
				: undefined;
			const usingSubscription = state.model
				? (ctx.session.modelRegistry?.isUsingOAuth(state.model) ?? false)
				: false;
			const billing = formatBillingSummary(
				{
					cost,
					usingSubscription,
					premiumRequests,
					fractionDigits: 2,
					startupPlaceholder: ctx.startupPlaceholder,
					pricingPeriod,
					advisor: advisorCost
						? { cost: advisorCost, usingSubscription: ctx.session.isAdvisorUsingSubscription?.() ?? false }
						: undefined,
				},
				theme,
			);
			return billing ? <span color="statusLineCost">{billing}</span> : null;
		}
		case "context_pct": {
			const pct = ctx.contextPercent;
			const color = getContextUsageThemeColor(getContextUsageLevel(pct ?? 0, ctx.contextWindow));
			const base = theme.style(color);
			const speculation = ctx.compactionSpeculation;
			const autoStyle =
				speculation === "running"
					? ctx.speculationBlinkOn
						? runAccentStyle(ctx, "accent")
						: theme.style("muted")
					: speculation === "armed"
						? runAccentStyle(ctx, "accent")
						: base;
			return (
				<>
					{theme.icon.context ? `${theme.icon.context} ` : null}
					<span style={base}>
						{ctx.startupPlaceholder
							? STARTUP_PLACEHOLDER
							: formatContextUsage(pct, ctx.contextWindow, ctx.contextTokens)}
					</span>
					{ctx.autoCompactEnabled && theme.icon.auto ? (
						<>
							{" "}
							<span style={autoStyle}>{theme.icon.auto}</span>
						</>
					) : null}
				</>
			);
		}
		case "context_total":
			return ctx.contextWindow
				? iconNode(
						theme.style("statusLineContext"),
						theme.icon.context,
						statusValue(ctx, formatNumber(ctx.contextWindow)),
					)
				: null;
		case "time_spent":
			return ctx.activeMs < 1000
				? null
				: iconNode(Style.NONE, theme.icon.time, statusValue(ctx, formatDuration(ctx.activeMs)));
		case "time": {
			const opts = ctx.options.time ?? {};
			const now = ctx.now ?? new Date(0);
			let hours = now.getHours();
			let suffix = "";
			if (opts.format === "12h") {
				suffix = hours >= 12 ? "pm" : "am";
				hours = hours % 12 || 12;
			}
			let text = `${hours}:${now.getMinutes().toString().padStart(2, "0")}`;
			if (opts.showSeconds) text += `:${now.getSeconds().toString().padStart(2, "0")}`;
			return iconNode(Style.NONE, theme.icon.time, statusValue(ctx, text + suffix));
		}
		case "session": {
			const sessionId = ctx.session.sessionManager?.getSessionId?.();
			return iconNode(Style.NONE, theme.icon.session, statusValue(ctx, sessionId?.slice(0, 8) || "new"));
		}
		case "hostname":
			return iconNode(
				ctx.sessionAccent === false ? Style.NONE : runAccentStyle(ctx, "accent"),
				theme.icon.host,
				statusValue(ctx, ctx.hostname ?? hostname().split(".")[0]),
			);
		case "cache_read":
			return singleStatNode(ctx, "cacheRead", "cache", "statusLineSpend");
		case "cache_write":
			return singleStatNode(ctx, "cacheWrite", "cache", "statusLineOutput");
		case "cache_hit": {
			const { cacheRead, cacheWrite, input } = ctx.usageStats;
			if (!cacheRead) return null;
			const rate = (cacheRead / (cacheRead + cacheWrite + input)) * 100;
			return (
				<>
					{theme.icon.cache ? `${theme.icon.cache} ` : null}
					<span color="statusLineSpend">{statusValue(ctx, rate.toFixed(2))}%</span>
				</>
			);
		}
		case "session_name": {
			const name = ctx.session.sessionManager?.getSessionName() || ctx.previewTitle;
			return name ? (
				<span style={runAccentStyle(ctx, "accent")}>
					{ctx.startupPlaceholder ? STARTUP_PLACEHOLDER : sanitizeStatusText(name)}
				</span>
			) : null;
		}
		case "collab":
			if (!ctx.collab) return null;
			return (
				<span style={runAccentStyle(ctx, "accent")}>
					{ctx.collab.role === "host"
						? `⇄ collab:${statusValue(ctx, `${ctx.collab.participantCount}`)}`
						: `⇄ collab guest:${statusValue(ctx, `${ctx.collab.participantCount}`)}`}
				</span>
			);
		case "stream":
			return ctx.stream ? (
				<span color="thinkingHigh">● LIVE {statusValue(ctx, `${ctx.stream.viewers}`)}</span>
			) : null;
		case "vim": {
			const vim = ctx.vim;
			if (!vim || vim.display === "none") return null;
			let label = vim.display === "icon" ? theme.symbol(VIM_MODE_ICON_KEYS[vim.mode]) : VIM_MODE_LABELS[vim.mode];
			if (vim.selectedLines > 1) label += ` ${vim.selectedLines}L`;
			return (
				<>
					<span color={VIM_MODE_COLORS[vim.mode]}>{label}</span>
					{vim.pending ? <span color="muted"> {vim.pending}</span> : null}
				</>
			);
		}
		case "usage": {
			const usage = ctx.usage;
			if (!usage || (!usage.fiveHour && !usage.daily && !usage.sevenDay && !usage.monthly)) return null;
			const runs: JSX.Element[] = [];
			if (theme.icon.time) runs.push(`${theme.icon.time} `);
			const addSeparator = (): void => {
				if (runs.length > (theme.icon.time ? 1 : 0)) runs.push(theme.sep.dot);
			};
			if (usage.tier) {
				const cleanTier = sanitizeStatusText(usage.tier);
				const tier = ctx.startupPlaceholder
					? STARTUP_PLACEHOLDER
					: cellWidth(cleanTier) > TRUNCATE_LENGTHS.SHORT
						? `${takeCells(cleanTier, TRUNCATE_LENGTHS.SHORT - 1)}…`
						: cleanTier;
				if (tier) {
					addSeparator();
					runs.push(
						<span key="tier" style={runAccentStyle(ctx, "accent")}>
							{tier}
						</span>,
					);
				}
			}
			const addWindow = (
				key: string,
				label: string,
				percent: number,
				reset: number | undefined,
				resetUnit: "m" | "h",
				integer: "round" | "floor",
			): void => {
				addSeparator();
				const whole = integer === "floor" ? Math.floor(percent) : Math.round(percent);
				runs.push(
					<span key={key}>
						{label} <span color={pickUsageColor(percent)}>{statusValue(ctx, `${whole}`)}%</span>
						{reset === undefined ? null : (
							<span color="muted">
								{ctx.startupPlaceholder ? " (…)" : ` (${formatUsageReset(reset, resetUnit)})`}
							</span>
						)}
					</span>,
				);
			};
			if (usage.fiveHour) addWindow("5h", "5h", usage.fiveHour.percent, usage.fiveHour.resetMinutes, "m", "round");
			if (usage.daily) addWindow("1d", "1d", usage.daily.percent, usage.daily.resetMinutes, "m", "round");
			if (usage.sevenDay) addWindow("7d", "7d", usage.sevenDay.percent, usage.sevenDay.resetHours, "h", "round");
			if (usage.monthly) addWindow("mo", "mo", usage.monthly.percent, usage.monthly.resetHours, "h", "floor");
			return <>{runs}</>;
		}
	}
}

function registeredSegment(id: StatusLineSegmentId): StatusLineSegment {
	return {
		id,
		render(ctx) {
			return renderSegment(id, ctx);
		},
	};
}

export const SEGMENTS: Record<StatusLineSegmentId, StatusLineSegment> = {
	pi: registeredSegment("pi"),
	status: registeredSegment("status"),
	model: registeredSegment("model"),
	mode: registeredSegment("mode"),
	path: registeredSegment("path"),
	git: registeredSegment("git"),
	pr: registeredSegment("pr"),
	subagents: registeredSegment("subagents"),
	token_in: registeredSegment("token_in"),
	token_out: registeredSegment("token_out"),
	token_total: registeredSegment("token_total"),
	token_rate: registeredSegment("token_rate"),
	cost: registeredSegment("cost"),
	context_pct: registeredSegment("context_pct"),
	context_total: registeredSegment("context_total"),
	time_spent: registeredSegment("time_spent"),
	time: registeredSegment("time"),
	session: registeredSegment("session"),
	hostname: registeredSegment("hostname"),
	cache_read: registeredSegment("cache_read"),
	cache_write: registeredSegment("cache_write"),
	cache_hit: registeredSegment("cache_hit"),
	session_name: registeredSegment("session_name"),
	usage: registeredSegment("usage"),
	collab: registeredSegment("collab"),
	stream: registeredSegment("stream"),
	vim: registeredSegment("vim"),
};

export const ALL_SEGMENT_IDS: StatusLineSegmentId[] = [...STATUS_LINE_SEGMENT_IDS];
