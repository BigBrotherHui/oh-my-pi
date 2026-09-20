import type { UsageReport } from "@oh-my-pi/pi-ai";
import { UsageReportsView } from "@oh-my-pi/pi-coding-agent/modes/components/command-feedback-views";
import type { OAuthAccountIdentity } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { renderSnapshot } from "@oh-my-pi/pi-tui/snapshot";
import type { Theme } from "@oh-my-pi/pi-tui/theme";

/** Render the real retained quota report for cross-account output assertions. */
export function renderUsage(
	reports: UsageReport[],
	theme: Theme,
	now: number,
	columns: number,
	resolveActiveAccount?: (provider: string) => OAuthAccountIdentity | undefined,
	usageModelSelectors: readonly string[] = [],
): string {
	return renderSnapshot(() => UsageReportsView({ reports, now, resolveActiveAccount, usageModelSelectors }), {
		theme,
		columns,
	}).join("\n");
}
