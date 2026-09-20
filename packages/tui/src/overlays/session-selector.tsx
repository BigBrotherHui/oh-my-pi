import { formatBytes } from "@oh-my-pi/pi-utils";
import { FuzzyText } from "../fuzzy";
import { extractPrintableText, matchesKey } from "../keys";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { Portal, bindOverlayController, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	useClock,
	useViewport,
	type Accessor,
	type JSX,
} from "../reactive";
import { shortenPath } from "../render/render-utils";
import { useTheme } from "../theme/reactive";
import type { SizeValue, TUI } from "../tui";

export type SessionSelectorStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";

const kSearchTextLower: unique symbol = Symbol("session.searchTextLower");

export interface SessionSelectorEntry {
	path: string;
	id: string;
	cwd: string;
	title?: string;
	modified: Date;
	size: number;
	firstMessage: string;
	allMessagesText: string;
	status?: SessionSelectorStatus;
	parentSessionPath?: string;
	[kSearchTextLower]?: string;
}

export type SessionHistoryMatcher = (query: string) => string[];
const HISTORY_MERGE_DEBOUNCE_MS = 150;
const HISTORY_MERGE_MIN_QUERY = 2;
const FUZZY_SCAN_INLINE_COUNT = 100;
const FUZZY_SCAN_CHUNK_COUNT = 150;
const MIN_PURE_FUZZY_TOKEN_SCORE = -20;

function sessionTextLower(session: SessionSelectorEntry): string {
	const cached = session[kSearchTextLower];
	if (cached !== undefined) return cached;
	const text = [session.id, session.title, session.cwd, session.firstMessage, session.allMessagesText, session.path]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	session[kSearchTextLower] = text;
	return text;
}

function tokenize(query: string): string[] {
	const normalized = query.trim().toLowerCase();
	return normalized ? normalized.split(/\s+/) : [];
}

function isLiteralMatch(text: string, tokens: readonly string[]): boolean {
	return tokens.every(token => text.includes(token));
}

interface RankedSessionMatch<T extends SessionSelectorEntry> {
	readonly session: T;
	readonly index: number;
	readonly score: number;
}

function scoreFuzzySession<T extends SessionSelectorEntry>(
	session: T,
	index: number,
	tokens: readonly string[],
): RankedSessionMatch<T> | undefined {
	const matcher = new FuzzyText(sessionTextLower(session));
	let score = 0;
	let weakest = Number.NEGATIVE_INFINITY;
	for (const token of tokens) {
		const match = matcher.match(token);
		if (!match.matches) return undefined;
		score += match.score;
		weakest = Math.max(weakest, match.score);
	}
	return weakest < MIN_PURE_FUZZY_TOKEN_SCORE ? { session, index, score } : undefined;
}

function compareRecency(left: SessionSelectorEntry, right: SessionSelectorEntry): number {
	return right.modified.getTime() - left.modified.getTime();
}

function compareLiteral<T extends SessionSelectorEntry>(
	left: RankedSessionMatch<T>,
	right: RankedSessionMatch<T>,
): number {
	return compareRecency(left.session, right.session) || left.index - right.index;
}

function compareFuzzy<T extends SessionSelectorEntry>(
	left: RankedSessionMatch<T>,
	right: RankedSessionMatch<T>,
): number {
	return left.score - right.score || compareRecency(left.session, right.session) || left.index - right.index;
}

function prioritizeTitleMatches<T extends SessionSelectorEntry>(
	sessions: readonly T[],
	tokens: readonly string[],
	literal: readonly RankedSessionMatch<T>[],
): T[] {
	const query = tokens.join(" ");
	const exact: T[] = [];
	const partial: T[] = [];
	const matched = new Set<T>();
	for (const { session } of literal) {
		const title = session.title?.trim().toLowerCase().replace(/\s+/g, " ");
		if (title === query) exact.push(session);
		else if (title && isLiteralMatch(title, tokens)) partial.push(session);
		else continue;
		matched.add(session);
	}
	return matched.size === 0
		? [...sessions]
		: [...exact, ...partial, ...sessions.filter(session => !matched.has(session))];
}

/**
 * Filter and rank session-picker search results. Literal matches keep the
 * canonical recency order; substantive fuzzy matches follow by score.
 */
