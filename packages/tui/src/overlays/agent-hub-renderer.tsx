import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { formatAge, formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { formatMetricRow } from "../components/metric";
import { formatLocalDateTimeWithOffset } from "../chrome/local-date";
import type { HostMouseEvent } from "../host/input";
import { For, Show, type JSX } from "../reactive";
import { parseThinkingLevel } from "../thinking";
import { theme, type ThemeColor } from "../theme/theme";
import type { AgentActivityRow } from "./agent-activity";
import type { AgentMetrics, AggregateMetrics } from "./agent-hub-projection";
import { type AgentRecordLike, MAIN_AGENT_ID } from "./agent-hub-types";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import type { ObservableSession } from "./session-observer-registry";

/** Tree ancestry supplied by the agent projection. */
export interface AgentHubTreeLayout {
	readonly depthById: ReadonlyMap<string, number>;
	readonly parentById: ReadonlyMap<string, string>;
	readonly lastSiblingById: ReadonlyMap<string, boolean>;
	readonly maxDepth: number;
}

export type AgentHubViewMode = "roster" | "tree";

/** Host-resolved model-role label and color. */
export interface AgentRoleDisplay {
	readonly color?: ThemeColor;
	readonly tag?: string;
	readonly name?: string;
}

/** Preserve the CLI contract: invalid and negative monetary values display as zero. */
export function formatCost(cost: number): string {
	const amount = Number.isFinite(cost) ? Math.max(0, cost) : 0;
	if (amount < 0.01) return `$${amount.toFixed(4)}`;
	if (amount < 1) return `$${amount.toFixed(3)}`;
	return `$${amount.toFixed(2)}`;
}

function metricNumber(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Semantic foreground tone for a retained agent state. */
export function statusColor(status: AgentRecordLike["status"]): ThemeColor {
	switch (status) {
		case "running":
			return "accent";
		case "idle":
			return "success";
		case "parked":
			return "muted";
		case "aborted":
			return "error";
	}
}

function statusValue(status: AgentRecordLike["status"]): "running" | "success" | "info" | "aborted" {
	if (status === "idle") return "success";
	if (status === "parked") return "info";
	if (status === "aborted") return "aborted";
	return "running";
}

/** Retained status glyph preserving the historical state semantics. */
export function AgentHubStatusGlyph(props: { readonly status: AgentRecordLike["status"] }): JSX.Element {
	return <status value={statusValue(props.status)} />;
}

/** Retained status text preserving state color. */
export function AgentHubStatusText(props: {
	readonly status: AgentRecordLike["status"];
	readonly children: JSX.Element;
}): JSX.Element {
	return <span color={statusColor(props.status)}>{props.children}</span>;
}

/** Textual model-role tag; color reinforces but never replaces the label. */
export function roleBadgeLabel(role: string, info: AgentRoleDisplay): string {
	return sanitizeDisplaySingleLine(info.tag ?? info.name ?? role);
}

/** Retained model-role tag. */
export function AgentHubRoleBadge(props: { readonly role: string; readonly info: AgentRoleDisplay }): JSX.Element {
	return <badge color={props.info.color ?? "muted"}>{roleBadgeLabel(props.role, props.info)}</badge>;
}

interface ModelBadgeData {
	readonly fallback: boolean;
	readonly label: string;
	readonly level?: ThinkingLevel;
}

function resolvedModelBadge(resolved: string, preserveProvider = false, fallbackLevel?: ThinkingLevel): ModelBadgeData {
	const cleanResolved = sanitizeDisplaySingleLine(resolved);
	const colon = cleanResolved.lastIndexOf(":");
	const explicitLevel = colon >= 0 ? parseThinkingLevel(cleanResolved.slice(colon + 1)) : undefined;
	const selector = explicitLevel !== undefined ? cleanResolved.slice(0, colon) : cleanResolved;
	return {
		fallback: false,
		label: preserveProvider ? selector : selector.slice(selector.indexOf("/") + 1),
		level: explicitLevel ?? fallbackLevel,
	};
}

/** Data form of the resolved model label. */
export function modelBadgeData(
	ref: AgentRecordLike,
	observed: ObservableSession | undefined,
): ModelBadgeData | undefined {
	const progress = observed?.progress;
	const liveThinkingLevel = ref.session?.thinkingLevel;
	const serving = ref.session?.servingModel;
	const fallbackSelector =
		(serving?.isFallback ? serving.selector : undefined) ??
		(progress?.resolvedModelIsFallback ? progress.resolvedModel : undefined) ??
		(ref.history?.resolvedModelIsFallback ? ref.history.resolvedModel : undefined);
	if (fallbackSelector) return { ...resolvedModelBadge(fallbackSelector, true, liveThinkingLevel), fallback: true };
	const resolvedModel = progress?.resolvedModel ?? ref.history?.resolvedModel ?? serving?.selector;
	if (resolvedModel) return resolvedModelBadge(resolvedModel, false, liveThinkingLevel);
	const model = ref.session?.model;
	return model
		? {
				fallback: false,
				label: sanitizeDisplaySingleLine(model.id),
				level: model.thinking ? liveThinkingLevel : undefined,
			}
		: undefined;
}

function thinkingColor(level: ThinkingLevel): ThemeColor {
	switch (level) {
		case ThinkingLevel.Minimal:
			return "thinkingMinimal";
		case ThinkingLevel.Low:
			return "thinkingLow";
		case ThinkingLevel.Medium:
			return "thinkingMedium";
		case ThinkingLevel.High:
			return "thinkingHigh";
		case ThinkingLevel.XHigh:
			return "thinkingXhigh";
		case ThinkingLevel.Max:
			return "thinkingMax";
		default:
			return "thinkingOff";
	}
}

function thinkingSymbol(level: ThinkingLevel): string {
	switch (level) {
		case ThinkingLevel.Minimal:
			return theme.thinking.minimal;
		case ThinkingLevel.Low:
			return theme.thinking.low;
		case ThinkingLevel.Medium:
			return theme.thinking.medium;
		case ThinkingLevel.High:
			return theme.thinking.high;
		case ThinkingLevel.XHigh:
			return theme.thinking.xhigh;
		case ThinkingLevel.Max:
			return theme.thinking.max;
		default:
			return level;
	}
}

/** Retained resolved-model badge with fallback and thinking decorations. */
export function AgentHubModelBadge(props: {
	readonly ref: AgentRecordLike;
	readonly observed?: ObservableSession;
}): JSX.Element | null {
	const data = modelBadgeData(props.ref, props.observed);
	if (!data) return null;
	const showLevel =
		data.level !== undefined && data.level !== ThinkingLevel.Off && data.level !== ThinkingLevel.Inherit;
	return (
		<text color="muted" shrink={1} minWidth={0} wrap="none" overflow="ellipsis">
			{data.fallback ? <span color="warning">fallback → </span> : null}
			{data.label}
			{showLevel && data.level !== undefined ? (
				<span color={thinkingColor(data.level)}> {thinkingSymbol(data.level)}</span>
			) : null}
		</text>
	);
}

/** Formats a duration preserving the source metric kind. */
export function formatMetricDuration(metrics: AgentMetrics): string | undefined {
	const durationMs = metricNumber(metrics.durationMs);
	if (durationMs <= 0) return undefined;
	const label = metrics.durationKind === "active" ? "active" : metrics.durationKind === "span" ? "span" : "duration";
	return `${formatDuration(durationMs)} ${label}`;
}

/** Compact semantic metric summary. */
export function formatMetrics(metrics: AgentMetrics): string {
	return formatMetricRow(
		[
			{ value: formatCost(metrics.cost) },
			{ value: formatMetricDuration(metrics) ?? "time —" },
			{ value: `${formatNumber(metrics.requests)} req` },
			{ value: `${formatNumber(metrics.tools)} tools` },
			{ value: `${formatNumber(metrics.tokens)} tok` },
		],
		{ separator: theme.sep.dot },
	);
}

/** Retained context gauge with native inline composition. */
export function AgentHubContextGauge(props: { readonly tokens: number; readonly window: number }): JSX.Element {
	const ratio = Math.max(0, Math.min(1, props.tokens / props.window));
	const filled = Number.isFinite(ratio) ? Math.round(ratio * 10) : 0;
	return (
		<row gap={1} pad={false}>
			<span>
				<span color="accent">{"━".repeat(filled)}</span>
				<span color="dim">{"─".repeat(10 - filled)}</span>
			</span>
			<text wrap="clip">
				{formatNumber(props.tokens)}/{formatNumber(props.window)} {Math.round(ratio * 100)}%
			</text>
		</row>
	);
}

function roleFor(ref: AgentRecordLike, observed: ObservableSession | undefined): string | undefined {
	return observed?.progress?.modelRole ?? ref.history?.modelRole;
}

function currentTask(ref: AgentRecordLike, observed: ObservableSession | undefined): string | undefined {
	return observed?.description ?? observed?.progress?.task ?? ref.activity;
}

function activityColor(row: AgentActivityRow): ThemeColor {
	if (row.status === "error") return "error";
	if (row.status === "aborted") return "warning";
	if (row.status === "pending") return "accent";
	return row.kind === "response" || row.kind === "tool" ? "success" : row.kind === "irc" ? "accent" : "muted";
}

function activityStatus(row: AgentActivityRow): "success" | "error" | "aborted" | "running" | "info" {
	if (row.status === "error") return "error";
	if (row.status === "aborted") return "aborted";
	if (row.status === "pending") return "running";
	return row.kind === "response" || row.kind === "tool" ? "success" : "info";
}

export interface AgentHubActivityRowViewProps {
	readonly activity: AgentActivityRow;
	readonly selected: boolean;
	readonly ref?: AgentRecordLike;
	readonly observed?: ObservableSession;
	readonly getRoleInfo?: (role: string) => AgentRoleDisplay | undefined;
	readonly onMouse?: (event: HostMouseEvent) => void;
}

/** One retained activity row with native clipping and status presentation. */
export function AgentHubActivityRowView(props: AgentHubActivityRowViewProps): JSX.Element {
	const role = props.ref ? roleFor(props.ref, props.observed) : undefined;
	const roleInfo = role ? props.getRoleInfo?.(role) : undefined;
	const title = sanitizeDisplaySingleLine(
		props.activity.kind === "tool" ? (props.activity.toolName ?? props.activity.title) : props.activity.title,
	);
	return (
		<box background={props.selected ? "selectedBg" : undefined} onMouse={props.onMouse}>
			<row gap={1}>
				<status value={activityStatus(props.activity)} />
				<timestamp at={props.activity.timestamp} mode="absolute" color="dim" />
				{role && roleInfo ? <AgentHubRoleBadge role={role} info={roleInfo} /> : null}
				<text bold shrink={1} minWidth={1} wrap="none" overflow="ellipsis">
					{sanitizeDisplaySingleLine(props.activity.agentId)}
				</text>
				<text
					color={props.activity.kind === "response" ? "success" : "muted"}
					shrink={2}
					minWidth={1}
					wrap="none"
					overflow="ellipsis"
				>
					{title}
				</text>
				<text color="dim" grow={1} minWidth={1} wrap="none" overflow="ellipsis">
					{sanitizeDisplaySingleLine(props.activity.summary)}
				</text>
			</row>
		</box>
	);
}

export interface AgentHubRosterSummaryViewProps {
	readonly viewMode: AgentHubViewMode;
	readonly statusCounts: Readonly<Record<AgentRecordLike["status"], number>>;
	readonly aggregate: AggregateMetrics;
	readonly rowCount: number;
}

/** Roster header and aggregate measurement line. */
export function AgentHubRosterSummaryView(props: AgentHubRosterSummaryViewProps): JSX.Element {
	const counts = (["running", "idle", "parked", "aborted"] as const).filter(status => props.statusCounts[status] > 0);
	const metrics = props.aggregate;
	return (
		<stack gap={0}>
			<row gap={1}>
				<text bold>Roster</text>
				<badge color={props.viewMode === "roster" ? "accent" : "muted"}>Flat</badge>
				<badge color={props.viewMode === "tree" ? "accent" : "muted"}>By parent</badge>
				<For each={counts}>
					{status => (
						<row gap={0}>
							<AgentHubStatusGlyph status={status} />
							<AgentHubStatusText status={status}>
								{" "}
								{props.statusCounts[status]} {status}
							</AgentHubStatusText>
						</row>
					)}
				</For>
			</row>
			<text color="dim" wrap="word">
				{metrics.reportedAgents > 0 ? (
					<>
						<span color="statusLineCost">{formatCost(metrics.cost)}</span>
						{theme.sep.dot}
						{formatMetricDuration(metrics) ? `${formatMetricDuration(metrics)} agent time` : "agent time —"}
						{theme.sep.dot}
						{formatNumber(metrics.requests)} req{theme.sep.dot}
						{formatNumber(metrics.tools)} tools{theme.sep.dot}
						{formatNumber(metrics.tokens)} tok{theme.sep.dot}
						{metrics.activeDurationAgents}/{metrics.reportedAgents} timed{theme.sep.dot}
						{metrics.reportedAgents}/{props.rowCount} measured
					</>
				) : (
					`Usage —${theme.sep.dot}0/${props.rowCount} measured`
				)}
			</text>
		</stack>
	);
}

export interface AgentHubRosterEntryViewProps<TRecord extends AgentRecordLike = AgentRecordLike> {
	readonly ref: TRecord;
	readonly observed?: ObservableSession;
	readonly metrics?: AgentMetrics;
	readonly selected: boolean;
	readonly hovered?: boolean;
	readonly viewMode: AgentHubViewMode;
	readonly tree?: AgentHubTreeLayout;
	readonly children?: readonly TRecord[];
	readonly unread?: number;
	readonly now?: number;
	readonly getRoleInfo?: (role: string) => AgentRoleDisplay | undefined;
	readonly onMouse?: (event: HostMouseEvent) => void;
}

/** One native roster entry; the parent tree owns ancestry guides. */
export function AgentHubRosterEntryView<TRecord extends AgentRecordLike>(
	props: AgentHubRosterEntryViewProps<TRecord>,
): JSX.Element {
	const role = roleFor(props.ref, props.observed);
	const roleInfo = role ? props.getRoleInfo?.(role) : undefined;
	const task = currentTask(props.ref, props.observed);
	const age = formatAge(Math.max(1, Math.round(((props.now ?? 0) - props.ref.lastActivity) / 1_000)));
	return (
		<box
			background={props.hovered ? "selectedBg" : props.selected ? "selectedBg" : undefined}
			onMouse={props.onMouse}
		>
			<stack gap={0}>
				<row gap={1}>
					<AgentHubStatusGlyph status={props.ref.status} />
					<text
						bold
						color={props.selected ? "accent" : undefined}
						shrink={1}
						minWidth={1}
						wrap="none"
						overflow="ellipsis"
					>
						{sanitizeDisplaySingleLine(props.ref.id)}
					</text>
					<Show when={props.viewMode === "roster" && props.ref.parentId && props.ref.parentId !== MAIN_AGENT_ID}>
						<text color="dim" shrink={2} minWidth={0} wrap="none" overflow="ellipsis">
							↳ {sanitizeDisplaySingleLine(props.ref.parentId ?? "")}
						</text>
					</Show>
					<Show when={props.ref.kind === "advisor"}>
						<badge color="warning">read-only</badge>
					</Show>
					<Show when={(props.unread ?? 0) > 0}>
						<badge color="warning">{props.unread} unread</badge>
					</Show>
					{role && roleInfo ? <AgentHubRoleBadge role={role} info={roleInfo} /> : null}
					<AgentHubModelBadge ref={props.ref} observed={props.observed} />
				</row>
				<Show when={task}>
					<rail prefix="  " rest="  " color="muted">
						<text color="muted" wrap="word">
							{sanitizeDisplaySingleLine(task ?? "")}
						</text>
					</rail>
				</Show>
				<Show when={props.metrics}>
					<AgentHubMetricColumns metrics={props.metrics!} age={age} />
				</Show>
				<Show when={!props.metrics}>
					<text color="dim">
						usage {theme.sep.dot} {age}
					</text>
				</Show>
			</stack>
		</box>
	);
}

/** Fixed usage cells delegated to the native table primitive. */
export function AgentHubMetricColumns(props: { readonly metrics: AgentMetrics; readonly age: string }): JSX.Element {
	const cells = [
		formatCost(props.metrics.cost),
		formatMetricDuration(props.metrics) ?? "—",
		`${formatNumber(props.metrics.requests)} req`,
		`${formatNumber(props.metrics.tools)} tools`,
		`${formatNumber(props.metrics.tokens)} tok`,
		props.age,
	];
	return (
		<table
			columns={[
				{ align: "left", grow: 1 },
				{ align: "right", grow: 1 },
				{ align: "right", grow: 1 },
				{ align: "right", grow: 1 },
				{ align: "right", grow: 1 },
				{ align: "right", grow: 1 },
			]}
			rows={[cells.map(text => ({ text, color: "dim" as const }))]}
			gap={1}
		/>
	);
}

export interface AgentHubInspectorViewProps<TRecord extends AgentRecordLike = AgentRecordLike> {
	readonly ref?: TRecord;
	readonly observed?: ObservableSession;
	readonly metrics?: AgentMetrics;
	readonly children?: readonly TRecord[];
	readonly activity: readonly AgentActivityRow[];
	readonly detailOffset?: number;
	readonly now?: number;
	readonly getRoleInfo?: (role: string) => AgentRoleDisplay | undefined;
}

/** Scrollable agent inspector retaining lifecycle, usage, lineage, and history metadata. */
export function AgentHubInspectorView<TRecord extends AgentRecordLike>(
	props: AgentHubInspectorViewProps<TRecord>,
): JSX.Element {
	if (!props.ref)
		return (
			<scroll grow={1} offset={0} followTail={false} shrinkToFit>
				<text color="dim">Select an agent to inspect</text>
			</scroll>
		);
	const ref = props.ref;
	const progress = props.observed?.progress;
	const role = roleFor(ref, props.observed);
	const roleInfo = role ? props.getRoleInfo?.(role) : undefined;
	const task = currentTask(ref, props.observed);
	const current = progress?.currentTool
		? `${progress.currentTool}${progress.currentToolArgs ? ` · ${progress.currentToolArgs}` : ""}`
		: (progress?.lastIntent ?? ref.activity);
	const metrics = props.metrics;
	const context =
		metrics?.contextTokens !== undefined && metrics.contextWindow
			? { tokens: metrics.contextTokens, window: metrics.contextWindow }
			: undefined;
	const age = formatAge(Math.max(1, Math.round(((props.now ?? 0) - ref.lastActivity) / 1_000)));
	const history = ref.history;
	return (
		<scroll grow={1} offset={Math.max(0, props.detailOffset ?? 0)} followTail={false}>
			<stack gap={0}>
				<row gap={1}>
					<AgentHubStatusGlyph status={ref.status} />
					<text bold>{sanitizeDisplaySingleLine(ref.displayName || ref.id)}</text>
				</row>
				<Show when={ref.displayName && ref.displayName !== ref.id}>
					<text color="dim">{sanitizeDisplaySingleLine(ref.id)}</text>
				</Show>
				<text>
					<AgentHubStatusText status={ref.status}>{ref.status}</AgentHubStatusText>
					<span color="dim">
						{theme.sep.dot}active {age}
					</span>
				</text>
				<Show when={role && roleInfo}>
					<AgentHubRoleBadge role={role!} info={roleInfo!} />
				</Show>
				<AgentHubModelBadge ref={ref} observed={props.observed} />
				<Show when={task}>
					<text color="accent" bold>
						Task
					</text>
					<text wrap="word">{sanitizeDisplaySingleLine(task ?? "")}</text>
				</Show>
				<Show when={current}>
					<text color="accent" bold>
						Current
					</text>
					<text wrap="word">{sanitizeDisplaySingleLine(current ?? "")}</text>
				</Show>
				<text color="accent" bold>
					Usage
				</text>
				<Show when={metrics} fallback={<text color="dim">usage —</text>}>
					<text color="dim" wrap="word">
						{formatMetrics(metrics!)}
					</text>
					{context ? <AgentHubContextGauge tokens={context.tokens} window={context.window} /> : null}
				</Show>
				<text color="accent" bold>
					Lineage
				</text>
				<text wrap="word">
					Spawned by {sanitizeDisplaySingleLine(ref.parentId ?? MAIN_AGENT_ID)}
					{(props.children?.length ?? 0) > 0 ? ` · ${props.children!.length} children` : ""}
				</text>
				<Show when={(props.children?.length ?? 0) > 0}>
					<preview
						items={(props.children ?? []).map(child => sanitizeDisplaySingleLine(child.id))}
						edge="head"
						limit={3}
						unit="items"
						color="dim"
					/>
				</Show>
				<text color="dim">Registered {formatLocalDateTimeWithOffset(new Date(ref.createdAt))}</text>
				<text color="accent" bold>
					Changes
				</text>
				<text color="dim" wrap="word">
					{ref.kind === "advisor" || history?.readOnly
						? "Read-only · 0 LoC"
						: "Shared workspace · per-agent LoC not attributable"}
				</text>
				<Show when={history?.outputPath}>
					<path value={history?.outputPath ?? ""} />
				</Show>
				<Show when={history?.patchPath}>
					<path value={history?.patchPath ?? ""} />
				</Show>
				<For each={history?.nestedPatchPaths ?? []}>{path => <path value={path} />}</For>
				<Show when={history?.branchName}>
					<text>Worktree branch {history?.branchName}</text>
				</Show>
				<text color="accent" bold>
					Recent activity
				</text>
				<Show
					when={props.activity.length > 0}
					fallback={<text color="muted">No response or tool activity yet</text>}
				>
					<For each={props.activity}>
						{activity => (
							<AgentHubActivityRowView
								activity={activity}
								selected={false}
								ref={ref}
								observed={props.observed}
								getRoleInfo={props.getRoleInfo}
							/>
						)}
					</For>
				</Show>
			</stack>
		</scroll>
	);
}
