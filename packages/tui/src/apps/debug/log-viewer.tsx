import { extractPrintableText, matchesKey } from "../../keys";
import { replaceTabs } from "../../utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { Theme } from "../../theme/theme";
import { sanitizeDisplayText } from "../../overlays/extensions/display-text";
import { clampScrollOffset } from "../../components/scroll-viewport";
import { Attr, Style } from "../../core/style";
import type { HostKeyEvent, HostMouseEvent } from "../../host/input";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	useFocus,
	useTheme,
	useViewport,
	type JSX,
} from "../../reactive";
import { DebugLogExpandedView, parseDebugLogPid, parseDebugLogTimestampMs } from "./log-formatting";
/** Host capabilities for copying and fetching earlier log entries. */
export interface LogViewerDeps {
	copyToClipboard(text: string): void;
	hasOlderLogs?(): boolean;
	loadOlderLogs?(limitDays?: number): Promise<string>;
}

/** Separator marking logs captured before the current process started. */
export const SESSION_BOUNDARY_WARNING = "### WARNING - Logs above are older than current session!";
/** Action row for loading earlier log entries. */
export const LOAD_OLDER_LABEL = "### MOVE UP TO LOAD MORE...";

const INITIAL_LOG_CHUNK = 50;
const LOAD_OLDER_CHUNK = 50;

type LogEntry = {
	rawLine: string;
	timestampMs: number | undefined;
	pid: number | undefined;
};

type CursorToken = { kind: "log"; logIndex: number } | { kind: "load-older" };

type DebugLogViewerModelOptions = {
	processStartMs?: number;
	processPid?: number;
	hasOlderLogs?: () => boolean;
	loadOlderLogs?: (limitDays?: number) => Promise<string>;
};

type ViewerRow =
	| {
			kind: "warning";
	  }
	| {
			kind: "load-older";
	  }
	| {
			kind: "log";
			logIndex: number;
	  };

function getProcessStartMs(): number {
	return performance.timeOrigin + performance.now() - process.uptime() * 1000;
}

function debugLogStyle(line: string, palette: Theme): Style {
	let level = "";
	try {
		const parsed: unknown = JSON.parse(line);
		if (parsed && typeof parsed === "object") {
			const candidate =
				"level" in parsed && parsed.level !== undefined
					? parsed.level
					: "severity" in parsed
						? parsed.severity
						: undefined;
			if (typeof candidate === "string") level = candidate.toLowerCase();
			else if (typeof candidate === "number") {
				if (candidate >= 50) level = "error";
				else if (candidate >= 40) level = "warn";
				else if (candidate >= 30) level = "info";
				else level = "debug";
			}
		}
	} catch {
		const match = /\b(trace|debug|info|warn(?:ing)?|error|fatal)\b/i.exec(line);
		level = match?.[1]?.toLowerCase() ?? "";
	}
	if (level === "fatal" || level === "error") return palette.style("error");
	if (level === "warn" || level === "warning") return palette.style("warning");
	if (level === "info") return palette.style("success");
	if (level === "trace" || level === "debug") return palette.style("dim");
	return Style.NONE;
}

/** Split raw log text into nonempty entries. */
export function splitLogText(logText: string): string[] {
	return logText.split("\n").filter(line => line.length > 0);
}

/** Build sanitized clipboard text from selected log entries. */
export function buildLogCopyPayload(lines: string[]): string {
	return lines
		.map(line => sanitizeText(line))
		.filter(line => line.length > 0)
		.join("\n");
}

/** Filter, paginate, expand, and select captured log entries. */
export class DebugLogViewerModel {
	#entries: LogEntry[];
	#rows: ViewerRow[];
	#visibleLogIndices: number[];
	#selectableRowIndices: number[];
	#cursorSelectableIndex = 0;
	#selectionAnchorSelectableIndex: number | undefined;
	#expandedLogIndices = new Set<number>();
	#filterQuery = "";
	#processStartMs: number;
	#loadedStartIndex: number;
	#processFilterEnabled = false;
	#processPid: number;
	#hasOlderLogs?: () => boolean;
	#loadOlderLogs?: (limitDays?: number) => Promise<string>;

