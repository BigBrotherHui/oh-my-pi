import * as os from "node:os";
import { colorLuma, formatDuration, hexToRgb, sanitizeText } from "@oh-my-pi/pi-utils";
import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { rgb, type Color } from "../core/style";
import { formatProviderName } from "../chrome/format";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import { matchesKey } from "../keys";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	useClock,
	useTheme,
	type JSX,
	type ThemeAccess,
} from "../reactive";
import type { TUI } from "../tui";
import type { Theme } from "../theme/theme";
import { replaceTabs } from "../utils";
import { collapseSharedUsageReports, formatLimitTitle } from "./usage-display";
import { formatAbsoluteOnlyAmount } from "../prompt/usage-amounts";

export interface DailyActivityPoint {
	day: string;
	cost: number;
	requests: number;
}

export interface CardWindowRow {
	label: string;
	windowTag?: string;
	fraction: number | undefined;
	status: UsageLimit["status"];
	resetMs?: number;
	usedText?: string;
}

export interface ProviderCard {
	provider: string;
	name: string;
	accounts: number;
	windows: CardWindowRow[];
	unlimited: boolean;
	idle: boolean;
}

function aggregateStatus(limits: readonly { status?: UsageLimit["status"] }[]): UsageLimit["status"] {
	const hasOk = limits.some(limit => limit.status === "ok");
	const hasWarning = limits.some(limit => limit.status === "warning");
	const hasExhausted = limits.some(limit => limit.status === "exhausted");
	if (hasOk) return hasWarning || hasExhausted ? "warning" : "ok";
	if (hasWarning) return "warning";
	if (hasExhausted) return "exhausted";
	return "unknown";
}

const IDLE_FRACTION = 0.005;

function compactWindowTag(window: NonNullable<UsageLimit["window"]>): string {
	if (window.durationMs) {
		const hours = window.durationMs / 3_600_000;
		if (hours >= 28 * 24) return "mo";
		if (hours >= 24) return `${Math.round(hours / 24)}d`;
		return `${Math.round(hours)}h`;
	}
	const id = window.id.toLowerCase();
	return id.length <= 3 ? id : id.slice(0, 1);
}

export function buildProviderCards(reports: UsageReport[], nowMs: number): ProviderCard[] {
	const grouped = new Map<string, UsageReport[]>();
	for (const report of collapseSharedUsageReports(reports)) {
		const providerReports = grouped.get(report.provider) ?? [];
		providerReports.push(report);
		grouped.set(report.provider, providerReports);
	}

	const cards: ProviderCard[] = [];
	for (const [provider, providerReports] of grouped) {
		const buckets = new Map<string, { label: string; limits: UsageLimit[] }>();
		for (const report of providerReports) {
			for (const limit of report.limits) {
				const label = formatLimitTitle(limit);
				const key = `${label}|${limit.window?.id ?? limit.scope.windowId ?? "default"}`;
				const bucket = buckets.get(key) ?? { label, limits: [] };
				bucket.limits.push(limit);
				buckets.set(key, bucket);
			}
		}

		const windows = [...buckets.values()].map(bucket => {
			const fractions = bucket.limits
				.map(resolveUsedFraction)
				.filter((value): value is number => value !== undefined);
			const worst = bucket.limits.reduce((left, right) =>
				(resolveUsedFraction(right) ?? -1) > (resolveUsedFraction(left) ?? -1) ? right : left,
			);
			const resetsAt = worst.window?.resetsAt;
			return {
				label: bucket.label,
				windowTag: worst.window ? compactWindowTag(worst.window) : undefined,
				fraction:
					fractions.length > 0 ? fractions.reduce((sum, value) => sum + value, 0) / fractions.length : undefined,
				status: aggregateStatus(bucket.limits),
				resetMs: resetsAt !== undefined && resetsAt > nowMs ? resetsAt - nowMs : undefined,
				usedText: fractions.length === 0 ? formatAbsoluteOnlyAmount(bucket.limits) : undefined,
			};
		});
		windows.sort((left, right) => (right.fraction ?? -1) - (left.fraction ?? -1));
		for (const window of windows) {
			if (!windows.some(other => other !== window && other.label === window.label)) window.windowTag = undefined;
		}

		cards.push({
			provider,
			name: formatProviderName(provider),
			accounts: providerReports.length,
			windows,
			unlimited: windows.length === 0,
			idle: windows.every(window => window.fraction !== undefined && window.fraction < IDLE_FRACTION),
		});
	}

	return cards.sort(
		(left, right) =>
			(right.windows[0]?.fraction ?? -1) - (left.windows[0]?.fraction ?? -1) || left.name.localeCompare(right.name),
	);
}

