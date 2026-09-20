import { matchesKey } from "../../keys";
import type { HostKeyEvent, HostMouseEvent } from "../../host/input";
import {
	createMemo,
	createSignal,
	Index,
	onCleanup,
	onMount,
	Show,
	useFocus,
	useViewport,
	type Accessor,
	type JSX,
} from "../../reactive";
import { sanitizeDisplayText } from "../../overlays/extensions/display-text";
import { formatRawSseIsoTime, type RawSseDebugBuffer, rawSseRecordLines } from "./raw-sse-buffer";

const MIN_VIEWER_WIDTH = 40;
const PRETTY_PRINT_DATA_THRESHOLD = 100;

export function expandPrettyDataLines(raw: readonly string[]): string[] {
	const result: string[] = [];
	for (const line of raw) {
		if (!line.startsWith("data: ") || line.length <= PRETTY_PRINT_DATA_THRESHOLD) {
			result.push(line);
			continue;
		}
		const body = line.slice("data: ".length);
		const trimmed = body.trim();
		if (trimmed.length === 0 || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
			result.push(line);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			result.push(line);
			continue;
		}
		for (const prettyLine of JSON.stringify(parsed, null, 2).split("\n")) result.push(`data: ${prettyLine}`);
	}
	return result;
}

export interface RawSseViewerDeps {
	copyToClipboard(text: string): void;
}

function RawSseSummaryView(props: {
	readonly totalEvents: number;
	readonly recordCount: number;
	readonly lastUpdatedAt: number | undefined;
	readonly following: boolean;
}): JSX.Element {
	return (
		<text wrap="clip">
			<span color="muted">events </span>
			<span color="accent">{props.totalEvents}</span>
			{"  "}
			<span color="muted">records </span>
			<span color="accent">{props.recordCount}</span>
			{"  "}
			<Show when={props.lastUpdatedAt} fallback={<span color="muted">waiting for first frame</span>}>
				{(timestamp: Accessor<number>) => (
					<span>
						<span color="muted">last </span>
						<span color="accent">{formatRawSseIsoTime(timestamp())}</span>
					</span>
				)}
			</Show>
			{"  "}
			<span color={props.following ? "success" : "warning"}>{props.following ? "follow on" : "follow off"}</span>
		</text>
	);
}

function RawSseRowsView(props: {
	readonly rows: readonly { key: string; text: string; warning?: boolean }[];
	readonly droppedRecords: number;
	readonly droppedChars: number;
}): JSX.Element {
	return (
		<Show
			when={props.rows.length > 0}
			fallback={
				<stack>
					<text color="muted">No raw SSE frames captured yet.</text>
					<text color="muted">HTTP SSE providers populate this view while a model response is streaming.</text>
				</stack>
			}
		>
			<stack>
				<Show when={props.droppedRecords > 0}>
					<stack>
						<text color="warning">
							: omp-debug-dropped records={props.droppedRecords} chars={props.droppedChars}
						</text>
						<br />
					</stack>
				</Show>
				<Index each={props.rows}>
					{row => (
						<text wrap="clip" color={row().warning ? "warning" : undefined}>
							{sanitizeDisplayText(row().text)}
						</text>
					)}
				</Index>
			</stack>
		</Show>
	);
}

function RawSseStatusView(props: { readonly message: string | undefined }): JSX.Element {
	return (
		<text wrap="clip">
			<Show when={props.message}>
				<span color="success">
					{props.message}
					{"  "}
				</span>
			</Show>
			<span color="dim">
				Esc close · Ctrl+C copy raw · End follow tail · wheel scroll · click summary toggles follow
			</span>
		</text>
	);
}

export interface RawSseViewerViewProps {
	readonly deps: RawSseViewerDeps;
	readonly buffer: RawSseDebugBuffer;
	onExit(): void;
	onStatus?(message: string): void;
}

