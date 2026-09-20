import type { ChatTranscriptHookMessageView, ChatTranscriptMessageView } from "../chat/chat-transcript-builder";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import { matchesKey, type KeyId } from "../keys";
import { For, createEffect, createMemo, createSignal, fromSnapshots, onCleanup, useClock, type JSX } from "../reactive";
import type { TUI } from "../tui";
import { USER_INTERRUPT_LABEL } from "../chat/messages";
import { fuzzyMatch } from "../fuzzy";
import {
	activityRowsFromProgress,
	type AgentActivityKind,
	type AgentActivityRow,
	type AgentActivitySource,
} from "./agent-activity";
import {
	AgentHubActivityRowView,
	AgentHubInspectorView,
	AgentHubRosterEntryView,
	AgentHubRosterSummaryView,
	type AgentRoleDisplay,
} from "./agent-hub-renderer";
import {
	aggregateMetrics,
	progressMetrics,
	projectAgentTree,
	STATUS_ORDER,
	type AgentMetrics,
} from "./agent-hub-projection";
import {
	MAIN_AGENT_ID,
	type AgentHubRegistry,
	type AgentLifecycleLike,
	type AgentRecordLike,
	type AgentStatus,
	type IrcBusLike,
} from "./agent-hub-types";
import { openAgentTranscriptViewerOverlay, type AgentTranscriptSource } from "./agent-transcript-viewer";
import type { ObservableSession, SessionObserverRegistry } from "./session-observer-registry";

/** Two-pane mode needs a useful roster and a readable inspector. */
const SPLIT_MIN_WIDTH = 96;
const ROSTER_MIN_WIDTH = 48;
const DETAIL_MIN_WIDTH = 34;
const LEFT_TAP_WINDOW_MS = 500;

type ActivityFilter = "all" | "errors" | "responses" | "tools";
type ActivityScope = "all" | "agent" | "subtree";
type HubViewMode = "roster" | "tree";

export type AgentHubSection = "agents" | "activity";
export interface AgentHubRemoteTranscript {
	text: string;
	newSize: number;
	error?: string;
}
export interface AgentHubRemote {
	chat(id: string, text: string): void;
	kill(id: string): void;
	revive(id: string): void;
	readTranscript(id: string, fromByte: number): Promise<AgentHubRemoteTranscript | null>;
}
export interface AgentHubDeps<TRecord extends AgentRecordLike = AgentRecordLike> {
	observers: SessionObserverRegistry;
	getRoleInfo?: (role: string) => AgentRoleDisplay | undefined;
	transcript: AgentTranscriptSource;
	loadPersisted(shouldContinue: () => boolean): Promise<void>;
	hubKeys: KeyId[];
	onDone(): void;
	registry: AgentHubRegistry<TRecord>;
	lifecycle(): AgentLifecycleLike<TRecord>;
	irc: IrcBusLike;
	ui?: TUI;
	getMessageView?: (customType: string) => ChatTranscriptMessageView | undefined;
	getHookMessageView?: (customType: string) => ChatTranscriptHookMessageView | undefined;
	linkTargets?: ReadonlyMap<string, string>;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandKeys?: KeyId[];
	focusAgent?: (id: string) => Promise<void>;
	sessionFile?: string | null;
	initialSection?: AgentHubSection;
	activity: AgentActivitySource;
	manageActivityLive?: boolean;
	remote?: AgentHubRemote;
}
export interface AgentHubViewProps<TRecord extends AgentRecordLike = AgentRecordLike> {
	readonly deps: AgentHubDeps<TRecord>;
}

function emptyStatusCounts(): Record<AgentStatus, number> {
	return { running: 0, idle: 0, parked: 0, aborted: 0 };
}

function metricsFor<TRecord extends AgentRecordLike>(
	ref: TRecord,
	observed: ObservableSession | undefined,
	sessionMetrics: WeakMap<object, { metrics: AgentMetrics | undefined }>,
): AgentMetrics | undefined {
	if (observed?.progress) return progressMetrics(observed);
	if (ref.history?.metrics) return ref.history.metrics;
	return ref.session ? sessionMetrics.get(ref.session)?.metrics : undefined;
}

