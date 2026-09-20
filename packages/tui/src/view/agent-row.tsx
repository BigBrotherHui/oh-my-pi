import { Show, type JSX } from "../reactive";
import type { ToolUIStatus } from "./status-icon";

/** Shared execution counters consumed by generic and tool-specific agent progress rows. */
export interface AgentStats {
	readonly toolCount?: number;
	readonly requests?: number;
	readonly contextTokens?: number;
	readonly contextWindow?: number;
	readonly cost?: number;
	readonly tokens?: number;
}

/** Props for one compact agent status row. */
export interface AgentRowProps {
	readonly status: ToolUIStatus;
	readonly id: string;
	readonly role: string;
	readonly model?: string;
	readonly detail?: string;
	readonly idMinWidth?: number;
	readonly durationMs?: number;
	readonly stats?: AgentStats;
}

/** Render stable status and id cells before shrinkable badges and detail. */
import { formatNumber } from "@oh-my-pi/pi-utils";
import { formatContextUsage } from "../chrome/context-thresholds";

function formatAgentStats(stats: AgentStats): string {
	const parts: string[] = [];
	if (stats.toolCount) parts.push(`${formatNumber(stats.toolCount)} 🛠`);
	if (stats.requests) parts.push(`${formatNumber(stats.requests)} req`);
	if (stats.contextTokens && stats.contextTokens > 0) {
		const ctxStr =
			stats.contextWindow && stats.contextWindow > 0
				? formatContextUsage((stats.contextTokens / stats.contextWindow) * 100, stats.contextWindow)
				: formatNumber(stats.contextTokens);
		parts.push(ctxStr);
	}
	if (stats.cost && stats.cost > 0) parts.push(`$${stats.cost.toFixed(2)}`);
	return parts.join(" · ");
}

/** Render stable status and id cells before shrinkable badges and detail. */
export function AgentRow(props: AgentRowProps): JSX.Element {
	return (
		<row gap={1}>
			<status value={props.status} shrink={0} />
			<text minWidth={props.idMinWidth ?? 10} shrink={1} wrap="none" overflow="ellipsis" color="accent">
				{props.id}
			</text>
			<Show when={props.role}>
				<text minWidth={0} shrink={2} wrap="none" overflow="ellipsis">
					<badge color="muted">{props.role}</badge>
				</text>
			</Show>
			<Show when={props.model}>
				<text minWidth={0} shrink={2} wrap="none" overflow="ellipsis">
					<badge color="dim">{props.model}</badge>
				</text>
			</Show>
			<Show when={props.detail}>
				<text grow={1} minWidth={1} shrink={3} wrap="none" overflow="ellipsis" color="muted">
					{props.detail}
				</text>
			</Show>
			<Show when={props.stats && formatAgentStats(props.stats)}>
				<text shrink={1} color="dim">
					{formatAgentStats(props.stats!)}
				</text>
			</Show>
			<Show when={props.durationMs !== undefined}>
				<duration ms={props.durationMs!} shrink={0} />
			</Show>
		</row>
	);
}
