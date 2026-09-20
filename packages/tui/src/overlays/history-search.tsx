import { matchesKey } from "../keys";
import {
	matchesAppInterrupt,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent } from "../host/input";
import { centeredViewportRange, scrollbarThumbRange } from "../components/scroll-viewport";
import { For, createEffect, createMemo, createSignal, useClock, useTheme, type JSX } from "../reactive";
import type { SizeValue, TUI } from "../tui";

export interface HistorySearchEntry {
	prompt: string;
	created_at: number;
}

export interface HistorySource {
	search(query: string, limit: number): HistorySearchEntry[];
	getRecent(limit: number): HistorySearchEntry[];
}

/** Visible result rows and PageUp/PageDown jump size. */
const MAX_VISIBLE = 10;
const RESULT_LIMIT = 100;

/** Tokenize exactly as {@link HistorySource.search} does, so highlights align with matches. */
function queryTokens(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(token => token.length > 0);
}

function highlightedText(text: string, tokens: readonly string[]): JSX.Element {
	if (tokens.length === 0) return text;

	const lower = text.toLowerCase();
	const ranges: Array<readonly [number, number]> = [];
	for (const token of tokens) {
		let from = lower.indexOf(token);
		while (from !== -1) {
			ranges.push([from, from + token.length]);
			from = lower.indexOf(token, from + token.length);
		}
	}
	if (ranges.length === 0) return text;

	ranges.sort((left, right) => left[0] - right[0]);
	const parts: JSX.Element[] = [];
	let position = 0;
	for (const [start, end] of ranges) {
		if (end <= position) continue;
		const from = Math.max(start, position);
		if (from > position) parts.push(text.slice(position, from));
		parts.push(<span color="accent">{text.slice(from, end)}</span>);
		position = end;
	}
	if (position < text.length) parts.push(text.slice(position));
	return parts;
}

