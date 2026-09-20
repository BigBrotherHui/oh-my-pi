import { createMemo, Show, type Accessor, type JSX } from "../reactive";
import { formatContextUsage } from "../chrome/context-thresholds";
import {
	formatDuration,
	FEED_MODEL_BADGE_WIDTH,
	formatNumber,
	isFeedModelBadgeEnabled,
	thinkingLevelGlyph,
} from "../render/render-utils";
import type { Theme } from "../theme/theme";
import type { FeedModelThinkingLevel } from "../view/feed-model-badge";
import type { AgentStats } from "../view/agent-row";
import type { ToolUIStatus } from "../view/status-icon";
import { useTheme } from "../theme/reactive";

type AgentTreeStatus = ToolUIStatus | "completed" | "failed";

/** Tool-specific presentation layered onto a bounded agent progress row. */
export interface AgentTreeRowOptions {
	readonly status: AgentTreeStatus;
	readonly presentation: "task" | "eval";
	/** Preceding tree guide, when this row is not already nested in a `<tree>`. */
	readonly prefix?: string;
	/** Guide used by the wrapped description below this row. */
	readonly continuationPrefix?: string;
	readonly id: string;
	readonly model?: string;
	readonly thinkingLevel?: FeedModelThinkingLevel;
	readonly advisor?: boolean;
	/** Last rendered spinner frame, retained for rows committed to scrollback. */
	readonly spinnerFrame?: number;
	/** Live task rows committed to scrollback render their title as static dim text. */
	readonly frozen?: boolean;
	/** Agent type label, distinct from its unique execution id. */
	readonly role?: string;
	/** Explicit state label, such as “retrying” or “rate-limited”. */
	readonly statusBadge?: string;
	readonly statusBadgeColor?: "success" | "error" | "warning" | "accent" | "muted";
	readonly description?: string;
	/** Compact secondary activity text. */
	readonly detail?: string;
	readonly stats?: AgentStats;
	readonly durationMs?: number;
	/** Clip one semantic task row instead of allocating a wrapped continuation. */
	readonly overflow?: "clip";
}

type AgentLifecycleStatus = "pending" | "running" | "completed" | "failed" | "aborted";

function lifecycleStatus(status: AgentTreeStatus): AgentLifecycleStatus {
	if (status === "completed" || status === "success" || status === "done") return "completed";
	if (status === "failed" || status === "error" || status === "warning") return "failed";
	if (status === "aborted") return "aborted";
	if (status === "running") return "running";
	return "pending";
}

/** Semantic, inline stat run shared by task and eval agent rows. */
function AgentStatRun(props: { readonly stats: AgentStats; readonly theme: Theme }): JSX.Element {
	const separator = props.theme.symbol("sep.dot");
	return (
		<>
			<Show when={props.stats.toolCount}>
				{separator}
				<span color="dim">
					{formatNumber(props.stats.toolCount!)} {props.theme.symbol("icon.extensionTool")}
				</span>
			</Show>
			<Show when={props.stats.requests}>
				{separator}
				<span color="dim">{formatNumber(props.stats.requests!)} req</span>
			</Show>
			<Show when={props.stats.contextTokens !== undefined && props.stats.contextTokens > 0}>
				{separator}
				<span color="dim">
					{props.stats.contextWindow !== undefined && props.stats.contextWindow > 0
						? formatContextUsage(
								(props.stats.contextTokens! / props.stats.contextWindow) * 100,
								props.stats.contextWindow,
							)
						: formatNumber(props.stats.contextTokens!)}
				</span>
			</Show>
			<Show when={props.stats.cost !== undefined && props.stats.cost > 0}>
				{separator}
				<span color="statusLineCost">${props.stats.cost!.toFixed(2)}</span>
			</Show>
		</>
	);
}

/** Render the shared tool-count, request, context, and cost stat run. */
export function AgentStatView(props: {
	readonly stats: AgentStats;
	readonly theme?: Theme;
	readonly overflowPriority?: number;
}): JSX.Element {
	const themeAccess = useTheme();
	const theme = () => props.theme ?? themeAccess.theme();
	return (
		<text shrink={3} minWidth={0} overflowPriority={props.overflowPriority} wrap="none" overflow="clip">
			<AgentStatRun stats={props.stats} theme={theme()} />
		</text>
	);
}

/**
 * Retained agent-progress row matching the legacy task/eval tree grammar.
 *
 * A tree parent should supply guides for normal nesting. `prefix` remains for
 * the eval progress surface, whose cell box owns its guide columns directly.
 */