export interface HeatmapLayout {
	monthLabels: (string | undefined)[];
	cells: (number | null)[][];
	totalCost: number;
	totalRequests: number;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const HEATMAP_DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

function dayKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function daysAfter(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function buildHeatmapLayout(points: DailyActivityPoint[], weeks: number, today = new Date()): HeatmapLayout {
	const byDay = new Map(points.map(point => [point.day, point]));
	const usesCost = points.some(point => point.cost > 0);
	const metric = (point: DailyActivityPoint): number => (usesCost ? point.cost : point.requests);
	const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
	const monday = daysAfter(midnight, -((midnight.getDay() + 6) % 7));
	const start = daysAfter(monday, -(weeks - 1) * 7);
	const range = points.filter(point => point.day >= dayKey(start) && point.day <= dayKey(midnight));
	const max = range.reduce((highest, point) => Math.max(highest, metric(point)), 0);
	const cells = Array.from({ length: 7 }, () => Array.from({ length: weeks }, (): number | null => null));
	const monthLabels: (string | undefined)[] = [];
	let previousMonth = -1;

	for (let week = 0; week < weeks; week++) {
		const weekStart = daysAfter(start, week * 7);
		monthLabels.push(weekStart.getMonth() === previousMonth ? undefined : MONTH_NAMES[weekStart.getMonth()]);
		previousMonth = weekStart.getMonth();
		for (let day = 0; day < 7; day++) {
			const date = daysAfter(weekStart, day);
			if (date > midnight) continue;
			const value = metric(byDay.get(dayKey(date)) ?? { day: "", cost: 0, requests: 0 });
			cells[day]![week] =
				value <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(value / max) * 4)));
		}
	}

	return {
		monthLabels,
		cells,
		totalCost: range.reduce((sum, point) => sum + point.cost, 0),
		totalRequests: range.reduce((sum, point) => sum + point.requests, 0),
	};
}

export interface UsageDashboardOptions {
	reports: UsageReport[];
	renderDetail(): JSX.Element;
	loadActivity(push: (points: DailyActivityPoint[]) => void, signal: AbortSignal): Promise<void>;
	onClose: () => void;
}

