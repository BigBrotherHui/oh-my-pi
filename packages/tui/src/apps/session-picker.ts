import { logger } from "@oh-my-pi/pi-utils";
import {
	createSessionSelectorController,
	SessionSelectorView,
	type SessionSelectorEntry,
	type SessionHistoryMatcher,
} from "../overlays/session-selector";
import { Portal } from "../host/overlay";
import { runStandaloneTui } from "./standalone-picker";

/** Persistence and history capabilities supplied by the session-owning host. */
export interface SessionPickerHost<T extends SessionSelectorEntry = SessionSelectorEntry> {
	loadPinnedIds?(): Promise<ReadonlySet<string>>;
	loadHistoryMatcher?(): SessionHistoryMatcher;
	deleteSession?(session: T): Promise<boolean>;
	loadAllSessions?(): Promise<T[]>;
}

/** Presentation and capability controls for the standalone session picker. */
export interface SessionPickerOptions<T extends SessionSelectorEntry = SessionSelectorEntry> {
	allSessions?: T[];
	title?: string;
	scopeLabel?: string | false;
	showCwd?: boolean;
	allowDelete?: boolean;
	allowGlobalScope?: boolean;
	historySearch?: boolean;
	pinnedIds?: ReadonlySet<string>;
}

/**
 * Show the TUI session selector and return the selected session, or null if
 * cancelled. The default OMP picker supports deletion, transcript-history
 * search, and an all-projects scope; foreign import pickers disable those
 * source-owned capabilities.
 */
export async function selectSession<T extends SessionSelectorEntry>(
	sessions: T[],
	options: SessionPickerOptions<T> = {},
	host: SessionPickerHost<T> = {},
): Promise<T | null> {
	// Rank sessions with prompt-history matches too, recovering prompts the 4KB
	// session-list prefix never sees. Best-effort: a missing/locked history.db
	// must not break the picker.
	const pinnedIds = options.pinnedIds ?? (await host.loadPinnedIds?.());

	let historyMatcher: ((query: string) => string[]) | undefined;
	if (options.historySearch !== false) {
		try {
			historyMatcher = host.loadHistoryMatcher?.();
		} catch (error) {
			logger.warn("History storage unavailable for session ranking", { error: String(error) });
		}
	}

	return runStandaloneTui(({ finish }) => {
		const selector = createSessionSelectorController(
			sessions,
			(session: T) => finish(session),
			() => finish(null),
			() => process.exit(0),
			{
				onDelete: options.allowDelete === false ? undefined : host.deleteSession,
				historyMatcher,
				loadAllSessions: options.allowGlobalScope === false ? undefined : host.loadAllSessions,
				allSessions: options.allSessions,
				fillHeight: true,
				title: options.title,
				scopeLabel: options.scopeLabel,
				showCwd: options.showCwd,
				pinnedIds,
			},
		);
		return Portal({
			to: "overlay",
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
			mouseTracking: true,
			get children() {
				return SessionSelectorView({
					controller: selector,
					options: {
						fillHeight: true,
						title: options.title,
						scopeLabel: options.scopeLabel,
						showCwd: options.showCwd,
						pinnedIds,
					},
				});
			},
		});
	});
}