	constructor(logText: string, options: DebugLogViewerModelOptions = {}) {
		const { processStartMs = getProcessStartMs(), processPid = process.pid, hasOlderLogs, loadOlderLogs } = options;
		this.#entries = splitLogText(logText).map(rawLine => ({
			rawLine,
			timestampMs: parseDebugLogTimestampMs(rawLine),
			pid: parseDebugLogPid(rawLine),
		}));
		this.#processStartMs = processStartMs;
		this.#processPid = processPid;
		this.#hasOlderLogs = hasOlderLogs;
		this.#loadOlderLogs = loadOlderLogs;
		this.#loadedStartIndex = Math.max(0, this.#entries.length - INITIAL_LOG_CHUNK);
		this.#rows = [];
		this.#visibleLogIndices = [];
		this.#selectableRowIndices = [];
		this.#rebuildRows();
	}

	get logCount(): number {
		return this.#entries.length;
	}

	get visibleLogCount(): number {
		return this.#visibleLogIndices.length;
	}

	get rows(): readonly ViewerRow[] {
		return this.#rows;
	}

	get cursorRowIndex(): number | undefined {
		return this.#selectableRowIndices[this.#cursorSelectableIndex];
	}

	get cursorLogIndex(): number | undefined {
		const row = this.#getCursorRow();
		return row?.kind === "log" ? row.logIndex : undefined;
	}

	get filterQuery(): string {
		return this.#filterQuery;
	}

	get cursorRowKind(): ViewerRow["kind"] | undefined {
		return this.#getCursorRow()?.kind;
	}

	get expandedCount(): number {
		return this.#expandedLogIndices.size;
	}

	isProcessFilterEnabled(): boolean {
		return this.#processFilterEnabled;
	}

	isCursorAtFirstSelectableRow(): boolean {
		return this.#cursorSelectableIndex === 0;
	}

	getRawLine(logIndex: number): string {
		return this.#entries[logIndex]?.rawLine ?? "";
	}

	setFilterQuery(query: string): void {
		if (query === this.#filterQuery) {
			return;
		}
		this.#filterQuery = query;
		this.#rebuildRows();
	}

	toggleProcessFilter(): void {
		this.#processFilterEnabled = !this.#processFilterEnabled;
		this.#rebuildRows();
	}

	moveCursor(delta: number, extendSelection: boolean): void {
		if (this.#selectableRowIndices.length === 0) {
			return;
		}

		if (extendSelection && this.#selectionAnchorSelectableIndex === undefined) {
			const row = this.#getCursorRow();
			if (row?.kind === "log") {
				this.#selectionAnchorSelectableIndex = this.#cursorSelectableIndex;
			}
		}

		this.#cursorSelectableIndex = Math.max(
			0,
			Math.min(this.#selectableRowIndices.length - 1, this.#cursorSelectableIndex + delta),
		);

		if (!extendSelection) {
			this.#selectionAnchorSelectableIndex = undefined;
		}

		if (this.#getCursorRow()?.kind !== "log" && !extendSelection) {
			this.#selectionAnchorSelectableIndex = undefined;
		}
	}

	moveCursorToRow(rowIndex: number, extendSelection: boolean): boolean {
		const selectableIndex = this.#selectableRowIndices.indexOf(rowIndex);
		if (selectableIndex < 0) {
			return false;
		}

		if (extendSelection && this.#selectionAnchorSelectableIndex === undefined) {
			const row = this.#getCursorRow();
			if (row?.kind === "log") {
				this.#selectionAnchorSelectableIndex = this.#cursorSelectableIndex;
			}
		}

		this.#cursorSelectableIndex = selectableIndex;

		if (!extendSelection) {
			this.#selectionAnchorSelectableIndex = undefined;
		}

		if (this.#getCursorRow()?.kind !== "log" && !extendSelection) {
			this.#selectionAnchorSelectableIndex = undefined;
		}
		return true;
	}

	getSelectedLogIndices(): number[] {
		if (this.#selectableRowIndices.length === 0) {
			return [];
		}

		const cursorRow = this.#getCursorRow();
		if (this.#selectionAnchorSelectableIndex === undefined) {
			if (cursorRow?.kind !== "log") {
				return [];
			}
			return [cursorRow.logIndex];
		}

		const min = Math.min(this.#selectionAnchorSelectableIndex, this.#cursorSelectableIndex);
		const max = Math.max(this.#selectionAnchorSelectableIndex, this.#cursorSelectableIndex);
		const selected: number[] = [];
		for (let i = min; i <= max; i++) {
			const rowIndex = this.#selectableRowIndices[i];
			const row = rowIndex === undefined ? undefined : this.#rows[rowIndex];
			if (row?.kind === "log") {
				selected.push(row.logIndex);
			}
		}
		return selected;
	}

	getSelectedCount(): number {
		return this.getSelectedLogIndices().length;
	}

	isSelected(logIndex: number): boolean {
		const selected = this.getSelectedLogIndices();
		return selected.includes(logIndex);
	}

	isExpanded(logIndex: number): boolean {
		return this.#expandedLogIndices.has(logIndex);
	}

	expandSelected(): void {
		for (const index of this.getSelectedLogIndices()) {
			this.#expandedLogIndices.add(index);
		}
	}

	collapseSelected(): void {
		for (const index of this.getSelectedLogIndices()) {
			this.#expandedLogIndices.delete(index);
		}
	}

	getSelectedRawLines(): string[] {
		const selectedIndices = this.getSelectedLogIndices();
		return selectedIndices.map(index => this.getRawLine(index));
	}

	selectAllVisible(): void {
		if (this.#selectableRowIndices.length === 0) {
			return;
		}

		let firstLogIndex: number | undefined;
		let lastLogIndex: number | undefined;
		for (let i = 0; i < this.#selectableRowIndices.length; i++) {
			const rowIndex = this.#selectableRowIndices[i];
			const row = rowIndex === undefined ? undefined : this.#rows[rowIndex];
			if (row?.kind === "log") {
				if (firstLogIndex === undefined) {
					firstLogIndex = i;
				}
				lastLogIndex = i;
			}
		}

		if (firstLogIndex === undefined || lastLogIndex === undefined) {
			return;
		}

		this.#selectionAnchorSelectableIndex = firstLogIndex;
		this.#cursorSelectableIndex = lastLogIndex;
	}

	canLoadOlder(): boolean {
		return this.#loadedStartIndex > 0 || this.#hasExternalOlderLogs();
	}

	async loadOlder(additionalCount: number = LOAD_OLDER_CHUNK): Promise<boolean> {
		if (this.#loadedStartIndex > 0) {
			return this.#loadOlderInMemory(additionalCount);
		}
		if (!this.#loadOlderLogs || !this.#hasExternalOlderLogs()) {
			return false;
		}
		const olderText = await this.#loadOlderLogs();
		if (olderText.length === 0) {
			if (!this.#hasExternalOlderLogs()) {
				this.#rebuildRows();
			}
			return false;
		}
		const added = this.prependLogs(olderText);
		if (added === 0) {
			if (!this.#hasExternalOlderLogs()) {
				this.#rebuildRows();
			}
			return false;
		}
		return this.#loadOlderInMemory(additionalCount);
	}

	prependLogs(logText: string): number {
		const previousCursor = this.#getCursorToken();
		const previousAnchorLogIndex = this.#getAnchorLogIndex();
		const newEntries = splitLogText(logText).map(rawLine => ({
			rawLine,
			timestampMs: parseDebugLogTimestampMs(rawLine),
			pid: parseDebugLogPid(rawLine),
		}));
		if (newEntries.length === 0) {
			return 0;
		}
		const offset = newEntries.length;
		this.#entries = [...newEntries, ...this.#entries];
		this.#loadedStartIndex += offset;
		this.#expandedLogIndices = new Set([...this.#expandedLogIndices].map(logIndex => logIndex + offset));
		const adjustedCursor: CursorToken | undefined =
			previousCursor?.kind === "log" ? { kind: "log", logIndex: previousCursor.logIndex + offset } : previousCursor;
		const adjustedAnchor = previousAnchorLogIndex === undefined ? undefined : previousAnchorLogIndex + offset;
		this.#rebuildRows(adjustedCursor, adjustedAnchor);
		return offset;
	}

	#loadOlderInMemory(additionalCount: number = LOAD_OLDER_CHUNK): boolean {
		if (this.#loadedStartIndex === 0) {
			return false;
		}
		const requested = Math.max(1, additionalCount);
		const nextStart = Math.max(0, this.#loadedStartIndex - requested);
		if (nextStart === this.#loadedStartIndex) {
			return false;
		}
		this.#loadedStartIndex = nextStart;
		this.#rebuildRows();
		return true;
	}

	#rebuildRows(
		previousCursor: CursorToken | undefined = this.#getCursorToken(),
		previousAnchorLogIndex = this.#getAnchorLogIndex(),
	): void {
		const query = this.#filterQuery.toLowerCase();
		const visible: number[] = [];
		for (let i = this.#loadedStartIndex; i < this.#entries.length; i++) {
			const entry = this.#entries[i];
			if (!entry) {
				continue;
			}
			if (this.#matchesFilters(entry, query)) {
				visible.push(i);
			}
		}
		this.#visibleLogIndices = visible;

		const rows: ViewerRow[] = [];
		if (this.#hasOlderEntries(query)) {
			rows.push({ kind: "load-older" });
		}
		let olderSeen = false;
		let warningInserted = false;
		for (const logIndex of visible) {
			const timestampMs = this.#entries[logIndex]?.timestampMs;
			if (timestampMs !== undefined) {
				if (timestampMs < this.#processStartMs) {
					olderSeen = true;
				} else if (olderSeen && !warningInserted) {
					rows.push({ kind: "warning" });
					warningInserted = true;
				}
			}
			rows.push({ kind: "log", logIndex });
		}
		this.#rows = rows;
		this.#selectableRowIndices = rows
			.map((row, index) => (row.kind === "warning" ? undefined : index))
			.filter((index): index is number => index !== undefined);

		if (this.#selectableRowIndices.length === 0) {
			this.#cursorSelectableIndex = 0;
			this.#selectionAnchorSelectableIndex = undefined;
			return;
		}

		if (previousCursor?.kind === "log") {
			const rowIndex = this.#rows.findIndex(row => row.kind === "log" && row.logIndex === previousCursor.logIndex);
			const selectableIndex = this.#selectableRowIndices.indexOf(rowIndex);
			if (selectableIndex >= 0) {
				this.#cursorSelectableIndex = selectableIndex;
			} else {
				this.#cursorSelectableIndex = this.#selectableRowIndices.length - 1;
			}
		} else if (previousCursor?.kind === "load-older") {
			const rowIndex = this.#rows.findIndex(row => row.kind === "load-older");
			const selectableIndex = this.#selectableRowIndices.indexOf(rowIndex);
			this.#cursorSelectableIndex = selectableIndex >= 0 ? selectableIndex : this.#selectableRowIndices.length - 1;
		} else {
			this.#cursorSelectableIndex = this.#selectableRowIndices.length - 1;
		}

		if (previousAnchorLogIndex !== undefined) {
			const rowIndex = this.#rows.findIndex(row => row.kind === "log" && row.logIndex === previousAnchorLogIndex);
			const selectableIndex = this.#selectableRowIndices.indexOf(rowIndex);
			this.#selectionAnchorSelectableIndex = selectableIndex >= 0 ? selectableIndex : undefined;
		} else {
			this.#selectionAnchorSelectableIndex = undefined;
		}
	}

	#matchesFilters(entry: LogEntry, query: string): boolean {
		if (query.length > 0 && !entry.rawLine.toLowerCase().includes(query)) {
			return false;
		}
		if (!this.#processFilterEnabled) {
			return true;
		}
		return entry.pid === this.#processPid;
	}

	#hasOlderEntries(query: string): boolean {
		if (this.#hasExternalOlderLogs()) {
			return true;
		}
		if (this.#loadedStartIndex === 0) {
			return false;
		}
		for (let i = 0; i < this.#loadedStartIndex; i++) {
			const entry = this.#entries[i];
			if (entry && this.#matchesFilters(entry, query)) {
				return true;
			}
		}
		return false;
	}

	#hasExternalOlderLogs(): boolean {
		return this.#hasOlderLogs?.() ?? false;
	}

	#getCursorRow(): ViewerRow | undefined {
		const rowIndex = this.cursorRowIndex;
		return rowIndex === undefined ? undefined : this.#rows[rowIndex];
	}

	#getCursorToken(): CursorToken | undefined {
		const row = this.#getCursorRow();
		if (!row) {
			return undefined;
		}
		if (row.kind === "log") {
			return { kind: "log", logIndex: row.logIndex };
		}
		if (row.kind === "load-older") {
			return { kind: "load-older" };
		}
		return undefined;
	}

	#getAnchorLogIndex(): number | undefined {
		if (this.#selectionAnchorSelectableIndex === undefined) {
			return undefined;
		}
		const rowIndex = this.#selectableRowIndices[this.#selectionAnchorSelectableIndex];
		const row = rowIndex === undefined ? undefined : this.#rows[rowIndex];
		return row?.kind === "log" ? row.logIndex : undefined;
	}
}

