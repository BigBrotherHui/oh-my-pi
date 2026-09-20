import type * as fs from "node:fs";
import { formatDuration, formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	ChatTranscriptBuilder,
	type ChatTranscriptHookMessageView,
	type ChatTranscriptMessageView,
} from "../chat/chat-transcript-builder";
import type { SessionMessageEntryLike } from "../chat/transcript-entry";
import { formatContextUsage } from "../chrome/context-thresholds";
import { Editor } from "../components/editor";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import type { ScrollViewportState } from "../host/elements/scroll";
import { matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { matchesKey, type KeyId } from "../keys";
import {
	createEffect,
	createMemo,
	createSignal,
	fromSnapshots,
	onCleanup,
	useClock,
	useTheme,
	type JSX,
} from "../reactive";
import { getEditorTheme } from "../theme/theme";
import type { TUI } from "../tui";
import type { AgentHubRemote } from "./agent-hub";
import type { AgentHubRegistry, AgentLifecycleLike, AgentRecordLike, AgentStatus } from "./agent-hub-types";
import type { SessionObserverRegistry } from "./session-observer-registry";

export type AgentTranscriptEntry = SessionMessageEntryLike | { type: "model_change"; model: string };
export interface AgentTranscriptSource {
	fs: Pick<typeof fs, "openSync" | "closeSync" | "readSync" | "readFileSync" | "statSync">;
	parseEntries(text: string): AgentTranscriptEntry[];
}
export interface AgentTranscriptViewerDeps {
	agentId: string;
	transcript: AgentTranscriptSource;
	initialEntryId?: string;
	registry: AgentHubRegistry;
	remote?: AgentHubRemote;
	observers?: SessionObserverRegistry;
	lifecycle?: () => AgentLifecycleLike;
	getMessageView?: (customType: string) => ChatTranscriptMessageView | undefined;
	getHookMessageView?: (customType: string) => ChatTranscriptHookMessageView | undefined;
	linkTargets?: ReadonlyMap<string, string>;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandKeys: KeyId[];
	hubKeys: KeyId[];
	onClose(): void;
	onHubClose(): void;
}

const POLL_MS = 250;
const SENTINEL_BYTES = 4096;

interface LocalTranscriptSentinel {
	offset: number;
	bytes: Buffer;
}

interface LocalTranscriptState {
	path: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	offset: number;
	pending: string;
	sentinels: LocalTranscriptSentinel[];
}

function readFileRangeSync(source: AgentTranscriptSource["fs"], file: string, offset: number, length: number): Buffer {
	if (length <= 0) return Buffer.alloc(0);
	const descriptor = source.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		const bytesRead = source.readSync(descriptor, buffer, 0, length, offset);
		return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
	} finally {
		source.closeSync(descriptor);
	}
}

function sentinelOffsets(size: number): number[] {
	if (size <= 0) return [];
	const length = Math.min(SENTINEL_BYTES, size);
	return [...new Set([0, Math.max(0, Math.floor((size - length) / 2)), Math.max(0, size - length)])];
}

function sentinelsFromBuffer(buffer: Buffer): LocalTranscriptSentinel[] {
	const length = Math.min(SENTINEL_BYTES, buffer.byteLength);
	return sentinelOffsets(buffer.byteLength).map(offset => ({
		offset,
		bytes: Buffer.from(buffer.subarray(offset, offset + length)),
	}));
}

function sentinelsFromFile(source: AgentTranscriptSource["fs"], file: string, size: number): LocalTranscriptSentinel[] {
	const length = Math.min(SENTINEL_BYTES, size);
	return sentinelOffsets(size).map(offset => ({ offset, bytes: readFileRangeSync(source, file, offset, length) }));
}

function statusColor(status: AgentStatus): "success" | "accent" | "muted" | "error" {
	switch (status) {
		case "running":
			return "success";
		case "idle":
			return "accent";
		case "parked":
			return "muted";
		case "aborted":
			return "error";
	}
}

