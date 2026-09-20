import { sanitizeDisplayText } from "../../overlays/extensions/display-text";
import { Style } from "../../core/style";
import type { JSX } from "../../reactive";

export function DebugLogExpandedView({ line, style = Style.NONE }: { line: string; style?: Style }): JSX.Element {
	const normalized = sanitizeDisplayText(line);
	if (normalized.length === 0) return <text>{""}</text>;
	return (
		<stack>
			{normalized.split("\n").map((segment, index) => (
				<text key={index} wrap="word" style={style}>
					{segment}
				</text>
			))}
		</stack>
	);
}

export function parseDebugLogTimestampMs(line: string): number | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!parsed || typeof parsed !== "object" || !("timestamp" in parsed)) return undefined;
		const timestamp = parsed.timestamp;
		if (typeof timestamp !== "string") return undefined;
		const timestampMs = Date.parse(timestamp);
		return Number.isFinite(timestampMs) ? timestampMs : undefined;
	} catch {
		return undefined;
	}
}

export function parseDebugLogPid(line: string): number | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!parsed || typeof parsed !== "object" || !("pid" in parsed)) return undefined;
		const pid = parsed.pid;
		if (typeof pid !== "number") return undefined;
		return Number.isFinite(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}