type ViewerScrollGeometry = {
	totalRows: number;
	height: number;
	width: number;
};

function LogSummaryView({ model, revision }: { model: DebugLogViewerModel; revision: () => number }): JSX.Element {
	const selected = () => {
		revision();
		return model.getSelectedCount();
	};
	const expanded = () => {
		revision();
		return model.expandedCount;
	};
	return (
		<text wrap="clip">
			<span color="muted">showing</span>
			<span color="accent">
				{" "}
				{() => {
					revision();
					return `${model.visibleLogCount}/${model.logCount}`;
				}}
			</span>
			<span color="muted"> selected </span>
			<span color={selected() > 0 ? "accent" : "muted"}>{selected()}</span>
			<span color="muted"> expanded </span>
			<span color={expanded() > 0 ? "accent" : "muted"}>{expanded()}</span>
		</text>
	);
}

function LogFilterView({
	model,
	revision,
	loadingOlder,
}: {
	model: DebugLogViewerModel;
	revision: () => number;
	loadingOlder: () => boolean;
}): JSX.Element {
	const query = () => {
		revision();
		return replaceTabs(sanitizeText(model.filterQuery));
	};
	const processFilter = () => {
		revision();
		return model.isProcessFilterEnabled();
	};
	return (
		<text wrap="clip">
			<span color="muted">filter </span>
			<span color={query().length === 0 ? "muted" : "accent"}>{query() || "type to filter"}</span>
			{"  "}
			<span color={processFilter() ? "success" : "muted"}>{processFilter() ? "pid on" : "pid off"}</span>
			{loadingOlder() ? <span color="warning"> loading older…</span> : null}
		</text>
	);
}