/** Reactive raw-stream inspection view. */
export function RawSseViewerView(props: RawSseViewerViewProps): JSX.Element {
	const [revision, setRevision] = createSignal(0);
	const [following, setFollowing] = createSignal(true);
	const [scrollOffset, setScrollOffset] = createSignal(0);
	const [totalRows, setTotalRows] = createSignal(0);
	const [bodyRows, setBodyRows] = createSignal(0);
	const [statusMessage, setStatusMessage] = createSignal<string>();
	const focus = useFocus();
	const viewport = useViewport();
	const prettyLinesCache = new Map<number, string[]>();
	const snapshot = createMemo(() => {
		revision();
		return props.buffer.snapshot();
	});
	const bodyHeight = (): number => Math.max(3, viewport().rows - 6);
	const rows = createMemo(() => {
		const current = snapshot();
		const result: Array<{ key: string; text: string; warning?: boolean }> = [];
		for (const record of current.records) {
			let pretty = prettyLinesCache.get(record.sequence);
			if (!pretty) {
				pretty = expandPrettyDataLines(rawSseRecordLines(record));
				prettyLinesCache.set(record.sequence, pretty);
			}
			for (let index = 0; index < pretty.length; index++)
				result.push({ key: `${record.sequence}:${index}`, text: pretty[index]! });
			if (record.kind === "event" && record.truncated) {
				result.push({
					key: `${record.sequence}:truncated`,
					text: `: omp-debug-event-truncated originalChars=${record.originalChars}`,
					warning: true,
				});
			}
			result.push({ key: `${record.sequence}:blank`, text: "" });
		}
		const firstSequence = current.records[0]?.sequence;
		if (firstSequence !== undefined)
			for (const sequence of prettyLinesCache.keys())
				if (sequence < firstSequence) prettyLinesCache.delete(sequence);
		return result;
	});
	const followTail = (): void => {
		setFollowing(true);
		setScrollOffset(Math.max(0, totalRows() - bodyRows()));
	};
	const scrollBy = (delta: number): void => {
		setFollowing(false);
		setScrollOffset(offset => Math.max(0, offset + Math.trunc(delta)));
	};
	const setBodyOffset = (offset: number): void => {
		setFollowing(false);
		setScrollOffset(Math.max(0, Math.trunc(offset)));
	};
	const handleViewport = (next: {
		readonly offset: number;
		readonly totalRows: number;
		readonly height: number;
	}): void => {
		setTotalRows(previous => (previous === next.totalRows ? previous : next.totalRows));
		setBodyRows(previous => (previous === next.height ? previous : next.height));
		if (following()) {
			const tail = Math.max(0, next.totalRows - next.height);
			setScrollOffset(previous => (previous === tail ? previous : tail));
		} else {
			setScrollOffset(previous => (previous === next.offset ? previous : next.offset));
		}
	};
	const copy = (): void => {
		const payload = props.buffer.toRawText();
		if (payload.trim().length === 0) {
			const message = "No raw SSE frames to copy";
			setStatusMessage(message);
			props.onStatus?.(message);
			return;
		}
		try {
			props.deps.copyToClipboard(payload);
			const message = "Copied raw SSE stream";
			setStatusMessage(message);
			props.onStatus?.(message);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setStatusMessage(`Copy failed: ${message}`);
		}
	};
	let closed = false;
	const unsubscribe = props.buffer.subscribe(() => setRevision(value => value + 1));
	onCleanup(unsubscribe);
	const close = (): void => {
		if (closed) return;
		closed = true;
		unsubscribe();
		props.onExit();
	};
	const handleKey = (event: HostKeyEvent): void => {
		const data = event.data;
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) close();
		else if (matchesKey(data, "ctrl+c")) copy();
		else if (matchesKey(data, "up")) scrollBy(-1);
		else if (matchesKey(data, "down")) scrollBy(1);
		else if (matchesKey(data, "pageUp")) scrollBy(-bodyHeight());
		else if (matchesKey(data, "pageDown")) scrollBy(bodyHeight());
		else if (matchesKey(data, "end")) followTail();
		else return;
		event.preventDefault();
		event.stopPropagation();
	};
	const handleMouse = (event: HostMouseEvent): void => {
		const bodyStart = 3;
		const row = event.localRow;
		const withinBody = row >= bodyStart && row < bodyStart + bodyHeight();
		if (event.action === "wheel") {
			if (!withinBody || event.wheel === 0) return;
			scrollBy(event.wheel * 3);
		} else if (event.action === "down" && event.button === 0) {
			if (row === 1) {
				if (following()) setFollowing(false);
				else followTail();
			} else if (withinBody) {
				setBodyOffset(scrollOffset() + row - bodyStart);
			} else {
				return;
			}
		} else {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	};
	onMount(() => focus.focus());
	return (
		<box
			width={Math.max(MIN_VIEWER_WIDTH, viewport().columns)}
			tabIndex={focus.tabIndex}
			onKey={handleKey}
			onMouse={handleMouse}
		>
			<frame title="Raw Provider Stream" paddingX={1} paddingY={0} borderPolicy="always" fitContent>
				<stack>
					<RawSseSummaryView
						totalEvents={snapshot().totalEvents}
						recordCount={snapshot().records.length}
						lastUpdatedAt={snapshot().lastUpdatedAt}
						following={following()}
					/>
					<hr variant="frame" />
					<scroll
						height={bodyHeight()}
						offset={scrollOffset()}
						scrollbar="auto"
						followTail={following()}
						onViewport={handleViewport}
					>
						<RawSseRowsView
							rows={rows()}
							droppedRecords={snapshot().droppedRecords}
							droppedChars={snapshot().droppedChars}
						/>
					</scroll>
					<hr variant="frame" />
					<RawSseStatusView message={statusMessage()} />
				</stack>
			</frame>
		</box>
	);
}