/** Fullscreen, append-aware transcript for a local subagent or remote collab guest. */
export function AgentTranscriptViewerView(props: { readonly deps: AgentTranscriptViewerDeps }): JSX.Element {
	const builder = new ChatTranscriptBuilder({
		getMessageView: props.deps.getMessageView,
		getHookMessageView: props.deps.getHookMessageView,
		hideThinkingBlock: props.deps.hideThinkingBlock,
		proseOnlyThinking: props.deps.proseOnlyThinking,
		linkTargets: props.deps.linkTargets,
		promptZones: false,
	});
	const theme = useTheme();
	const records = fromSnapshots(
		() => props.deps.registry.list(),
		listener => props.deps.registry.onChange(listener),
		() => false,
	);
	const observed = fromSnapshots(
		() => props.deps.observers?.getSession(props.deps.agentId)?.progress,
		listener => props.deps.observers?.onChange(listener) ?? (() => {}),
		() => false,
	);
	const now = useClock("second");
	const [model, setModel] = createSignal<string>();
	const [notice, setNotice] = createSignal<string>();
	const [remoteError, setRemoteError] = createSignal<string>();
	const [remoteUnavailable, setRemoteUnavailable] = createSignal(false);
	const [hasRemoteData, setHasRemoteData] = createSignal(false);
	const [viewport, setViewport] = createSignal<ScrollViewportState>({ offset: 0, totalRows: 0, height: 0, width: 0 });
	const [manualOffset, setManualOffset] = createSignal(0);
	const [followingTail, setFollowingTail] = createSignal(true);
	const [expanded, setExpanded] = createSignal(false);
	const record = (): AgentRecordLike | undefined => records().find(candidate => candidate.id === props.deps.agentId);

	let localState: LocalTranscriptState | undefined;
	let localUnavailable = "";
	let remoteBytes = 0;
	let remoteFetchInFlight = false;
	let remoteToken = 0;
	let disposed = false;
	let initialEntryId = props.deps.initialEntryId;
	const editor = createEditor();

	function createEditor(): Editor | undefined {
		const current = record();
		if (!current || current.kind === "advisor" || current.status === "aborted") return undefined;
		if (!props.deps.remote && !props.deps.lifecycle) return undefined;
		const input = new Editor(getEditorTheme());
		input.setMaxHeight(4);
		input.onSubmit = submit;
		return input;
	}

	function clearLocal(reason: string): void {
		if (!localState && localUnavailable === reason) return;
		localState = undefined;
		localUnavailable = reason;
		setModel(undefined);
		builder.reset();
	}

	function extractMessages(entries: readonly AgentTranscriptEntry[]): SessionMessageEntryLike[] {
		const messages: SessionMessageEntryLike[] = [];
		for (const entry of entries) {
			if (entry.type === "message") {
				messages.push(entry);
				if (!model() && entry.message.role === "assistant") setModel(entry.message.model);
			} else {
				setModel(entry.model);
			}
		}
		return messages;
	}

	function rebuild(entries: readonly SessionMessageEntryLike[]): void {
		builder.rebuild(entries);
	}

	function append(entries: readonly SessionMessageEntryLike[]): void {
		if (entries.length === 0) return;
		builder.append(entries);
	}

	function canAppendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): boolean {
		if (state.path !== sessionFile || state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.size)
			return false;
		for (const sentinel of state.sentinels) {
			let current: Buffer;
			try {
				current = readFileRangeSync(
					props.deps.transcript.fs,
					sessionFile,
					sentinel.offset,
					sentinel.bytes.byteLength,
				);
			} catch {
				return false;
			}
			if (!current.equals(sentinel.bytes)) return false;
		}
		return true;
	}

	function loadLocalFull(sessionFile: string, stat: fs.Stats): void {
		let data: Buffer;
		try {
			data = props.deps.transcript.fs.readFileSync(sessionFile);
		} catch {
			return;
		}
		const text = data.toString("utf-8");
		const lastNewline = text.lastIndexOf("\n");
		const complete = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
		let parsed: SessionMessageEntryLike[];
		try {
			setModel(undefined);
			parsed = extractMessages(props.deps.transcript.parseEntries(complete));
			setNotice(undefined);
		} catch (cause) {
			localState = undefined;
			setNotice(cause instanceof Error ? cause.message : String(cause));
			return;
		}
		let post = stat;
		try {
			post = props.deps.transcript.fs.statSync(sessionFile);
		} catch {
			// The initial stat is still a sound identity snapshot when the file vanishes mid-read.
		}
		localUnavailable = "";
		localState = {
			path: sessionFile,
			dev: post.dev,
			ino: post.ino,
			size: data.byteLength,
			mtimeMs: post.mtimeMs,
			offset: data.byteLength,
			pending: lastNewline >= 0 ? text.slice(lastNewline + 1) : text,
			sentinels: sentinelsFromBuffer(data),
		};
		rebuild(parsed);
	}

	function appendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): void {
		let chunk: string;
		try {
			chunk = readFileRangeSync(
				props.deps.transcript.fs,
				sessionFile,
				state.offset,
				stat.size - state.offset,
			).toString("utf-8");
		} catch {
			loadLocalFull(sessionFile, stat);
			return;
		}
		const combined = state.pending + chunk;
		const lastNewline = combined.lastIndexOf("\n");
		const complete = lastNewline >= 0 ? combined.slice(0, lastNewline + 1) : "";
		let sentinels: LocalTranscriptSentinel[];
		let parsed: SessionMessageEntryLike[];
		try {
			sentinels = sentinelsFromFile(props.deps.transcript.fs, sessionFile, stat.size);
			parsed = complete.length > 0 ? extractMessages(props.deps.transcript.parseEntries(complete)) : [];
			setNotice(undefined);
		} catch (cause) {
			setNotice(cause instanceof Error ? cause.message : String(cause));
			return;
		}
		localState = {
			...state,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			offset: stat.size,
			pending: lastNewline >= 0 ? combined.slice(lastNewline + 1) : combined,
			sentinels,
		};
		append(parsed);
	}

	function fetchRemote(): void {
		const remote = props.deps.remote;
		if (!remote || remoteFetchInFlight || disposed) return;
		const fromByte = remoteBytes;
		const token = ++remoteToken;
		remoteFetchInFlight = true;
		void remote
			.readTranscript(props.deps.agentId, fromByte)
			.then(result => {
				if (token !== remoteToken || disposed) return;
				remoteFetchInFlight = false;
				if (!result) {
					if (!hasRemoteData() && !remoteUnavailable()) {
						setRemoteUnavailable(true);
					}
					return;
				}
				if (result.error) {
					setRemoteError(result.error);
					setHasRemoteData(true);
					setRemoteUnavailable(false);
					return;
				}
				if (result.newSize < fromByte) {
					remoteBytes = 0;
					setRemoteError(undefined);
					setHasRemoteData(false);
					setRemoteUnavailable(false);
					setModel(undefined);
					builder.reset();
					fetchRemote();
					return;
				}
				setHasRemoteData(true);
				setRemoteUnavailable(false);
				setRemoteError(undefined);
				const lastNewline = result.text.lastIndexOf("\n");
				if (lastNewline >= 0) {
					const complete = result.text.slice(0, lastNewline + 1);
					let parsed: SessionMessageEntryLike[];
					try {
						parsed = extractMessages(props.deps.transcript.parseEntries(complete));
					} catch (cause) {
						setRemoteError(cause instanceof Error ? cause.message : String(cause));
						return;
					}
					remoteBytes = fromByte + Buffer.byteLength(complete, "utf-8");
					append(parsed);
					if (parsed.length > 0) return;
				}
			})
			.catch(cause => {
				if (token !== remoteToken || disposed) return;
				remoteFetchInFlight = false;
				setRemoteError(cause instanceof Error ? cause.message : String(cause));
			});
	}

	function refresh(): void {
		if (disposed) return;
		if (props.deps.remote) {
			fetchRemote();
			return;
		}
		const sessionFile = record()?.sessionFile;
		if (!sessionFile) {
			clearLocal("none");
			return;
		}
		let stat: fs.Stats;
		try {
			stat = props.deps.transcript.fs.statSync(sessionFile);
		} catch {
			clearLocal("missing");
			return;
		}
		const state = localState;
		if (state && canAppendLocal(sessionFile, stat, state)) {
			if (stat.size === state.size && stat.mtimeMs === state.mtimeMs) return;
			if (stat.size > state.size) {
				appendLocal(sessionFile, stat, state);
				return;
			}
		}
		loadLocalFull(sessionFile, stat);
	}

	function submit(text: string): void {
		const trimmed = text.trim();
		editor?.setText("");
		if (!trimmed) return;
		setNotice(undefined);
		const remote = props.deps.remote;
		if (remote) {
			remote.chat(props.deps.agentId, trimmed);
			return;
		}
		const lifecycle = props.deps.lifecycle;
		if (!lifecycle) return;
		void lifecycle()
			.ensureLive(props.deps.agentId)
			.then(session => session.prompt(trimmed, { streamingBehavior: "steer" }))
			.catch(cause => {
				if (disposed) return;
				setNotice(cause instanceof Error ? cause.message : String(cause));
			});
	}

	function scroll(delta: number): void {
		if (delta === 0) return;
		const current = viewport();
		const maximum = Math.max(0, current.totalRows - current.height);
		const next = Math.max(0, Math.min(maximum, current.offset + delta));
		setManualOffset(next);
		setFollowingTail(next >= maximum);
	}

	function scrollToTop(): void {
		setFollowingTail(false);
		setManualOffset(0);
	}

	function scrollToBottom(): void {
		setFollowingTail(true);
		setManualOffset(Math.max(0, viewport().totalRows - viewport().height));
	}

	function onViewport(next: ScrollViewportState): void {
		setViewport(next);
		if (!initialEntryId) return;
		const row = builder.rowForEntry(initialEntryId);
		if (row === undefined) return;
		initialEntryId = undefined;
		setFollowingTail(false);
		setManualOffset(row);
	}

	function handleScroll(data: string): boolean {
		if (matchesKey(data, "pageUp")) {
			scroll(-5);
			return true;
		}
		if (matchesKey(data, "pageDown")) {
			scroll(5);
			return true;
		}
		if (matchesKey(data, "home") || data === "g") {
			scrollToTop();
			return true;
		}
		if (matchesKey(data, "end") || data === "G") {
			scrollToBottom();
			return true;
		}
		if (matchesKey(data, "j") || matchesSelectDown(data)) {
			scroll(1);
			return true;
		}
		if (matchesKey(data, "k") || matchesSelectUp(data)) {
			scroll(-1);
			return true;
		}
		return false;
	}

	function handleViewerKey(event: HostKeyEvent, editorOwnsInput: boolean): boolean {
		if (props.deps.hubKeys.some(key => matchesKey(event.data, key))) {
			props.deps.onHubClose();
			return true;
		}
		if (matchesKey(event.data, "escape")) {
			if (editorOwnsInput && editor?.getText().trim()) {
				editor.setText("");
			} else {
				props.deps.onClose();
			}
			return true;
		}
		if (props.deps.expandKeys.some(key => matchesKey(event.data, key))) {
			setExpanded(previous => {
				const next = !previous;
				builder.setExpanded(next);
				return next;
			});
			return true;
		}
		if (!editorOwnsInput || editor?.getText().trim() === "") return handleScroll(event.data);
		return false;
	}

	const onEditorKey = (event: HostKeyEvent): void => {
		if (!handleViewerKey(event, true)) return;
		event.preventDefault();
		event.stopPropagation();
	};
	const onViewerKey = (event: HostKeyEvent): void => {
		if (!handleViewerKey(event, false)) return;
		event.preventDefault();
		event.stopPropagation();
	};
	const onMouse = (event: HostMouseEvent): void => {
		if (event.wheel === 0) return;
		scroll(event.wheel * 3);
		event.preventDefault();
	};

	const stats = createMemo(() => {
		now();
		const progress = observed();
		if (!progress) return undefined;
		const values: string[] = [];
		if (progress.contextTokens && progress.contextTokens > 0) {
			values.push(
				progress.contextWindow && progress.contextWindow > 0
					? formatContextUsage((progress.contextTokens / progress.contextWindow) * 100, progress.contextWindow)
					: formatNumber(progress.contextTokens),
			);
		}
		if (progress.durationMs > 0) values.push(formatDuration(progress.durationMs));
		const toolStat =
			progress.toolCount > 0 ? `${formatNumber(progress.toolCount)} ${theme.symbol("icon.extensionTool")}` : "";
		const metrics =
			values.length > 0 || toolStat ? [toolStat, ...values].filter(Boolean).join(theme.symbol("sep.dot")) : "";
		return metrics || progress.cost > 0
			? { metrics, cost: progress.cost > 0 ? `$${progress.cost.toFixed(2)}` : undefined }
			: undefined;
	});
	const placeholder = (): string => {
		if (props.deps.remote) {
			if (remoteError()) return sanitizeText(remoteError()!);
			if (remoteUnavailable()) return "Transcript lives on the host — not available.";
			return hasRemoteData() ? "No messages yet." : "Loading transcript from host…";
		}
		return record()?.sessionFile ? "No messages yet." : "No session file available yet.";
	};
	const shownNotice = () => notice() ?? (remoteError() && !builder.isEmpty ? remoteError() : undefined);

	createEffect(() => {
		records();
		refresh();
	});
	const pollTimer = setInterval(refresh, POLL_MS);
	pollTimer.unref?.();
	onCleanup(() => {
		disposed = true;
		remoteToken++;
		clearInterval(pollTimer);
		builder.dispose();
	});

	return (
		<box onKey={onViewerKey} onMouse={onMouse} tabIndex={0}>
			<frame height="fill" paddingX={1} paddingY={0} borderPolicy="always" renderEmpty>
				<stack height="fill">
					<text color="accent" wrap="clip">
						Agent Hub {theme.symbol("sep.dot")}
						{props.deps.agentId}
					</text>
					{record()?.status && record()?.kind ? (
						<row>
							<text bold>{props.deps.agentId}</text>
							<text> </text>
							<text color={statusColor(record()!.status)}>{record()!.status}</text>
							<text color="dim">
								{" "}
								{record()!.parentId
									? `${record()!.kind}${theme.symbol("sep.dot")}of ${record()!.parentId}`
									: record()!.kind}
							</text>
							{model() ? (
								<text color="muted">
									{theme.symbol("sep.dot")}
									{model()}
								</text>
							) : null}
						</row>
					) : null}
					<hr variant="frame" />
					<scroll
						grow={1}
						offset={followingTail() ? undefined : manualOffset()}
						followTail={followingTail()}
						shrinkToFit={false}
						trackColor="dim"
						thumbColor="accent"
						onViewport={onViewport}
					>
						{builder.isEmpty ? (
							<text color="dim" wrap="clip">
								{" "}
								{placeholder()}
							</text>
						) : (
							builder.view()
						)}
					</scroll>
					{shownNotice() ? (
						<text color="error" wrap="clip">
							{sanitizeText(shownNotice()!)}
						</text>
					) : null}
					{editor ? <editor editor={editor} tabIndex={0} onKey={onEditorKey} /> : null}
					{stats() ? (
						<row>
							{stats()!.metrics ? <text color="dim">{stats()!.metrics}</text> : null}
							{stats()!.metrics && stats()!.cost ? <text color="dim">{theme.symbol("sep.dot")}</text> : null}
							{stats()!.cost ? <text color="statusLineCost">{stats()!.cost}</text> : null}
						</row>
					) : null}
					<text color="dim" wrap="clip">
						{editor
							? `Enter:send  Esc:close  ${props.deps.expandKeys[0] ?? "ctrl+o"}:expand  empty input → j/k:scroll  g/G:top/bottom`
							: `Esc:close  ${props.deps.expandKeys[0] ?? "ctrl+o"}:expand  j/k:scroll  g/G:top/bottom`}
					</text>
				</stack>
			</frame>
		</box>
	);
}

export function openAgentTranscriptViewerOverlay(tui: TUI, deps: AgentTranscriptViewerDeps): OverlayDisposer {
	return mountOverlay(tui, () => (
		<Portal to="overlay" fullscreen mouseTracking>
			<AgentTranscriptViewerView deps={deps} />
		</Portal>
	));
}