function LogFooterView({ statusMessage }: { statusMessage: () => string | undefined }): JSX.Element {
	return (
		<stack>
			<text wrap="clip" color={statusMessage() ? "success" : "dim"}>
				{statusMessage() ?? "Enter loads older when highlighted; printable keys update filter"}
			</text>
			<text wrap="clip" color="dim">
				Esc close · Ctrl+C copy · ↑/↓/wheel move · click toggle · Shift+↑/↓ select · ←/→ collapse/expand · Ctrl+A
				all · Ctrl+O older · Ctrl+P pid
			</text>
		</stack>
	);
}

function LogLoadOlderRow({
	model,
	revision,
	onActivate,
}: {
	model: DebugLogViewerModel;
	revision: () => number;
	onActivate: () => void;
}): JSX.Element {
	const active = () => {
		revision();
		return model.cursorRowKind === "load-older";
	};
	const handleMouse = (event: HostMouseEvent): void => {
		if (event.action !== "down" || event.button !== 0) return;
		onActivate();
		event.preventDefault();
		event.stopPropagation();
	};
	return (
		<box onMouse={handleMouse}>
			<text wrap="clip">
				<span color={active() ? "accent" : undefined}>{active() ? "❯" : " "}</span>
				{"  "}
				<span color="muted">{LOAD_OLDER_LABEL}</span>
			</text>
		</box>
	);
}