/** Compact time-since label from an epoch timestamp. */
function relativeTime(epochSeconds: number, nowMs: number): string {
	const seconds = Math.max(0, Math.floor(nowMs / 1000) - epochSeconds);
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

function HistoryResultRow(props: {
	readonly entry: HistorySearchEntry;
	readonly selected: boolean;
	readonly tokens: readonly string[];
	readonly now: number;
	readonly cursor: string;
	readonly cursorWidth: number;
	readonly scrollbar?: "thumb" | "track";
}): JSX.Element {
	const time = () => relativeTime(props.entry.created_at, props.now);
	const prompt = () => props.entry.prompt.replace(/\s+/g, " ").trim();
	const line = (
		<row>
			<text width={props.cursorWidth} shrink={0} color={props.selected ? "accent" : undefined} wrap="clip">
				{props.selected ? props.cursor : " ".repeat(props.cursorWidth)}
			</text>
			<text grow={1} minWidth={12} bold={props.selected} wrap="clip" overflow="ellipsis">
				{highlightedText(prompt(), props.tokens)}
			</text>
			<text shrink={1} minWidth={0} overflowPriority={0} color="dim" wrap="clip">{` ${time()}`}</text>
		</row>
	);
	return (
		<row>
			<box grow={1} minWidth={0} background={props.selected ? "selectedBg" : undefined}>
				{line}
			</box>
			<text
				color={props.scrollbar === "thumb" ? "accent" : props.scrollbar === "track" ? "muted" : undefined}
				width={props.scrollbar ? 1 : 0}
				shrink={0}
				wrap="clip"
			>
				{props.scrollbar === "thumb" ? "█" : props.scrollbar === "track" ? "│" : ""}
			</text>
		</row>
	);
}

export interface HistorySearchProps {
	readonly historyStorage: HistorySource;
	readonly onSelect: (prompt: string) => void;
	readonly onCancel: () => void;
	readonly width?: SizeValue;
}

/** Reactive searchable prompt-history overlay. */
export function HistorySearch(props: HistorySearchProps): JSX.Element {
	const [query, setQuery] = createSignal("");
	const [selectedIndex, setSelectedIndex] = createSignal(0);
	const now = useClock("second");
	const theme = useTheme();
	const entries = createMemo(() => {
		const trimmed = query().trim();
		return trimmed
			? props.historyStorage.search(trimmed, RESULT_LIMIT)
			: props.historyStorage.getRecent(RESULT_LIMIT);
	});
	const tokens = createMemo(() => queryTokens(query().trim()));
	const visibleRange = createMemo(() => centeredViewportRange(selectedIndex(), entries().length, MAX_VISIBLE));
	const visibleEntries = createMemo(() => {
		const range = visibleRange();
		return entries().slice(range.start, range.end);
	});
	const scrollbar = createMemo(() => {
		const count = entries().length;
		if (count <= MAX_VISIBLE) return undefined;
		return scrollbarThumbRange(MAX_VISIBLE, count, visibleRange().start);
	});
	const scrollbarKind = (row: number): "thumb" | "track" | undefined => {
		const thumb = scrollbar();
		if (!thumb) return undefined;
		return row >= thumb.start && row < thumb.end ? "thumb" : "track";
	};
	createEffect(() => {
		const count = entries().length;
		if (selectedIndex() >= count) setSelectedIndex(Math.max(0, count - 1));
	});
	const selectCurrent = (): void => {
		const entry = entries()[selectedIndex()];
		if (entry) props.onSelect(entry.prompt);
	};
	const move = (delta: number): void => {
		const count = entries().length;
		if (count === 0) return;
		setSelectedIndex(previous => Math.max(0, Math.min(count - 1, previous + delta)));
	};
	const handleNavigation = (event: HostKeyEvent): boolean => {
		if (matchesSelectUp(event.data)) {
			move(-1);
			return true;
		}
		if (matchesSelectDown(event.data)) {
			move(1);
			return true;
		}
		if (matchesSelectPageUp(event.data)) {
			move(-MAX_VISIBLE);
			return true;
		}
		if (matchesSelectPageDown(event.data)) {
			move(MAX_VISIBLE);
			return true;
		}
		if (matchesKey(event.data, "home")) {
			setSelectedIndex(0);
			return true;
		}
		if (matchesKey(event.data, "end")) {
			setSelectedIndex(Math.max(0, entries().length - 1));
			return true;
		}
		return false;
	};
	const handleKey = (event: HostKeyEvent): boolean => {
		if (event.defaultPrevented) return false;
		if (matchesAppInterrupt(event.data) || matchesSelectCancel(event.data)) {
			props.onCancel();
			return true;
		}
		return handleNavigation(event);
	};
	const handleInputKey = (event: HostKeyEvent): void => {
		if (!handleNavigation(event)) return;
		event.preventDefault();
		event.stopPropagation();
	};
	const updateQuery = (value: string): void => {
		setQuery(value);
		setSelectedIndex(0);
	};
	const emptyMessage = () => (query().trim() ? "No matching history" : "No history yet");
	const cursor = () => `${theme.symbol("nav.cursor")} `;
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<box onKey={handleKey} tabIndex={0}>
				<frame title="History" paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
					<stack>
						<br />
						<input
							value={query()}
							prompt="> "
							onKey={handleInputKey}
							onChange={updateQuery}
							onSubmit={selectCurrent}
							onEscape={props.onCancel}
						/>
						<br />
						{entries().length === 0 ? (
							<text color="muted" wrap="clip">
								{"  "}
								{theme.symbol("status.info")} {emptyMessage()}
							</text>
						) : (
							<For each={visibleEntries()}>
								{(entry, index) => (
									<HistoryResultRow
										entry={entry}
										selected={visibleRange().start + index() === selectedIndex()}
										tokens={tokens()}
										now={now()}
										cursor={cursor()}
										cursorWidth={cursor().length}
										scrollbar={scrollbarKind(index())}
									/>
								)}
							</For>
						)}
						<br />
						<text color="dim" wrap="word">
							{"↑↓ navigate · enter select · esc cancel"}
						</text>
						<br />
					</stack>
				</frame>
			</box>
		</Portal>
	);
}

export function openHistorySearch(tui: TUI, props: HistorySearchProps): OverlayDisposer {
	return mountOverlay(tui, () => <HistorySearch {...props} />);
}