export function rankSessionSearchMatches<T extends SessionSelectorEntry>(sessions: T[], query: string): T[] {
	const tokens = tokenize(query);
	if (tokens.length === 0) return sessions;
	const literal: RankedSessionMatch<T>[] = [];
	const fuzzy: RankedSessionMatch<T>[] = [];
	for (let index = 0; index < sessions.length; index++) {
		const session = sessions[index]!;
		if (isLiteralMatch(sessionTextLower(session), tokens)) literal.push({ session, index, score: 0 });
		else {
			const match = scoreFuzzySession(session, index, tokens);
			if (match) fuzzy.push(match);
		}
	}
	literal.sort(compareLiteral);
	fuzzy.sort(compareFuzzy);
	return prioritizeTitleMatches(
		[...literal.map(match => match.session), ...fuzzy.map(match => match.session)],
		tokens,
		literal,
	);
}

/**
 * Combine transcript-history matches with metadata matches without dropping
 * either result set. Title matches are promoted separately by the controller.
 */
export function mergeSessionRanking<T extends SessionSelectorEntry>(
	allSessions: T[],
	fuzzy: T[],
	historyIds: string[],
): T[] {
	if (historyIds.length === 0) return fuzzy;
	const byId = new Map<string, T>();
	for (const session of allSessions) {
		if (!byId.has(session.id)) byId.set(session.id, session);
	}
	const seen = new Set<string>();
	const history: T[] = [];
	for (const id of historyIds) {
		const session = byId.get(id);
		if (!session || seen.has(session.path)) continue;
		seen.add(session.path);
		history.push(session);
	}
	return history.length === 0 ? fuzzy : [...history, ...fuzzy.filter(session => !seen.has(session.path))];
}

export interface SessionSelectorOptions<T extends SessionSelectorEntry = SessionSelectorEntry> {
	onDelete?: (session: T) => Promise<boolean>;
	historyMatcher?: SessionHistoryMatcher;
	loadAllSessions?: () => Promise<T[]>;
	allSessions?: T[];
	title?: string;
	scopeLabel?: string | false;
	showCwd?: boolean;
	getTerminalRows?: () => number;
	fillHeight?: boolean;
	pinnedIds?: ReadonlySet<string>;
	currentSessionPath?: string | (() => string | undefined);
	width?: SizeValue;
}