function LogEntryRow({
	model,
	logIndex,
	revision,
	onActivate,
}: {
	model: DebugLogViewerModel;
	logIndex: number;
	revision: () => number;
	onActivate: () => void;
}): JSX.Element {
	const palette = useTheme();
	const visual = createMemo(() => {
		revision();
		const raw = model.getRawLine(logIndex);
		const selected = model.isSelected(logIndex);
		const active = model.cursorLogIndex === logIndex;
		const expanded = model.isExpanded(logIndex);
		const baseStyle = debugLogStyle(raw, palette.theme());
		return {
			raw,
			selected,
			active,
			expanded,
			contentStyle: selected ? baseStyle.plus(Attr.Bold) : baseStyle,
			marker: active ? "❯" : selected ? "•" : " ",
			markerStyle: active || selected ? palette.theme().style("accent") : Style.NONE,
		};
	});
	const handleMouse = (event: HostMouseEvent): void => {
		if (event.action !== "down" || event.button !== 0) return;
		onActivate();
		event.preventDefault();
		event.stopPropagation();
	};
	return (
		<box onMouse={handleMouse}>
			{() => {
				const entry = visual();
				return entry.expanded ? (
					<row>
						<text width={3} wrap="none">
							<span style={entry.markerStyle}>{entry.marker}</span>
							<span color="accent">▾</span>{" "}
						</text>
						<box grow={1}>
							<DebugLogExpandedView line={entry.raw} style={entry.contentStyle} />
						</box>
					</row>
				) : (
					<text wrap="clip">
						<span style={entry.markerStyle}>{entry.marker}</span>
						<span color="muted">▸</span> <span style={entry.contentStyle}>{sanitizeDisplayText(entry.raw)}</span>
					</text>
				);
			}}
		</box>
	);
}