function activityKinds(filter: ActivityFilter): ReadonlySet<AgentActivityKind> | undefined {
	if (filter === "responses") return new Set(["response"]);
	if (filter === "tools") return new Set(["tool"]);
	return undefined;
}

function rosterFooter(
	viewMode: HubViewMode,
	query: string,
	editing: boolean,
	showingNarrowDetails: boolean,
	wide: boolean,
): string {
	const filter = query ? `/${query}${editing ? "▌" : ""}  ·  ` : "";
	const nextView = viewMode === "roster" ? "by parent" : "flat";
	if (showingNarrowDetails) {
		return `${filter}1:agents  2:activity  Tab:roster  PgUp/PgDn:scroll  Enter:open  t:${nextView}  Esc:roster`;
	}
	if (!wide) return `${filter}j/k:select  Enter:open  t:${nextView}  Tab:details  r/x:manage  Esc:close`;
	return `${filter}1:agents  2:activity  j/k/wheel:select  PgUp/PgDn:details  Enter/click:open  t:${nextView}  r:revive  x:kill  Esc:close`;
}

/**
 * Live Agent Hub backed by the registry and observer snapshots. It retains the
 * old hub's stable operational order, tree projection, activity drilldown, and
 * lifecycle actions while the host owns all terminal layout and clipping.
 */