export interface SessionSelectorController<T extends SessionSelectorEntry> {
	readonly query: Accessor<string>;
	readonly selectedIndex: Accessor<number>;
	readonly scope: Accessor<"folder" | "all">;
	readonly sessions: Accessor<readonly T[]>;
	readonly confirming: Accessor<T | undefined>;
	readonly confirmIndex: Accessor<number>;
	readonly error: Accessor<string | undefined>;
	readonly loading: Accessor<boolean>;
	handleInput(data: string): void;
	setQuery(query: string): void;
	setViewportRows(rows: number): void;
	select(): void;
	cancel(): void;
	lockInput(): void;
	unlockInput(): void;
	selectAt(index: number): void;
	handleWheel(delta: -1 | 1): void;
	dispose(): void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Restored retained state machine for the multi-line resume picker. */
export function createSessionSelectorController<T extends SessionSelectorEntry>(
	initial: T[],
	onSelect: (session: T) => void,
	onCancel: () => void,
	onExit: () => void,
	options: SessionSelectorOptions<T> = {},
): SessionSelectorController<T> {
	const [folderSessions, setFolderSessions] = createSignal(initial);
	const [allSessions, setAllSessions] = createSignal<T[] | undefined>(options.allSessions);
	const [scope, setScope] = createSignal<"folder" | "all">("folder");
	const [query, setQuery] = createSignal("");
	const [selectedIndex, setSelectedIndex] = createSignal(0);
	const [sessions, setSessions] = createSignal<readonly T[]>(initial);
	const [confirming, setConfirming] = createSignal<T>();
	const [confirmIndex, setConfirmIndex] = createSignal(0);
	const [error, setError] = createSignal<string>();
	const [loading, setLoading] = createSignal(false);
	let disposed = false;
	let inputLocked = false;
	let scanGeneration = 0;
	let scanTimer: NodeJS.Timeout | undefined;
	let historyTimer: NodeJS.Timeout | undefined;
	let literalRanked: RankedSessionMatch<T>[] = [];
	let fuzzyRanked: RankedSessionMatch<T>[] = [];
	let historyIds: string[] = [];
	let selectionMoved = false;
	let hadFilterQuery = false;
	let lastFilterQuery = "";
	let viewportRows = options.getTerminalRows?.() ?? 24;

	const source = (): T[] => (scope() === "all" ? (allSessions() ?? []) : folderSessions());
	const currentPath = (): string | undefined =>
		typeof options.currentSessionPath === "function" ? options.currentSessionPath() : options.currentSessionPath;
	const clampSelection = (count: number): void => {
		setSelectedIndex(index => Math.max(0, Math.min(index, Math.max(0, count - 1))));
	};
	const selectCurrentSession = (): void => {
		const path = currentPath();
		if (!path) return;
		const index = sessions().findIndex(session => session.path === path);
		if (index >= 0) setSelectedIndex(index);
	};
	const clearTimers = (): void => {
		if (scanTimer !== undefined) {
			clearTimeout(scanTimer);
			scanTimer = undefined;
		}
		if (historyTimer !== undefined) {
			clearTimeout(historyTimer);
			historyTimer = undefined;
		}
	};
	const replaceSessions = (next: readonly T[], resetSelection: boolean): void => {
		const index = selectedIndex();
		setSessions(next);
		if (resetSelection) setSelectedIndex(0);
		else setSelectedIndex(Math.max(0, Math.min(index, Math.max(0, next.length - 1))));
	};
	const composeFiltered = (resetSelection: boolean): void => {
		fuzzyRanked.sort(compareFuzzy);
		const ranked = [...literalRanked.map(match => match.session), ...fuzzyRanked.map(match => match.session)];
		const merged = historyIds.length > 0 ? mergeSessionRanking(source(), ranked, historyIds) : ranked;
		replaceSessions(prioritizeTitleMatches(merged, tokenize(query()), literalRanked), resetSelection);
	};
	const scanFuzzySlice = (
		generation: number,
		tokens: readonly string[],
		indexes: readonly number[],
		start: number,
		budget: number,
	): void => {
		const all = source();
		const end = Math.min(indexes.length, start + budget);
		for (let offset = start; offset < end; offset++) {
			const index = indexes[offset]!;
			const session = all[index];
			if (!session) continue;
			const match = scoreFuzzySession(session, index, tokens);
			if (match) fuzzyRanked.push(match);
		}
		if (end >= indexes.length) return;
		scanTimer = setTimeout(() => {
			scanTimer = undefined;
			if (disposed || generation !== scanGeneration) return;
			const before = fuzzyRanked.length;
			scanFuzzySlice(generation, tokens, indexes, end, FUZZY_SCAN_CHUNK_COUNT);
			if (fuzzyRanked.length > before) composeFiltered(false);
		}, 0);
	};
	const scheduleHistoryMerge = (filter: string): void => {
		if (historyTimer !== undefined) {
			clearTimeout(historyTimer);
			historyTimer = undefined;
		}
		const trimmed = filter.trim();
		if (!options.historyMatcher || trimmed.length < HISTORY_MERGE_MIN_QUERY) return;
		historyTimer = setTimeout(() => {
			historyTimer = undefined;
			if (disposed || selectionMoved || query() !== filter) return;
			const ids = options.historyMatcher?.(trimmed) ?? [];
			if (ids.length === 0) return;
			historyIds = ids;
			composeFiltered(false);
		}, HISTORY_MERGE_DEBOUNCE_MS);
	};
	const applyFilter = (focusCurrent = false): void => {
		scanGeneration++;
		clearTimers();
		selectionMoved = false;
		historyIds = [];
		literalRanked = [];
		fuzzyRanked = [];
		const filter = query();
		const tokens = tokenize(filter);
		const hadQuery = hadFilterQuery;
		const queryChanged = filter !== lastFilterQuery;
		hadFilterQuery = tokens.length > 0;
		lastFilterQuery = filter;
		if (tokens.length === 0) {
			replaceSessions(source(), false);
			if (hadQuery || focusCurrent) selectCurrentSession();
			else clampSelection(sessions().length);
			return;
		}
		const literal: RankedSessionMatch<T>[] = [];
		const remainder: number[] = [];
		const all = source();
		for (let index = 0; index < all.length; index++) {
			const session = all[index]!;
			if (isLiteralMatch(sessionTextLower(session), tokens)) literal.push({ session, index, score: 0 });
			else remainder.push(index);
		}
		literal.sort(compareLiteral);
		literalRanked = literal;
		scanFuzzySlice(scanGeneration, tokens, remainder, 0, FUZZY_SCAN_INLINE_COUNT);
		composeFiltered(queryChanged);
		scheduleHistoryMerge(filter);
	};
	const move = (delta: number): void => {
		const count = sessions().length;
		if (count === 0) return;
		selectionMoved = true;
		setSelectedIndex(index => Math.max(0, Math.min(count - 1, index + delta)));
	};
	const removeSession = (path: string): void => {
		setFolderSessions(current => current.filter(session => session.path !== path));
		setAllSessions(current => current?.filter(session => session.path !== path));
		applyFilter();
	};
	const choose = (): void => {
		if (disposed || inputLocked) return;
		const session = sessions()[selectedIndex()];
		if (!session) return;
		clearTimers();
		onSelect(session);
	};
	const dismiss = (): void => {
		if (disposed) return;
		disposed = true;
		clearTimers();
		onCancel();
	};
	const exit = (): void => {
		if (disposed) return;
		disposed = true;
		clearTimers();
		onExit();
	};
	const requestDelete = (): void => {
		const session = sessions()[selectedIndex()];
		if (!session || !options.onDelete) return;
		setConfirmIndex(0);
		setConfirming(() => session);
	};
	const confirmDelete = async (): Promise<void> => {
		const session = confirming();
		if (!session || !options.onDelete || disposed || loading()) return;
		setError(undefined);
		setLoading(true);
		try {
			if (await options.onDelete(session)) removeSession(session.path);
		} catch (cause) {
			if (!disposed) setError(`Error: ${errorMessage(cause).replace(/\t/g, " ")}`);
		} finally {
			if (!disposed) {
				setLoading(false);
				setConfirming(undefined);
			}
		}
	};
	const toggleScope = async (): Promise<void> => {
		if (disposed || loading() || confirming()) return;
		if (scope() === "all") {
			setScope("folder");
			setSelectedIndex(0);
			applyFilter(true);
			return;
		}
		let global = allSessions();
		if (!global) {
			if (!options.loadAllSessions) return;
			setError(undefined);
			setLoading(true);
			try {
				global = await options.loadAllSessions();
				if (disposed) return;
				setAllSessions(global);
			} catch (cause) {
				if (!disposed) setError(`Error: ${errorMessage(cause).replace(/\t/g, " ")}`);
				return;
			} finally {
				if (!disposed) setLoading(false);
			}
		}
		if (!global || disposed) return;
		setScope("all");
		setSelectedIndex(0);
		applyFilter(true);
	};

	const updateQuery = (value: string): void => {
		setQuery(value);
		applyFilter();
	};

	applyFilter(true);

	return {
		query,
		selectedIndex,
		scope,
		sessions,
		confirming,
		confirmIndex,
		error,
		loading,
		handleInput(data): void {
			if (disposed || inputLocked) return;
			if (confirming()) {
				if (matchesAppInterrupt(data)) {
					setConfirming(undefined);
					return;
				}
				if (matchesSelectUp(data)) {
					setConfirmIndex(index => Math.max(0, index - 1));
					return;
				}
				if (matchesSelectDown(data)) {
					setConfirmIndex(index => Math.min(1, index + 1));
					return;
				}
				if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
					if (confirmIndex() === 0) void confirmDelete();
					else setConfirming(undefined);
				}
				return;
			}
			if (matchesAppInterrupt(data)) {
				dismiss();
				return;
			}
			if (matchesKey(data, "ctrl+c")) {
				exit();
				return;
			}
			if (matchesKey(data, "tab")) {
				void toggleScope();
				return;
			}
			if (matchesKey(data, "delete")) {
				requestDelete();
				return;
			}
			if (matchesKey(data, "backspace")) {
				if (query().length === 0) requestDelete();
				else {
					setQuery(value => Array.from(value).slice(0, -1).join(""));
					applyFilter();
				}
				return;
			}
			if (matchesSelectUp(data)) {
				move(-1);
				return;
			}
			if (matchesSelectDown(data)) {
				move(1);
				return;
			}
			if (matchesSelectPageUp(data)) {
				move(-Math.max(2, Math.floor(Math.max(8, viewportRows - 8) / 4)));
				return;
			}
			if (matchesSelectPageDown(data)) {
				move(Math.max(2, Math.floor(Math.max(8, viewportRows - 8) / 4)));
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				choose();
				return;
			}
			const text = extractPrintableText(data);
			if (text) updateQuery(query() + text);
		},
		setQuery: updateQuery,
		setViewportRows(rows): void {
			viewportRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : viewportRows;
		},
		select: choose,
		cancel: dismiss,
		lockInput(): void {
			inputLocked = true;
		},
		unlockInput(): void {
			inputLocked = false;
		},
		selectAt(index): void {
			if (index < 0 || index >= sessions().length) return;
			setSelectedIndex(index);
			choose();
		},
		handleWheel(delta): void {
			if (confirming()) return;
			move(delta);
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			clearTimers();
		},
	};
}

