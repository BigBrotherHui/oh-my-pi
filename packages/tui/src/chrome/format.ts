import { paintShimmerText } from "../theme/shimmer";
import { theme as currentTheme, type Theme } from "../theme/theme";
import { emitRows } from "../core/emit";
import { RichText } from "../core/richtext";
import { DEFAULT_COLOR, Style } from "../core/style";

/** Title-case a provider id for display (`openai-codex` → `Openai Codex`). */
export function formatProviderName(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

/** Format a millisecond duration as a coarse-grained human label. */
export function formatCoarseDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

type ProgressBarTheme = Pick<Theme, "fgColor">;

const unstyledProgressBarTheme: ProgressBarTheme = {
	fgColor() {
		return DEFAULT_COLOR;
	},
};

/** Compatibility wrapper retained for coding-agent's plain-text reports. */
export function renderAsciiBar(fraction: number | undefined, width = 24, uiTheme?: ProgressBarTheme): string {
	const progressBarTheme = uiTheme ?? currentTheme ?? unstyledProgressBarTheme;
	const bounded = Math.max(0, Math.trunc(width));
	const clamped = fraction === undefined ? undefined : Math.max(0, Math.min(1, fraction));
	const filled = clamped === undefined ? 0 : Math.round(clamped * bounded);
	const bar = clamped === undefined ? "·".repeat(bounded) : `${"█".repeat(filled)}${"░".repeat(bounded - filled)}`;
	const rich = new RichText();
	rich.push(Style.NONE, "[");
	paintShimmerText(rich, bar, progressBarTheme);
	rich.push(Style.NONE, clamped === undefined ? "]" : `] ${Math.round(clamped * 100)}%`);
	rich.br();
	return (
		emitRows(rich, {
			mode: typeof currentTheme === "undefined" ? "truecolor" : currentTheme.getColorMode(),
		})[0] ?? ""
	);
}
