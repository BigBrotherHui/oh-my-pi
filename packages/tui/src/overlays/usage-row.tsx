import type { Usage } from "@oh-my-pi/pi-ai";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import type { JSX } from "../reactive";
import { theme } from "../theme/theme";

const MIN_DURATION_MS = 100;

function formatUsageTimestamp(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number): string => String(value).padStart(2, "0");
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	return `${day} ${time}`;
}

export function turnElapsedMs(
	turnStartedAt: number | undefined,
	message: { completedAt?: number },
): number | undefined {
	if (turnStartedAt === undefined || message.completedAt === undefined) return undefined;
	const elapsed = message.completedAt - turnStartedAt;
	return elapsed > 0 ? Math.round(elapsed) : undefined;
}

function usageMetrics(
	usage: Usage,
	durationMs?: number,
	ttftMs?: number,
	timestamp?: number,
	turnElapsed?: number,
): readonly string[] {
	const metrics: string[] = [];
	if (timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0)
		metrics.push(formatUsageTimestamp(timestamp));
	if (turnElapsed !== undefined && turnElapsed > 0) metrics.push(`Δ ${formatDuration(Math.round(turnElapsed))}`);
	metrics.push(`${theme.icon.input} ${formatNumber(usage.input + usage.cacheWrite)}`);
	metrics.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
	if (usage.cacheRead > 0) metrics.push(`${theme.icon.cache} ${formatNumber(usage.cacheRead)}`);
	if (ttftMs && ttftMs > 0) metrics.push(`${theme.icon.time} ${(ttftMs / 1000).toFixed(1)}s`);
	if (durationMs && durationMs > MIN_DURATION_MS && usage.output > 0) {
		metrics.push(`${theme.icon.throughput} ${((usage.output / durationMs) * 1000).toFixed(1)}/s`);
	}
	return metrics;
}

/** Plain metric text shared with grouped read summaries. */
export function formatUsageRow(
	usage: Usage,
	durationMs?: number,
	ttftMs?: number,
	timestamp?: number,
	turnElapsed?: number,
): string {
	return usageMetrics(usage, durationMs, ttftMs, timestamp, turnElapsed).join("  ");
}

export interface UsageRowProps {
	readonly usage: Usage;
	readonly durationMs?: number;
	readonly ttftMs?: number;
	readonly timestamp?: number;
	readonly turnElapsed?: number;
}

/** Reactive transcript row for completed model usage. */
export function UsageRow(props: UsageRowProps): JSX.Element {
	return (
		<stack>
			<br />
			<box padding={{ left: 1, right: 1 }}>
				<text color="dim" wrap="word">
					{formatUsageRow(props.usage, props.durationMs, props.ttftMs, props.timestamp, props.turnElapsed)}
				</text>
			</box>
		</stack>
	);
}