function LogRowsView({
	model,
	revision,
	onActivate,
}: {
	model: DebugLogViewerModel;
	revision: () => number;
	onActivate: (rowIndex: number) => void;
}): JSX.Element {
	const rows = createMemo(() => {
		revision();
		return model.rows;
	});
	return (
		<Show when={rows().length > 0} fallback={<text color="muted">no matches</text>}>
			<stack>
				<For each={rows()}>
					{(row, index) => {
						const rowIndex = index();
						if (row.kind === "warning") {
							return (
								<text key={`warning-${rowIndex}`} wrap="clip" color="muted">
									{SESSION_BOUNDARY_WARNING}
								</text>
							);
						}
						if (row.kind === "load-older") {
							return (
								<LogLoadOlderRow model={model} revision={revision} onActivate={() => onActivate(rowIndex)} />
							);
						}
						return (
							<LogEntryRow
								model={model}
								logIndex={row.logIndex}
								revision={revision}
								onActivate={() => onActivate(rowIndex)}
							/>
						);
					}}
				</For>
			</stack>
		</Show>
	);
}

function rowMetrics(
	model: DebugLogViewerModel,
	width: number,
): {
	totalRows: number;
	cursorStart: number | undefined;
	cursorEnd: number | undefined;
} {
	const contentWidth = Math.max(1, width - 3);
	const cursorRowIndex = model.cursorRowIndex;
	let totalRows = 0;
	let cursorStart: number | undefined;
	let cursorEnd: number | undefined;

	for (let rowIndex = 0; rowIndex < model.rows.length; rowIndex++) {
		const row = model.rows[rowIndex];
		if (!row) continue;
		const start = totalRows;
		let rows = 1;
		if (row.kind === "log" && model.isExpanded(row.logIndex)) {
			rows = sanitizeDisplayText(model.getRawLine(row.logIndex))
				.split("\n")
				.reduce((count, segment) => count + Math.max(1, Math.ceil(Bun.stringWidth(segment) / contentWidth)), 0);
		}
		totalRows += rows;
		if (rowIndex === cursorRowIndex) {
			cursorStart = start;
			cursorEnd = totalRows;
		}
	}

	return { totalRows, cursorStart, cursorEnd };
}

export interface DebugLogViewerViewProps {
	readonly logs: string;
	readonly deps: LogViewerDeps;
	onExit(): void;
	onStatus?(message: string): void;
	onError?(message: string): void;
	readonly processStartMs?: number;
	readonly processPid?: number;
}