function listHeight<T extends SessionSelectorEntry>(
	options: SessionSelectorOptions<T>,
	terminalRows: number = options.getTerminalRows?.() ?? 24,
): number {
	return Math.max(8, terminalRows - 8);
}

function relativeDate(date: Date, nowMs: number): string {
	const difference = nowMs - date.getTime();
	const minutes = Math.floor(difference / 60_000);
	const hours = Math.floor(difference / 3_600_000);
	const days = Math.floor(difference / 86_400_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	if (days === 1) return "1 day ago";
	if (days < 7) return `${days} days ago`;
	return date.toLocaleDateString();
}

function statusView(status: SessionSelectorStatus | undefined): JSX.Element | undefined {
	const palette = useTheme();
	switch (status) {
		case "complete":
			return <span color="success">{palette.theme().status.success} done</span>;
		case "interrupted":
			return <span color="warning">{palette.theme().status.warning} interrupted</span>;
		case "aborted":
			return <span color="muted">{palette.theme().status.aborted} aborted</span>;
		case "error":
			return <span color="error">{palette.theme().status.error} error</span>;
		case "pending":
			return <span color="accent">{palette.theme().status.pending} pending</span>;
		default:
			return undefined;
	}
}

function currentSessionPath<T extends SessionSelectorEntry>(
	options: SessionSelectorOptions<T> | undefined,
): string | undefined {
	return typeof options?.currentSessionPath === "function"
		? options.currentSessionPath()
		: options?.currentSessionPath;
}

interface SessionEntryViewProps<T extends SessionSelectorEntry> {
	readonly session: T;
	readonly index: number;
	readonly selected: boolean;
	readonly showCwd: boolean;
	readonly pinned: boolean;
	readonly current: boolean;
	readonly now: number;
	readonly controller: SessionSelectorController<T>;
	readonly separator: boolean;
}

function SessionEntryView<T extends SessionSelectorEntry>(props: SessionEntryViewProps<T>): JSX.Element {
	const palette = useTheme();
	const message = props.session.firstMessage.replace(/\n/g, " ").trim();
	const title = props.session.title;
	const status = statusView(props.session.status);
	const click = (event: HostMouseEvent): void => {
		if (event.action !== "down" || event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		props.controller.selectAt(props.index);
	};
	return (
		<box onMouse={click}>
			<stack>
				<row>
					<box shrink={0}>
						<text color={props.selected ? "accent" : undefined} wrap="clip">
							{props.selected ? `${palette.theme().nav.cursor} ` : "  "}
						</text>
					</box>
					{props.pinned ? (
						<box shrink={0}>
							<text color="accent" wrap="clip">
								{palette.theme().icon.pin}
							</text>
						</box>
					) : null}
					<box grow={1} minWidth={0}>
						<text bold={props.selected} wrap="clip">
							{title || message}
						</text>
					</box>
				</row>
				{title ? (
					<text color="dim" wrap="clip">
						{"  "}
						{message}
					</text>
				) : null}
				<text wrap="clip">
					{"  "}
					<span color="dim">{relativeDate(props.session.modified, props.now)}</span>{" "}
					<span color="dim">{palette.theme().sep.dot}</span>{" "}
					<span color="dim">{formatBytes(props.session.size)}</span>
					{props.current ? (
						<>
							{" "}
							<span color="dim">{palette.theme().sep.dot}</span> <span color="accent">current</span>
						</>
					) : null}
					{status ? (
						<>
							{" "}
							<span color="dim">{palette.theme().sep.dot}</span> {status}
						</>
					) : null}
					{props.session.parentSessionPath ? (
						<>
							{" "}
							<span color="dim">{palette.theme().sep.dot}</span>{" "}
							<span color="dim">{palette.theme().icon.branch} fork</span>
						</>
					) : null}
					{props.showCwd && props.session.cwd ? (
						<>
							{" "}
							<span color="dim">{palette.theme().sep.dot}</span>{" "}
							<span color="dim">{shortenPath(props.session.cwd)}</span>
						</>
					) : null}
				</text>
				{props.separator ? <br /> : null}
			</stack>
		</box>
	);
}

interface DeleteConfirmationViewProps<T extends SessionSelectorEntry> {
	readonly session: T;
	readonly controller: SessionSelectorController<T>;
}

function DeleteConfirmationView<T extends SessionSelectorEntry>(props: DeleteConfirmationViewProps<T>): JSX.Element {
	const palette = useTheme();
	const displayName = props.session.title || props.session.firstMessage.slice(0, 40) || props.session.id;
	return (
		<frame title="Delete session?" paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<stack>
				<br />
				<text color="accent" wrap="word">
					{displayName}
				</text>
				<br />
				<text color={props.controller.confirmIndex() === 0 ? "accent" : undefined}>
					{props.controller.confirmIndex() === 0 ? `${palette.theme().nav.cursor} Yes` : "  Yes"}
				</text>
				<text color={props.controller.confirmIndex() === 1 ? "accent" : undefined}>
					{props.controller.confirmIndex() === 1 ? `${palette.theme().nav.cursor} No` : "  No"}
				</text>
				<br />
				<text color="dim" wrap="clip">
					up/down navigate · enter select · esc cancel
				</text>
				<br />
			</stack>
		</frame>
	);
}

export interface SessionSelectorViewProps<T extends SessionSelectorEntry> {
	readonly controller: SessionSelectorController<T>;
	readonly options?: SessionSelectorOptions<T>;
}

/** Restored multi-line, viewport-bounded session chooser. */
export function SessionSelectorView<T extends SessionSelectorEntry>(props: SessionSelectorViewProps<T>): JSX.Element {
	const now = useClock("second");
	const viewport = useViewport();
	createEffect(() => props.controller.setViewportRows(viewport().rows));
	onCleanup(() => props.controller.dispose());
	const title = (): string => {
		if (props.options?.scopeLabel === false) return props.options.title ?? "Resume Session";
		const scopeLabel =
			props.options?.scopeLabel ?? (props.controller.scope() === "all" ? "all projects" : "current folder");
		return `${props.options?.title ?? "Resume Session"} (${scopeLabel})`;
	};
	const showCwd = (): boolean => props.options?.showCwd === true || props.controller.scope() === "all";
	const rows = createMemo(() => listHeight(props.options ?? {}, viewport().rows));
	const visible = createMemo(() => props.controller.sessions());
	const window = createMemo(() => {
		const items = visible();
		const budget = rows();
		if (items.length === 0) return { start: 0, end: 0, offset: 0, totalRows: 1 };
		const selected = Math.max(0, Math.min(props.controller.selectedIndex(), items.length - 1));
		const rowCounts = items.map(session => (session.title ? 4 : 3));
		const selectedRows = rowCounts[selected]!;
		const beforeTarget = Math.floor(Math.max(0, budget - Math.min(selectedRows, budget)) / 2);
		let start = selected;
		let before = 0;
		while (start > 0 && before + rowCounts[start - 1]! <= beforeTarget) {
			start--;
			before += rowCounts[start]!;
		}
		let end = selected + 1;
		let used = before + selectedRows;
		while (end < rowCounts.length && used + rowCounts[end]! <= budget) {
			used += rowCounts[end]!;
			end++;
		}
		while (start > 0 && used + rowCounts[start - 1]! <= budget) {
			start--;
			used += rowCounts[start]!;
		}
		let offset = 0;
		for (let index = 0; index < start; index++) offset += rowCounts[index]!;
		return { start, end, offset, totalRows: Math.max(0, rowCounts.reduce((sum, count) => sum + count, 0) - 1) };
	});
	const windowed = createMemo(() => visible().slice(window().start, window().end));
	const message = createMemo(() => (props.controller.loading() ? "Loading all projects…" : props.controller.error()));
	const viewportHeight = (): number =>
		Math.max(0, rows() - (props.controller.error() ? 2 : props.controller.loading() ? 1 : 0));
	const handleKey = (event: HostKeyEvent): void => {
		if (event.defaultPrevented) return;
		props.controller.handleInput(event.data);
		event.preventDefault();
		event.stopPropagation();
	};
	const handleInputKey = (event: HostKeyEvent): void => {
		const data = event.data;
		if (
			matchesAppInterrupt(data) ||
			matchesKey(data, "ctrl+c") ||
			matchesKey(data, "tab") ||
			matchesKey(data, "delete") ||
			(matchesKey(data, "backspace") && props.controller.query().length === 0) ||
			matchesSelectUp(data) ||
			matchesSelectDown(data) ||
			matchesSelectPageUp(data) ||
			matchesSelectPageDown(data) ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			data === "\n"
		) {
			props.controller.handleInput(data);
			event.preventDefault();
			event.stopPropagation();
		}
	};
	const handleMouse = (event: HostMouseEvent): void => {
		if (event.action !== "wheel" || event.wheel === 0) return;
		props.controller.handleWheel(event.wheel);
		event.preventDefault();
	};
	return (
		<box tabIndex={0} onKey={handleKey} onMouse={handleMouse}>
			<frame title={title()} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
				<stack>
					<br />
					<input
						value={props.controller.query()}
						prompt="> "
						onKey={handleInputKey}
						onChange={props.controller.setQuery}
					/>
					<br />
					{props.controller.confirming() ? (
						<scroll
							height={rows()}
							offset={0}
							followTail={false}
							shrinkToFit={props.options?.fillHeight !== true}
						>
							<DeleteConfirmationView session={props.controller.confirming()!} controller={props.controller} />
						</scroll>
					) : (
						<>
							{message() ? (
								<text color={props.controller.error() ? "error" : "muted"} wrap="clip">
									{message()}
								</text>
							) : null}
							{props.controller.error() ? <br /> : null}
							<scroll
								height={viewportHeight()}
								offset={window().offset}
								totalRows={window().totalRows}
								contentWindowed
								followTail={false}
								trackColor="muted"
								thumbColor="accent"
								shrinkToFit={props.options?.fillHeight !== true}
							>
								{visible().length === 0 ? (
									<text color="muted" wrap="clip">
										{showCwd()
											? "No sessions found"
											: "No sessions in current folder. Press Tab to view all."}
									</text>
								) : (
									<For each={windowed()}>
										{(session, index) => (
											<SessionEntryView
												session={session}
												index={window().start + index()}
												selected={window().start + index() === props.controller.selectedIndex()}
												showCwd={showCwd()}
												pinned={props.options?.pinnedIds?.has(session.id) === true}
												current={session.path === currentSessionPath(props.options)}
												now={now()}
												controller={props.controller}
												separator={index() < windowed().length - 1}
											/>
										)}
									</For>
								)}
							</scroll>
						</>
					)}
					<br />
					<text color="dim" wrap="clip">
						[Del/⌫ delete · Enter select · Tab{" "}
						{props.controller.scope() === "all" ? "current folder" : "all projects"} · Esc cancel]
					</text>
					<br />
				</stack>
			</frame>
		</box>
	);
}

export interface SessionSelectorOverlayProps<T extends SessionSelectorEntry> {
	readonly sessions: T[];
	readonly onSelect: (session: T) => void;
	readonly onCancel: () => void;
	readonly onExit: () => void;
	readonly options?: SessionSelectorOptions<T>;
}

export interface SessionSelectorHandle<T extends SessionSelectorEntry>
	extends OverlayDisposer, SessionSelectorController<T> {}

export function openSessionSelectorOverlay<T extends SessionSelectorEntry>(
	tui: TUI,
	props: SessionSelectorOverlayProps<T>,
): SessionSelectorHandle<T> {
	const controller = createSessionSelectorController(
		props.sessions,
		props.onSelect,
		props.onCancel,
		props.onExit,
		props.options,
	);
	const disposer = mountOverlay(tui, () => (
		<Portal
			to="overlay"
			fullscreen={props.options?.fillHeight}
			mouseTracking={props.options?.fillHeight}
			anchor={props.options?.fillHeight ? "top-left" : "bottom-center"}
			margin={props.options?.fillHeight ? 0 : undefined}
			maxHeight={props.options?.fillHeight ? "100%" : undefined}
			width={props.options?.width ?? "100%"}
		>
			<SessionSelectorView controller={controller} options={props.options} />
		</Portal>
	));
	return bindOverlayController(disposer, controller);
}