export function AgentTreeRowView(props: AgentTreeRowOptions): JSX.Element {
	const theme = useTheme().theme;
	const status = createMemo(() => lifecycleStatus(props.status));
	const task = props.presentation === "task";
	const live = createMemo(() => status() === "pending" || status() === "running");
	const failed = createMemo(() => status() === "failed" || status() === "aborted");
	const displayStatus = createMemo<ToolUIStatus>(() => {
		switch (status()) {
			case "completed":
				return "done";
			case "failed":
				return "error";
			case "aborted":
				return "aborted";
			case "running":
				return "running";
			case "pending":
				return "pending";
		}
	});
	const nameColor = createMemo(() =>
		task && live() && props.frozen ? "dim" : task && status() === "completed" ? "text" : "accent",
	);
	const role = () => props.role;
	const badgeLabel = createMemo(() => {
		if (props.statusBadge) return props.statusBadge;
		if (status() === "failed") return "failed";
		if (status() === "aborted") return "aborted";
		return undefined;
	});
	const badgeColor = createMemo(() => {
		if (props.statusBadgeColor) return props.statusBadgeColor;
		return status() === "aborted" ? "error" : status() === "failed" ? "error" : "muted";
	});
	const model = createMemo(() => {
		if (!isFeedModelBadgeEnabled() || !props.model) return undefined;
		const thinking = props.thinkingLevel === undefined ? "" : `${thinkingLevelGlyph(props.thinkingLevel, theme())} `;
		return `${thinking}${props.model}${props.advisor ? ` ${theme().symbol("icon.advisor")}` : ""}`;
	});
	const preview = () => props.detail;
	const statsVisible = () =>
		Boolean(
			props.stats &&
			(props.stats.toolCount ||
				props.stats.requests ||
				(props.stats.contextTokens !== undefined && props.stats.contextTokens > 0) ||
				(props.stats.cost !== undefined && props.stats.cost > 0)),
		);

	const fragments = () => (
		<>
			<Show
				when={task && !failed()}
				fallback={
					<Show
						when={!task && status() === "completed"}
						fallback={
							<status
								value={displayStatus()}
								frame={props.frozen ? props.spinnerFrame : undefined}
								shrink={0}
								minWidth={1}
								overflowPriority={100}
							/>
						}
					>
						<icon name="tool.eval" color="accent" shrink={0} minWidth={1} overflowPriority={100} />
					</Show>
				}
			>
				<status value="done" color={nameColor()} shrink={0} minWidth={1} overflowPriority={100} />
			</Show>
			<text shrink={0}> </text>
			<Show when={model()}>
				{(label: Accessor<string>) => (
					<text
						shrink={3}
						minWidth={0}
						maxWidth={FEED_MODEL_BADGE_WIDTH}
						overflowPriority={0}
						wrap="none"
						overflow="ellipsis"
					>
						<span color="accent">{label()}</span>{" "}
					</text>
				)}
			</Show>
			<text shrink={1} minWidth={1} overflowPriority={100} wrap="none" overflow="ellipsis" color={nameColor()}>
				<Show when={!task} fallback={props.id}>
					{props.id}
				</Show>
			</text>
			<Show when={props.description}>
				<text grow={1} shrink={3} minWidth={1} wrap="word" color={nameColor()}>
					{": "}
					{props.description}
				</text>
			</Show>
			<Show when={role()}>
				{(label: Accessor<string>) => (
					<text shrink={2} minWidth={0} overflowPriority={0} wrap="none" overflow="ellipsis">
						{" "}
						<badge color="muted">{label()}</badge>
					</text>
				)}
			</Show>
			<Show when={badgeLabel()}>
				{(label: Accessor<string>) => (
					<>
						<text shrink={0} minWidth={1} overflowPriority={100}>
							{" "}
						</text>
						<badge color={badgeColor()}>{label()}</badge>
					</>
				)}
			</Show>
			<Show when={preview()}>
				{(value: Accessor<string>) => (
					<text shrink={4} minWidth={0} overflowPriority={0} wrap="none" overflow="ellipsis" color="muted">
						{" "}
						{value()}
					</text>
				)}
			</Show>
			<Show when={statsVisible()}>
				<AgentStatView stats={props.stats!} theme={theme()} overflowPriority={0} />
			</Show>
			<Show when={props.durationMs !== undefined && props.durationMs > 0}>
				<text shrink={0} minWidth={0} overflowPriority={0}>
					{theme().symbol("sep.dot")}
				</text>
				<text shrink={0} minWidth={0} overflowPriority={0} color="dim">
					{formatDuration(props.durationMs!)}
				</text>
			</Show>
		</>
	);
	const content =
		task && props.overflow === "clip" ? (
			<text wrap="none" overflow="clip">
				{fragments()}
			</text>
		) : (
			<row gap={0} wrap="continuation" continuationIndent={0}>
				{fragments()}
			</row>
		);
	return props.prefix ? (
		<rail
			prefix={<span color="dim">{`${props.prefix} `}</span>}
			rest={<span color="dim">{props.continuationPrefix ?? "  "}</span>}
		>
			{content}
		</rail>
	) : (
		content
	);
}