export function formatActivityErrorDetail(error: string, homeDir = os.homedir()): string {
	let text = replaceTabs(sanitizeText(error)).replace(/\s+/g, " ").trim();
	if (homeDir) {
		const escaped = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const forward = homeDir.replaceAll("\\", "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		text = text.replace(new RegExp(`${escaped}|${forward}`, "gi"), "~");
	}
	return text.replace(/\.+$/, "");
}

const CARD_MIN_WIDTH = 32;
const CARD_GUTTER = 3;
const CARD_MAX_WINDOWS = 4;
const WHOLE_DOLLARS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const COMPACT_REQUESTS = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

type StatusTone = "success" | "warning" | "error" | "dim";

function statusTone(status: UsageLimit["status"]): StatusTone {
	if (status === "exhausted") return "error";
	if (status === "warning") return "warning";
	if (status === "ok") return "success";
	return "dim";
}

function statusSymbol(status: UsageLimit["status"], symbols: ThemeAccess["symbol"]): string {
	if (status === "exhausted") return symbols("status.error");
	if (status === "warning") return symbols("status.warning");
	if (status === "ok") return symbols("status.success");
	return symbols("status.info");
}

function WindowLabel(props: { readonly window: CardWindowRow }): JSX.Element {
	return (
		<row grow={1} shrink={1} wrap="continuation" continuationIndent={2}>
			<text grow={1} shrink={1} overflowPriority={0} color="muted" wrap="none" overflow="ellipsis">
				{props.window.label}
			</text>
			{props.window.windowTag ? (
				<text shrink={1} overflowPriority={1} color="dim" wrap="none" overflow="ellipsis">
					{props.window.windowTag}
				</text>
			) : null}
		</row>
	);
}

function ProviderCardView(props: {
	readonly card: ProviderCard;
	readonly symbols: ThemeAccess["symbol"];
}): JSX.Element {
	const cardStatus = props.card.unlimited ? "ok" : aggregateStatus(props.card.windows);
	const accounts = props.card.accounts > 1 ? `${props.card.accounts} accts` : "";
	if (props.card.unlimited) {
		return (
			<stack>
				<row>
					<text shrink={0} color={statusTone(cardStatus)}>
						{statusSymbol(cardStatus, props.symbols)}{" "}
					</text>
					<text grow={1} shrink={1} overflowPriority={0} bold wrap="none" overflow="ellipsis">
						{props.card.name}
					</text>
					{accounts ? (
						<text shrink={1} overflowPriority={1} color="dim" wrap="none" overflow="ellipsis">
							{accounts}
						</text>
					) : null}
				</row>
				<text color="dim"> no limits</text>
			</stack>
		);
	}

	const windows = props.card.windows.slice(0, CARD_MAX_WINDOWS);
	const hidden = props.card.windows.length - windows.length;
	return (
		<stack>
			<row>
				<text shrink={0} color={statusTone(cardStatus)}>
					{statusSymbol(cardStatus, props.symbols)}{" "}
				</text>
				<text grow={1} shrink={1} overflowPriority={0} bold wrap="none" overflow="ellipsis">
					{props.card.name}
				</text>
				{accounts ? (
					<text shrink={1} overflowPriority={1} color="dim" wrap="none" overflow="ellipsis">
						{accounts}
					</text>
				) : null}
			</row>
			{windows.map(window => {
				if (window.fraction === undefined) {
					return (
						<row>
							<text shrink={0}> </text>
							<WindowLabel window={window} />
							<text shrink={1} overflowPriority={1} color="dim" wrap="none" overflow="ellipsis">
								{window.usedText ?? "no data"}
							</text>
						</row>
					);
				}
				const free = Math.max(0, Math.round((1 - window.fraction) * 100));
				const reset = window.resetMs === undefined ? undefined : formatDuration(window.resetMs);
				return (
					<row>
						<text shrink={0}> </text>
						<WindowLabel window={window} />
						<progress
							grow={1}
							shrink={1}
							minWidth={5}
							overflowPriority={1}
							value={window.fraction}
							color={statusTone(window.status)}
						/>
						<text
							shrink={1}
							overflowPriority={2}
							color={statusTone(window.status)}
							wrap="none"
							overflow="ellipsis"
						>{`${free}%`}</text>
						{reset ? (
							<text shrink={1} overflowPriority={1} color="dim" wrap="none" overflow="ellipsis">
								{reset}
							</text>
						) : null}
					</row>
				);
			})}
			{hidden > 0 ? <text color="dim"> +{hidden} more</text> : null}
		</stack>
	);
}

function ProviderCardsGrid(props: {
	cards: ProviderCard[];
	width: number;
	symbols: ThemeAccess["symbol"];
}): JSX.Element {
	if (props.cards.length === 0) return <text color="dim">No usage data available.</text>;
	const active = props.cards.filter(card => !card.idle);
	const idle = props.cards.filter(card => card.idle);
	const columns = Math.max(1, Math.floor((props.width + CARD_GUTTER) / (CARD_MIN_WIDTH + CARD_GUTTER)));
	const cardWidth = Math.floor((props.width - (columns - 1) * CARD_GUTTER) / columns);
	const rows: JSX.Element[] = [];

	for (let start = 0; start < active.length; start += columns) {
		const cards = active.slice(start, start + columns);
		rows.push(
			<row gap={CARD_GUTTER} align="start">
				{cards.map(card => (
					<box width={cardWidth} shrink={0}>
						<ProviderCardView card={card} symbols={props.symbols} />
					</box>
				))}
			</row>,
		);
	}
	if (idle.length > 0) {
		rows.push(
			<row>
				<text color="success">{props.symbols("status.success")} </text>
				<text color="dim" grow={1} wrap="none" overflow="ellipsis">
					untouched: {idle.map(card => card.name).join(" · ")}
				</text>
			</row>,
		);
	}
	return <stack gap={1}>{rows}</stack>;
}

function heatRamp(accent: string, text: string): Color[] {
	const darkBackground = (colorLuma(text) ?? 1) > 0.5;
	const from = darkBackground ? { r: 20, g: 20, b: 24 } : { r: 244, g: 244, b: 246 };
	const to = hexToRgb(accent);
	return [0.3, 0.5, 0.72, 1].map(amount =>
		rgb(
			Math.round(from.r + (to.r - from.r) * amount),
			Math.round(from.g + (to.g - from.g) * amount),
			Math.round(from.b + (to.b - from.b) * amount),
		),
	);
}

function activityWeeks(width: number): number {
	return Math.max(4, Math.min(53, Math.floor((width - 2) / 2)));
}

function ActivityHeatmap(props: {
	points: DailyActivityPoint[] | undefined;
	error: string | undefined;
	syncing: boolean;
	width: number;
	now: number;
	palette: Theme;
}): JSX.Element {
	if (props.error !== undefined) {
		const detail = formatActivityErrorDetail(props.error);
		return (
			<text color="dim" wrap="none" overflow="ellipsis">
				{detail ? `Usage history unavailable (${detail}).` : "Usage history unavailable."}
			</text>
		);
	}
	if (props.points === undefined) return <text color="dim">Loading usage history…</text>;

	const weeks = activityWeeks(props.width);
	const layout = buildHeatmapLayout(props.points, weeks, new Date(props.now));
	const cost =
		layout.totalCost >= 1 ? `$${WHOLE_DOLLARS.format(layout.totalCost)}` : `$${layout.totalCost.toFixed(2)}`;
	const requests = COMPACT_REQUESTS.format(layout.totalRequests);
	const ramp = heatRamp(props.palette.getColorHex("accent"), props.palette.getColorHex("text"));
	let monthLine = "  ";
	for (let week = 0; week < weeks; week++) {
		const label = layout.monthLabels[week];
		const column = 2 + week * 2;
		if (label && column >= monthLine.length) monthLine = monthLine.padEnd(column) + label;
	}

	return (
		<stack>
			<text wrap="none" overflow="ellipsis">
				<span color="accent" bold>
					Activity
				</span>
				<span color="dim">
					{" "}
					{cost} · {requests} requests · last {weeks} weeks{props.syncing ? " · syncing…" : ""}
				</span>
			</text>
			<br />
			<text color="dim" wrap="none" overflow="ellipsis">
				{monthLine}
			</text>
			{HEATMAP_DAY_LABELS.map((label, day) => (
				<text wrap="none" overflow="ellipsis">
					<span color="dim">{label} </span>
					{layout.cells[day]!.map((cell, week) => {
						const gap = week + 1 === weeks ? "" : " ";
						if (cell === null) return <span>{` ${gap}`}</span>;
						if (cell === 0) return <span color="dim">·{gap}</span>;
						return <span color={ramp[cell - 1]!}>■{gap}</span>;
					})}
				</text>
			))}
		</stack>
	);
}

interface OverviewSnapshot {
	readonly cards: ProviderCard[];
	readonly points: DailyActivityPoint[] | undefined;
	readonly error: string | undefined;
	readonly syncing: boolean;
	readonly now: number;
	readonly palette: Theme;
}

function OverviewContent(props: {
	readonly snapshot: OverviewSnapshot;
	readonly symbols: ThemeAccess["symbol"];
}): JSX.Element {
	return (
		<stack>
			<sized
				paint={width => <ProviderCardsGrid cards={props.snapshot.cards} width={width} symbols={props.symbols} />}
			/>
			<br />
			<sized
				paint={width => (
					<ActivityHeatmap
						points={props.snapshot.points}
						error={props.snapshot.error}
						syncing={props.snapshot.syncing}
						width={width}
						now={props.snapshot.now}
						palette={props.snapshot.palette}
					/>
				)}
			/>
		</stack>
	);
}

export function UsageDashboardView(props: { readonly options: UsageDashboardOptions }): JSX.Element {
	const [detail, setDetail] = createSignal(false);
	const [offset, setOffset] = createSignal(0);
	const [activity, setActivity] = createSignal<DailyActivityPoint[]>();
	const [error, setError] = createSignal<string>();
	const [syncing, setSyncing] = createSignal(true);
	const [viewport, setViewport] = createSignal({ height: 1, totalRows: 0 });
	const now = useClock("second");
	const theme = useTheme();
	const cards = createMemo(() => buildProviderCards(props.options.reports, now()));
	const snapshot = createMemo<OverviewSnapshot>(() => ({
		cards: cards(),
		points: activity(),
		error: error(),
		syncing: syncing(),
		now: now(),
		palette: theme.theme(),
	}));
	const clampOffset = (value: number): number =>
		Math.max(0, Math.min(value, viewport().totalRows - viewport().height));
	const move = (amount: number): void => {
		setOffset(previous => clampOffset(previous + amount));
	};
	const resetOffset = (): void => {
		setOffset(0);
	};

	createEffect(() => {
		let active = true;
		const controller = new AbortController();
		void props.options
			.loadActivity(points => {
				if (!active) return;
				setActivity(points);
				setOffset(clampOffset);
			}, controller.signal)
			.catch(cause => {
				if (!active) return;
				setError(cause instanceof Error ? cause.message : String(cause));
				setOffset(clampOffset);
			})
			.finally(() => {
				if (!active) return;
				setSyncing(false);
			});
		onCleanup(() => {
			active = false;
			controller.abort();
		});
	});

	const bodyPaint = createMemo(() => {
		if (detail()) return (): JSX.Element => props.options.renderDetail();
		const overview = snapshot();
		return (): JSX.Element => <OverviewContent snapshot={overview} symbols={theme.symbol} />;
	});
	const footer = createMemo(() => {
		const scrollHint = viewport().totalRows > viewport().height ? "↑/↓ scroll · " : "";
		return detail() ? `${scrollHint}Esc back` : `${scrollHint}↵ details · Esc close`;
	});
	const checkedText = createMemo(() => {
		const latestFetchedAt = Math.max(0, ...props.options.reports.map(report => report.fetchedAt ?? 0));
		return latestFetchedAt ? `checked ${formatDuration(now() - latestFetchedAt)} ago` : "";
	});

	const handleKey = (event: HostKeyEvent): void => {
		const showingDetail = detail();
		if (
			matchesSelectCancel(event.data) ||
			matchesKey(event.data, "escape") ||
			matchesKey(event.data, "esc") ||
			matchesKey(event.data, "q")
		) {
			if (showingDetail) {
				setDetail(false);
				resetOffset();
			} else {
				props.options.onClose();
			}
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (
			!showingDetail &&
			(matchesKey(event.data, "enter") ||
				matchesKey(event.data, "return") ||
				matchesKey(event.data, "tab") ||
				matchesKey(event.data, "d"))
		) {
			setDetail(true);
			resetOffset();
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (matchesSelectUp(event.data)) move(-1);
		else if (matchesSelectDown(event.data)) move(1);
		else if (matchesSelectPageUp(event.data)) move(-viewport().height);
		else if (matchesSelectPageDown(event.data)) move(viewport().height);
		else if (matchesKey(event.data, "home")) resetOffset();
		else if (matchesKey(event.data, "end")) setOffset(clampOffset(Number.MAX_SAFE_INTEGER));
		else return;
		event.preventDefault();
		event.stopPropagation();
	};
	const handleMouse = (event: HostMouseEvent): void => {
		if (event.wheel === 0) return;
		move(event.wheel * 2);
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<box height="fill" onKey={handleKey} onMouse={handleMouse} tabIndex={0}>
			<frame
				height="fill"
				title={detail() ? "Usage · Details" : "Usage"}
				paddingX={1}
				paddingY={0}
				borderPolicy="always"
				renderEmpty
			>
				<stack height="fill">
					<text color="dim" wrap="none" overflow="ellipsis">
						{checkedText()}
					</text>
					<scroll
						grow={1}
						offset={offset()}
						followTail={false}
						scrollbar="never"
						onViewport={next => {
							setViewport({ height: next.height, totalRows: next.totalRows });
							setOffset(clampOffset);
						}}
					>
						<sized paint={bodyPaint()} />
					</scroll>
					<hr variant="frame" />
					<text color="dim" wrap="none" overflow="ellipsis">
						{footer()}
					</text>
				</stack>
			</frame>
		</box>
	);
}

export function openUsageDashboardOverlay(tui: TUI, options: UsageDashboardOptions): OverlayDisposer {
	return mountOverlay(tui, () => (
		<Portal to="overlay" fullscreen>
			<UsageDashboardView options={options} />
		</Portal>
	));
}