/** Reactive log viewer with historical selection, filtering, mouse, and archive loading behavior. */
export function DebugLogViewerView(props: DebugLogViewerViewProps): JSX.Element {
	const model = new DebugLogViewerModel(props.logs, {
		processStartMs: props.processStartMs,
		processPid: props.processPid,
		hasOlderLogs: props.deps.hasOlderLogs?.bind(props.deps),
		loadOlderLogs: props.deps.loadOlderLogs?.bind(props.deps),
	});
	const focus = useFocus();
	const viewport = useViewport();
	const [revision, setRevision] = createSignal(0);
	const [statusMessage, setStatusMessage] = createSignal<string>();
	const [loadingOlder, setLoadingOlder] = createSignal(false);
	const [offset, setOffset] = createSignal(0);
	const [geometry, setGeometry] = createSignal<ViewerScrollGeometry>({ totalRows: 0, height: 0, width: 0 });
	let disposed = false;

	const bodyHeight = (): number => Math.max(3, viewport().rows - 8);
	const metrics = () => {
		const measured = geometry();
		const width = measured.width > 0 ? measured.width : Math.max(1, viewport().columns - 5);
		return rowMetrics(model, width);
	};
	const update = (): void => {
		setRevision(value => value + 1);
	};
	const ensureCursorVisible = (): void => {
		const layout = metrics();
		const { cursorStart, cursorEnd } = layout;
		if (cursorStart === undefined || cursorEnd === undefined) return;
		const measured = geometry();
		const height = Math.max(1, measured.height || bodyHeight());
		setOffset(current => {
			if (cursorStart < current) return clampScrollOffset(cursorStart, layout.totalRows, height);
			if (cursorEnd > current + height) return clampScrollOffset(cursorEnd - height, layout.totalRows, height);
			return clampScrollOffset(current, layout.totalRows, height);
		});
	};
	const clearStatus = (): void => {
		setStatusMessage(undefined);
	};
	const copySelected = (): void => {
		const selectedPayload = buildLogCopyPayload(model.getSelectedRawLines());
		const selected = selectedPayload.length === 0 ? [] : selectedPayload.split("\n");
		if (selected.length === 0) {
			const message = "No log entry selected";
			setStatusMessage(message);
			props.onStatus?.(message);
			return;
		}
		try {
			props.deps.copyToClipboard(selectedPayload);
			const message = `Copied ${selected.length} log ${selected.length === 1 ? "entry" : "entries"}`;
			setStatusMessage(message);
			props.onStatus?.(message);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setStatusMessage(`Copy failed: ${message}`);
			props.onError?.(`Failed to copy logs: ${message}`);
		}
	};
	const loadOlder = async (additionalCount: number): Promise<boolean> => {
		if (loadingOlder() || !model.canLoadOlder()) return false;
		setLoadingOlder(true);
		try {
			const loaded = await model.loadOlder(additionalCount);
			if (disposed) return false;
			if (loaded) {
				update();
				ensureCursorVisible();
			}
			return loaded;
		} catch (error) {
			if (disposed) return false;
			const message = error instanceof Error ? error.message : String(error);
			setStatusMessage(`Load older failed: ${message}`);
			props.onError?.(`Failed to load older logs: ${message}`);
			return false;
		} finally {
			if (!disposed) setLoadingOlder(false);
		}
	};
	const handleLoadOlder = async (additionalCount = LOAD_OLDER_CHUNK): Promise<void> => {
		await loadOlder(additionalCount);
	};
	const handleMoveUp = async (extendSelection: boolean): Promise<void> => {
		if (model.cursorRowKind === "load-older") {
			if (await loadOlder(LOAD_OLDER_CHUNK)) return;
		}
		if (model.canLoadOlder() && model.isCursorAtFirstSelectableRow()) {
			if (await loadOlder(LOAD_OLDER_CHUNK)) {
				model.moveCursor(-1, extendSelection);
				update();
				ensureCursorVisible();
				return;
			}
		}
		model.moveCursor(-1, extendSelection);
		update();
		ensureCursorVisible();
	};
	const activateRow = (rowIndex: number): void => {
		const target = model.rows[rowIndex];
		if (!target || target.kind === "warning") return;
		focus.focus();
		clearStatus();
		model.moveCursorToRow(rowIndex, false);
		if (target.kind === "load-older") {
			void handleLoadOlder();
			update();
			ensureCursorVisible();
			return;
		}
		if (model.isExpanded(target.logIndex)) model.collapseSelected();
		else model.expandSelected();
		update();
		ensureCursorVisible();
	};
	const consume = (event: HostKeyEvent | HostMouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
	};
	const handleKey = (event: HostKeyEvent): void => {
		const data = event.data;
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			props.onExit();
			consume(event);
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			copySelected();
			consume(event);
			return;
		}
		if (matchesKey(data, "ctrl+p")) {
			clearStatus();
			model.toggleProcessFilter();
			update();
			ensureCursorVisible();
			consume(event);
			return;
		}
		if (matchesKey(data, "ctrl+a")) {
			clearStatus();
			model.selectAllVisible();
			update();
			ensureCursorVisible();
			consume(event);
			return;
		}
		if (matchesKey(data, "ctrl+o")) {
			clearStatus();
			void handleLoadOlder(Math.max(1, geometry().height || bodyHeight()) + 1);
			consume(event);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (model.cursorRowKind === "load-older") {
				clearStatus();
				void handleLoadOlder();
			}
			consume(event);
			return;
		}
		if (matchesKey(data, "shift+up")) {
			clearStatus();
			void handleMoveUp(true);
			consume(event);
			return;
		}
		if (matchesKey(data, "shift+down")) {
			clearStatus();
			model.moveCursor(1, true);
			update();
			ensureCursorVisible();
			consume(event);
			return;
		}
		if (matchesKey(data, "up")) {
			clearStatus();
			void handleMoveUp(false);
			consume(event);
			return;
		}
		if (matchesKey(data, "down")) {
			clearStatus();
			model.moveCursor(1, false);
			update();
			ensureCursorVisible();
			consume(event);
			return;
		}
		if (matchesKey(data, "right")) {
			clearStatus();
			if (model.cursorRowKind === "load-older") void handleLoadOlder();
			else {
				model.expandSelected();
				update();
				ensureCursorVisible();
			}
			consume(event);
			return;
		}
		if (matchesKey(data, "left")) {
			clearStatus();
			model.collapseSelected();
			update();
			ensureCursorVisible();
			consume(event);
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (model.filterQuery.length > 0) {
				clearStatus();
				model.setFilterQuery(model.filterQuery.slice(0, -1));
				update();
				ensureCursorVisible();
			}
			consume(event);
			return;
		}
		const printableText = extractPrintableText(data);
		if (!printableText) return;
		clearStatus();
		model.setFilterQuery(model.filterQuery + printableText);
		update();
		ensureCursorVisible();
		consume(event);
	};
	const handleBodyMouse = (event: HostMouseEvent): void => {
		if (event.action !== "wheel" || event.wheel === 0) return;
		clearStatus();
		const measured = geometry();
		const layout = metrics();
		const height = Math.max(1, measured.height || bodyHeight());
		setOffset(current => clampScrollOffset(current + event.wheel * 3, layout.totalRows, height));
		consume(event);
	};

	createEffect(() => {
		revision();
		geometry();
		viewport();
		ensureCursorVisible();
	});
	onMount(() => focus.focus());
	onCleanup(() => {
		disposed = true;
	});

	return (
		<box tabIndex={focus.tabIndex} onKey={handleKey}>
			<frame title="Recent Logs" paddingX={1} paddingY={0} fitContent>
				<stack>
					<LogSummaryView model={model} revision={revision} />
					<LogFilterView model={model} revision={revision} loadingOlder={loadingOlder} />
					<hr variant="frame" />
					<scroll
						height={bodyHeight()}
						offset={offset()}
						scrollbar="auto"
						followTail={false}
						trackColor="dim"
						thumbColor="accent"
						onViewport={next => {
							setGeometry(previous =>
								previous.totalRows === next.totalRows &&
								previous.height === next.height &&
								previous.width === next.width
									? previous
									: {
											totalRows: next.totalRows,
											height: next.height,
											width: next.width,
										},
							);
						}}
						onMouse={handleBodyMouse}
					>
						<LogRowsView model={model} revision={revision} onActivate={activateRow} />
					</scroll>
					<hr variant="frame" />
					<LogFooterView statusMessage={statusMessage} />
				</stack>
			</frame>
		</box>
	);
}
