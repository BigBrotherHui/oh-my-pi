import { Ellipsis } from "@oh-my-pi/pi-natives";
import { truncateToWidth, visibleWidth } from "../utils";
import type { Style } from "../core/style";

export interface MetricSpec {
	readonly value: string | undefined;
	readonly leading?: string;
	readonly separator?: string;
	readonly priority?: number;
	readonly style?: Style;
}

export type MetricOverflow = "allow" | "drop" | "truncate" | "wrap";

export interface MetricRowOptions {
	readonly separator?: string;
	readonly overflow?: MetricOverflow;
	readonly maxWidth?: number;
	readonly paddingX?: number;
	readonly paddingY?: number;
	readonly style?: Style;
}

/** Format one metric without imposing domain-specific value policy. */
export function formatMetric(metric: MetricSpec): string | undefined {
	if (metric.value === undefined) return undefined;
	const text =
		metric.leading !== undefined ? `${metric.leading}${metric.separator ?? " "}${metric.value}` : metric.value;
	return text;
}

/** Join metrics in declaration order with the requested overflow policy. */
export function formatMetricRow(metrics: readonly MetricSpec[], options: MetricRowOptions = {}): string {
	const separator = options.separator ?? " ";
	const entries = metrics.flatMap((metric, index) => {
		const text = formatMetric(metric);
		return text === undefined ? [] : [{ text, index, priority: metric.priority ?? 0 }];
	});
	if (entries.length === 0) return "";
	const maxWidth = options.maxWidth;
	const overflow = options.overflow ?? "allow";
	const join = (): string => entries.map(entry => entry.text).join(separator);
	if (maxWidth === undefined || overflow === "allow" || overflow === "wrap") return join();
	if (overflow === "truncate") return truncateToWidth(join(), Math.max(0, maxWidth), Ellipsis.Unicode);
	while (entries.length > 1 && visibleWidth(join()) > maxWidth) {
		let dropIndex = 0;
		for (let index = 1; index < entries.length; index++) {
			const candidate = entries[index]!;
			const current = entries[dropIndex]!;
			if (
				candidate.priority < current.priority ||
				(candidate.priority === current.priority && candidate.index > current.index)
			) {
				dropIndex = index;
			}
		}
		entries.splice(dropIndex, 1);
	}
	return join();
}