export function AgentHubView<TRecord extends AgentRecordLike>(props: AgentHubViewProps<TRecord>): JSX.Element {
	const registrySnapshot = fromSnapshots(
		() => props.deps.registry.list(),
		listener => props.deps.registry.onChange(listener),
		() => false,
	);
	const observerSnapshot = fromSnapshots(
		() => props.deps.observers.getSessions(),
		listener => props.deps.observers.onChange(() => listener()),
		() => false,
	);
	const now = useClock("second");
	const [section, setSection] = createSignal<AgentHubSection>(props.deps.initialSection ?? "agents");
	const [viewMode, setViewMode] = createSignal<HubViewMode>("roster");
	const [agentFilter, setAgentFilter] = createSignal("");
	const [agentFilterEditing, setAgentFilterEditing] = createSignal(false);
	const [selectedId, setSelectedId] = createSignal<string>();
	const [hoveredId, setHoveredId] = createSignal<string>();
	const [narrowDetailsOpen, setNarrowDetailsOpen] = createSignal(false);
	const [detailOffset, setDetailOffset] = createSignal(0);
	const [notice, setNotice] = createSignal<string>();
	const [loadingPersisted, setLoadingPersisted] = createSignal(
		!props.deps.remote && Boolean(props.deps.sessionFile?.endsWith(".jsonl")),
	);
	const [activityFilter, setActivityFilter] = createSignal<ActivityFilter>("all");
	const [activityScope, setActivityScope] = createSignal<ActivityScope>("all");
	const [activitySearch, setActivitySearch] = createSignal("");
	const [activitySearchEditing, setActivitySearchEditing] = createSignal(false);
	const [activityFollow, setActivityFollow] = createSignal(true);
	const [selectedActivityId, setSelectedActivityId] = createSignal<string>();
	const [activityVersion, setActivityVersion] = createSignal(0);
	const orderByRecord = new Map<TRecord, number>();
	const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
	const activityStamp = new Map<string, string>();
	let nextOrder = 0;
	let activityGeneration = 0;
	let lastLeftTap = 0;
	let alive = true;
	let transcriptOverlay: OverlayDisposer | undefined;

	const observedById = createMemo(() => new Map(observerSnapshot().map(session => [session.id, session])));
	const rosterRows = createMemo(() => {
		const refs = registrySnapshot().filter(ref => ref.id !== MAIN_AGENT_ID);
		const live = new Set(refs);
		for (const ref of orderByRecord.keys()) if (!live.has(ref)) orderByRecord.delete(ref);
		let ordered: TRecord[];
		if (orderByRecord.size === 0) {
			ordered = [...refs].sort(
				(left, right) =>
					STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
					right.lastActivity - left.lastActivity ||
					left.id.localeCompare(right.id),
			);
			if (!loadingPersisted() && ordered.length > 0) {
				for (const ref of ordered) orderByRecord.set(ref, nextOrder++);
			}
		} else {
			ordered = [...refs].sort(
				(left, right) =>
					(orderByRecord.get(left) ?? Number.MAX_SAFE_INTEGER) -
					(orderByRecord.get(right) ?? Number.MAX_SAFE_INTEGER),
			);
			for (const ref of ordered) if (!orderByRecord.has(ref)) orderByRecord.set(ref, nextOrder++);
		}
		const query = agentFilter().trim();
		return query ? ordered.filter(ref => fuzzyMatch(query, `${ref.id} ${ref.displayName}`).matches) : ordered;
	});
	const projection = createMemo(() => {
		const rows = rosterRows();
		if (viewMode() === "tree") {
			const tree = projectAgentTree(rows);
			let maxDepth = 0;
			for (const depth of tree.depthById.values()) maxDepth = Math.max(maxDepth, depth);
			return { rows: tree.rows, tree: { ...tree, maxDepth } };
		}
		return {
			rows,
			tree: {
				depthById: new Map<string, number>(),
				parentById: new Map<string, string>(),
				lastSiblingById: new Map<string, boolean>(),
				maxDepth: 0,
			},
		};
	});
	const rows = () => projection().rows;
	const selectedIndex = createMemo(() => {
		const index = rows().findIndex(ref => ref.id === selectedId());
		return index < 0 ? 0 : index;
	});
	const selected = createMemo(() => rows()[selectedIndex()]);
	const childrenByParent = createMemo(() => {
		const children = new Map<string, TRecord[]>();
		for (const ref of rosterRows()) {
			const parent = ref.parentId ?? MAIN_AGENT_ID;
			const siblings = children.get(parent);
			if (siblings) siblings.push(ref);
			else children.set(parent, [ref]);
		}
		return children;
	});
	const statusCounts = createMemo(() => {
		const counts = emptyStatusCounts();
		for (const ref of rosterRows()) counts[ref.status]++;
		return counts;
	});
	const aggregate = createMemo(() => {
		now();
		const observed = observedById();
		return aggregateMetrics({
			rows: rosterRows(),
			observedById: observed,
			metricsFor: (ref, entry) => metricsFor(ref, entry, sessionMetrics),
			fallbackStatsSession: (ref, entry) => (entry?.progress ? undefined : (ref.session ?? undefined)),
			sessionMetrics,
			refreshFallback: true,
		}).metrics;
	});
	const metrics = (ref: TRecord): AgentMetrics | undefined =>
		metricsFor(ref, observedById().get(ref.id), sessionMetrics);
	const activityAgentIds = createMemo(() => {
		const scope = activityScope();
		if (scope === "all") return undefined;
		const agent = selected();
		if (!agent) return new Set<string>();
		const ids = new Set([agent.id]);
		if (scope === "agent") return ids;
		const queue = [agent.id];
		for (let index = 0; index < queue.length; index++) {
			for (const child of childrenByParent().get(queue[index]!) ?? []) {
				if (ids.has(child.id)) continue;
				ids.add(child.id);
				queue.push(child.id);
			}
		}
		return ids;
	});
	const activityRows = createMemo(() => {
		activityVersion();
		let values = props.deps.activity.query({
			agentIds: activityAgentIds(),
			kinds: activityKinds(activityFilter()),
			search: activitySearch(),
			limit: 2_000,
		});
		if (activityFilter() === "errors") values = values.filter(row => row.status === "error");
		return values;
	});
	const selectedActivityIndex = createMemo(() => {
		const index = activityRows().findIndex(activity => activity.id === selectedActivityId());
		return index < 0 ? Math.max(0, activityRows().length - 1) : index;
	});

	const selectRow = (index: number): void => {
		const ref = rows()[Math.max(0, Math.min(index, rows().length - 1))];
		if (!ref) return;
		if (ref.id !== selectedId()) setDetailOffset(0);
		setSelectedId(ref.id);
	};
	const selectActivity = (index: number): void => {
		const row = activityRows()[Math.max(0, Math.min(index, activityRows().length - 1))];
		if (row) setSelectedActivityId(row.id);
	};
	const switchSection = (next: AgentHubSection): void => {
		if (next === section()) return;
		setSection(next);
		setHoveredId(undefined);
		setNarrowDetailsOpen(false);
	};
	const setErrorNotice = (cause: unknown): void => {
		setNotice(cause instanceof Error ? cause.message : String(cause));
	};
	const closeTranscript = (): void => {
		const overlay = transcriptOverlay;
		transcriptOverlay = undefined;
		overlay?.dispose();
	};
	const openTranscript = (id: string, entryId?: string): void => {
		if (!props.deps.registry.get(id) || !props.deps.ui) return;
		closeTranscript();
		setNotice(undefined);
		transcriptOverlay = openAgentTranscriptViewerOverlay(props.deps.ui, {
			agentId: id,
			transcript: props.deps.transcript,
			initialEntryId: entryId,
			registry: props.deps.registry,
			remote: props.deps.remote,
			observers: props.deps.observers,
			lifecycle: props.deps.remote ? undefined : props.deps.lifecycle,
			getMessageView: props.deps.getMessageView,
			getHookMessageView: props.deps.getHookMessageView,
			linkTargets: props.deps.linkTargets,
			hideThinkingBlock: props.deps.hideThinkingBlock,
			proseOnlyThinking: props.deps.proseOnlyThinking,
			expandKeys: props.deps.expandKeys ?? ["ctrl+o"],
			hubKeys: props.deps.hubKeys,
			onClose: closeTranscript,
			onHubClose: () => {
				closeTranscript();
				props.deps.onDone();
			},
		});
	};
	const activate = (ref: TRecord): void => {
		setNotice(undefined);
		if (ref.kind === "advisor" || ref.status === "aborted" || props.deps.remote || !props.deps.focusAgent) {
			openTranscript(ref.id);
			return;
		}
		void props.deps.focusAgent(ref.id).then(props.deps.onDone).catch(setErrorNotice);
	};
	const reviveSelected = (): void => {
		const ref = selected();
		if (!ref) return;
		if (ref.kind === "advisor") {
			setNotice(`"${ref.id}" is a read-only advisor transcript — nothing to revive.`);
			return;
		}
		if (ref.status !== "parked") {
			setNotice(`Agent "${ref.id}" is ${ref.status} — only parked agents can be revived.`);
			return;
		}
		setNotice(undefined);
		if (props.deps.remote) {
			props.deps.remote.revive(ref.id);
			return;
		}
		void props.deps.lifecycle().ensureLive(ref.id).catch(setErrorNotice);
	};
	const killSelected = (): void => {
		const ref = selected();
		if (!ref) return;
		if (ref.kind === "advisor") {
			setNotice(`"${ref.id}" is a read-only advisor transcript — cannot be killed.`);
			return;
		}
		setNotice(undefined);
		if (props.deps.remote) {
			props.deps.remote.kill(ref.id);
			return;
		}
		void (async () => {
			try {
				if (ref.status === "running" && ref.session) await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
				await props.deps.lifecycle().release(ref.id, ref, { tombstone: true });
			} catch (cause) {
				setErrorNotice(cause);
			}
		})();
	};
	const editActivitySearch = (data: string): boolean => {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "\r" || data === "\n") {
			setActivitySearchEditing(false);
			return true;
		}
		if (matchesKey(data, "backspace")) {
			setActivitySearch(value => value.slice(0, -1));
			return true;
		}
		if (data.length === 1 && data >= " " && data !== "\u007f") {
			setActivitySearch(value => value + data);
			return true;
		}
		return true;
	};
	const editAgentFilter = (data: string): boolean => {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "\r" || data === "\n") {
			setAgentFilterEditing(false);
			if (matchesKey(data, "escape")) setAgentFilter("");
			return true;
		}
		if (matchesKey(data, "backspace")) {
			setAgentFilter(value => value.slice(0, -1));
			return true;
		}
		if (data.length === 1 && data >= " " && data !== "\u007f") {
			setAgentFilter(value => value + data);
			return true;
		}
		return true;
	};
	const handleActivityKey = (data: string): boolean => {
		if (matchesKey(data, "escape")) {
			if (activitySearch()) setActivitySearch("");
			else props.deps.onDone();
			return true;
		}
		if (matchesKey(data, "left")) {
			switchSection("agents");
			return true;
		}
		if (data === "/") {
			setActivitySearchEditing(true);
			return true;
		}
		if (data === " ") {
			const following = !activityFollow();
			setActivityFollow(following);
			if (following && activityRows().length > 0) selectActivity(activityRows().length - 1);
			return true;
		}
		if (data === "f") {
			const filters: readonly ActivityFilter[] = ["all", "errors", "responses", "tools"];
			setActivityFilter(current => filters[(filters.indexOf(current) + 1) % filters.length]!);
			return true;
		}
		if (data === "s") {
			const scopes: readonly ActivityScope[] = ["all", "agent", "subtree"];
			setActivityScope(current => scopes[(scopes.indexOf(current) + 1) % scopes.length]!);
			return true;
		}
		if (data === "j" || matchesKey(data, "down")) {
			setActivityFollow(false);
			selectActivity(selectedActivityIndex() + 1);
			return true;
		}
		if (data === "k" || matchesKey(data, "up")) {
			setActivityFollow(false);
			selectActivity(selectedActivityIndex() - 1);
			return true;
		}
		if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			const activity = activityRows()[selectedActivityIndex()];
			if (activity) openTranscript(activity.agentId, activity.entryId);
			return true;
		}
		return false;
	};
	const handleRosterKey = (data: string): boolean => {
		const wide = !narrowDetailsOpen();
		if (agentFilterEditing()) return editAgentFilter(data);
		if (matchesKey(data, "escape")) {
			if (agentFilter()) setAgentFilter("");
			else if (!wide && narrowDetailsOpen()) setNarrowDetailsOpen(false);
			else props.deps.onDone();
			return true;
		}
		if (data === "/") {
			setAgentFilterEditing(true);
			return true;
		}
		if ((matchesKey(data, "tab") || data === "\t") && !wide) {
			if (rows().length > 0) setNarrowDetailsOpen(value => !value);
			return true;
		}
		if ((wide || narrowDetailsOpen()) && matchesKey(data, "pageUp")) {
			setDetailOffset(value => Math.max(0, value - 5));
			return true;
		}
		if ((wide || narrowDetailsOpen()) && matchesKey(data, "pageDown")) {
			setDetailOffset(value => value + 5);
			return true;
		}
		if (data === "t") {
			setHoveredId(undefined);
			setViewMode(current => (current === "roster" ? "tree" : "roster"));
			return true;
		}
		if (matchesKey(data, "left")) {
			if (!wide && narrowDetailsOpen()) {
				setNarrowDetailsOpen(false);
				return true;
			}
			const at = performance.now();
			if (at - lastLeftTap < LEFT_TAP_WINDOW_MS) {
				lastLeftTap = 0;
				props.deps.onDone();
			} else lastLeftTap = at;
			return true;
		}
		setHoveredId(undefined);
		if (data === "j" || matchesKey(data, "down")) {
			selectRow(selectedIndex() + 1);
			return true;
		}
		if (data === "k" || matchesKey(data, "up")) {
			selectRow(selectedIndex() - 1);
			return true;
		}
		if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			const ref = selected();
			if (ref) activate(ref);
			return true;
		}
		if (data === "r") {
			reviveSelected();
			return true;
		}
		if (data === "x") {
			killSelected();
			return true;
		}
		return false;
	};
	const handleKey = (event: HostKeyEvent): void => {
		const data = event.data;
		let handled = false;
		if (props.deps.hubKeys.some(key => matchesKey(data, key))) {
			props.deps.onDone();
			handled = true;
		} else if (section() === "activity" && activitySearchEditing()) {
			handled = editActivitySearch(data);
		} else if (data === "1") {
			switchSection("agents");
			handled = true;
		} else if (data === "2") {
			switchSection("activity");
			handled = true;
		} else {
			handled = section() === "activity" ? handleActivityKey(data) : handleRosterKey(data);
		}
		if (handled) {
			event.preventDefault();
			event.stopPropagation();
		}
	};
	const mouseRoster =
		(index: number, ref: TRecord) =>
		(event: HostMouseEvent): void => {
			if (event.action === "wheel") {
				selectRow(selectedIndex() + event.wheel);
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (event.action === "move") {
				setHoveredId(ref.id);
				event.stopPropagation();
				return;
			}
			if (event.action === "down" && event.button === 0) {
				setHoveredId(ref.id);
				selectRow(index);
				activate(ref);
				event.preventDefault();
				event.stopPropagation();
			}
		};
	const mouseActivity =
		(index: number, activity: AgentActivityRow) =>
		(event: HostMouseEvent): void => {
			if (event.action === "wheel") {
				setActivityFollow(false);
				selectActivity(selectedActivityIndex() + event.wheel);
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (event.action === "down" && event.button === 0) {
				if (index === selectedActivityIndex()) openTranscript(activity.agentId, activity.entryId);
				else {
					setActivityFollow(false);
					selectActivity(index);
				}
				event.preventDefault();
				event.stopPropagation();
			}
		};
	const outerMouse = (event: HostMouseEvent): void => {
		if (event.action !== "wheel") return;
		if (section() === "agents") selectRow(selectedIndex() + event.wheel);
		else {
			setActivityFollow(false);
			selectActivity(selectedActivityIndex() + event.wheel);
		}
		event.preventDefault();
	};

	createEffect(() => {
		const list = rows();
		if (list.length === 0) {
			setSelectedId(undefined);
			return;
		}
		if (!list.some(ref => ref.id === selectedId())) {
			setSelectedId(list[Math.min(selectedIndex(), list.length - 1)]!.id);
			setDetailOffset(0);
		}
	});
	createEffect(() => {
		const list = activityRows();
		if (list.length === 0) {
			setSelectedActivityId(undefined);
			return;
		}
		if (activityFollow()) {
			setSelectedActivityId(list[list.length - 1]!.id);
			return;
		}
		if (!list.some(activity => activity.id === selectedActivityId())) setSelectedActivityId(list[0]!.id);
	});
	createEffect(() => {
		const refs = rosterRows();
		const observed = observedById();
		if (props.deps.manageActivityLive ?? true) {
			const live = new Set<string>();
			for (const ref of refs) {
				const entry = observed.get(ref.id);
				if (!entry?.progress) continue;
				live.add(ref.id);
				props.deps.activity.setLive(ref.id, activityRowsFromProgress(entry.progress, entry.lastUpdate));
			}
			for (const ref of refs) if (!live.has(ref.id)) props.deps.activity.setLive(ref.id, []);
		}
		const pending: Promise<void>[] = [];
		for (const ref of refs) {
			if (!props.deps.remote && !ref.sessionFile) continue;
			const stamp = `${ref.sessionFile ?? ""}:${ref.lastActivity}`;
			if (activityStamp.get(ref.id) === stamp) continue;
			activityStamp.set(ref.id, stamp);
			pending.push(props.deps.activity.sync(ref.id, ref.sessionFile));
		}
		const generation = ++activityGeneration;
		setActivityVersion(value => value + 1);
		if (pending.length > 0) {
			void Promise.all(pending)
				.then(() => {
					if (alive && generation === activityGeneration) setActivityVersion(value => value + 1);
				})
				.catch(() => {});
		}
	});
	if (!props.deps.remote) {
		void props.deps
			.loadPersisted(() => alive)
			.catch(() => {})
			.finally(() => {
				if (alive) setLoadingPersisted(false);
			});
	}
	onCleanup(() => {
		alive = false;
		closeTranscript();
	});

	const rosterPane = () => {
		const list = rows();
		const entries = (
			<tree guides={viewMode() === "tree"}>
				<For each={list}>
					{(ref, index) => (
						<AgentHubRosterEntryView
							ref={ref}
							observed={observedById().get(ref.id)}
							metrics={metrics(ref)}
							selected={index() === selectedIndex()}
							hovered={hoveredId() === ref.id}
							viewMode={viewMode()}
							tree={projection().tree}
							children={childrenByParent().get(ref.id) ?? []}
							unread={props.deps.irc.unreadCount(ref.id)}
							now={now()}
							getRoleInfo={props.deps.getRoleInfo}
							onMouse={mouseRoster(index(), ref)}
						/>
					)}
				</For>
			</tree>
		);
		return (
			<stack height="fill">
				<AgentHubRosterSummaryView
					viewMode={viewMode()}
					statusCounts={statusCounts()}
					aggregate={aggregate()}
					rowCount={rosterRows().length}
				/>
				<scroll grow={1} followTail={false}>
					{list.length === 0 ? (
						loadingPersisted() ? (
							<text color="accent">Loading saved agents…</text>
						) : (
							<stack>
								<text color="muted" bold>
									○ No agents in this session
								</text>
								<text color="dim" wrap="word">
									Finished, parked, and killed subagents remain with the session that created them.
								</text>
								<text color="dim" wrap="word">
									Resume that session with omp-dev --continue, or spawn a task here.
								</text>
							</stack>
						)
					) : (
						entries
					)}
					{notice() ? (
						<text color="error" wrap="word">
							{notice()}
						</text>
					) : null}
				</scroll>
			</stack>
		);
	};
	const detailPane = () => (
		<AgentHubInspectorView
			ref={selected()}
			observed={selected() ? observedById().get(selected()!.id) : undefined}
			metrics={selected() ? metrics(selected()!) : undefined}
			children={selected() ? (childrenByParent().get(selected()!.id) ?? []) : []}
			activity={selected() ? props.deps.activity.recent(selected()!.id, 20) : []}
			detailOffset={detailOffset()}
			now={now()}
			getRoleInfo={props.deps.getRoleInfo}
		/>
	);
	const activityPane = () => {
		const list = activityRows();
		const selectedAgent = selected()?.id;
		const scope =
			activityScope() === "all"
				? "all agents"
				: activityScope() === "agent"
					? (selectedAgent ?? "selected agent")
					: `${selectedAgent ?? "selected"} subtree`;
		const search = activitySearchEditing()
			? `search: ${activitySearch()}▌`
			: activitySearch()
				? `search: ${activitySearch()}`
				: "search: —";
		return (
			<stack height="fill">
				<tabs
					tabs={[
						{ id: "agents", label: "1 Agents" },
						{ id: "activity", label: "2 Activity" },
					]}
					active="activity"
				/>
				<text color="dim" wrap="clip">
					{scope} · {activityFilter()} · {activityFollow() ? "following" : "paused"} · {search}
				</text>
				<scroll grow={1} followTail={activityFollow()}>
					{list.length === 0 ? (
						<text color="muted">
							{activitySearch() ? "No matching activity" : "No agent activity recorded yet"}
						</text>
					) : (
						<For each={list}>
							{(activity, index) => (
								<AgentHubActivityRowView
									activity={activity}
									selected={index() === selectedActivityIndex()}
									ref={props.deps.registry.get(activity.agentId)}
									observed={observedById().get(activity.agentId)}
									getRoleInfo={props.deps.getRoleInfo}
									onMouse={mouseActivity(index(), activity)}
								/>
							)}
						</For>
					)}
				</scroll>
			</stack>
		);
	};
	return (
		<box onKey={handleKey} onMouse={outerMouse} tabIndex={0} height="fill">
			<frame
				height="fill"
				title={
					section() === "activity"
						? "Agent Hub"
						: narrowDetailsOpen() && selected()
							? `Agent Hub · ${selected()!.id}`
							: "Agent Hub"
				}
				paddingX={1}
				paddingY={0}
				borderPolicy="always"
				renderEmpty
			>
				<stack height="fill">
					{section() === "agents" ? (
						<split
							grow={1}
							leftSize={{ ratio: 0.58, min: ROSTER_MIN_WIDTH }}
							rightMinWidth={DETAIL_MIN_WIDTH}
							splitAt={SPLIT_MIN_WIDTH}
							narrowPane={narrowDetailsOpen() ? "right" : "left"}
							prefix="│ "
							divider=" │ "
							suffix=" │"
						>
							{rosterPane()}
							{detailPane()}
						</split>
					) : (
						activityPane()
					)}
					<hr variant="frame" />
					<text color="dim" wrap="clip">
						{section() === "agents"
							? rosterFooter(
									viewMode(),
									agentFilter(),
									agentFilterEditing(),
									narrowDetailsOpen(),
									!narrowDetailsOpen(),
								)
							: "1:agents  j/k:select  Enter:transcript  Space:follow  f:filter  s:scope  /:search  Esc:close"}
					</text>
				</stack>
			</frame>
		</box>
	);
}

export function openAgentHubOverlay<TRecord extends AgentRecordLike>(
	tui: TUI,
	deps: AgentHubDeps<TRecord>,
): OverlayDisposer {
	return mountOverlay(tui, () => (
		<Portal to="overlay" fullscreen mouseTracking>
			<AgentHubView deps={deps} />
		</Portal>
	));
}
