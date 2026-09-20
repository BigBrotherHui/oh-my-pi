/**
 * Fullscreen `/advisor configure` editor for one project- or user-level
 * `WATCHDOG.yml`. Changes remain in memory until “Save & apply”; the host owns
 * persistence and runtime rebuilding.
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Model, resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import type { SelectOption } from "../host/elements/select";
import { getKeybindings } from "../keybindings";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { matchesKey } from "../keys";
import { createEffect, createMemo, createSignal, onCleanup, onMount, useClock, useFocus, type JSX } from "../reactive";
import { sanitizeDisplayWarnings } from "../render/render-utils";
import type { TUI } from "../tui";
import { createHookEditorController, HookEditorView, type HookEditorController } from "./hook-editor";
import { buildBrowserItems, ModelBrowserView, sortModelItems, type ModelBrowserSource } from "./model-browser";

/** One advisor declared in `WATCHDOG.yml`. */
export interface AdvisorConfig {
	name: string;
	/** Model selector with an optional `:level` thinking suffix. */
	model?: string;
	/** Omitted uses the default read/grep/glob tools; an empty array grants none. */
	tools?: string[];
	instructions?: string;
	enabled?: boolean;
	maxNotesPerUpdate?: number;
}

export type AdvisorConfigScope = "project" | "user";

/** Raw contents of a single `WATCHDOG.yml`, without cross-scope merging. */
export interface WatchdogConfigDoc {
	instructions?: string;
	maxNotesPerUpdate?: number;
	advisors: AdvisorConfig[];
	/** Invalid entries dropped while the file was read. */
	warnings?: string[];
}

export interface AdvisorConfigStat {
	name: string;
	sessionId?: string;
	status: string;
	model?: { provider: string };
	tokens: { input: number; output: number; cacheRead: number };
	cost: number;
	contextWindow: number;
	contextTokens: number;
}

export interface AdvisorConfigCallbacks {
	loadDoc(scope: AdvisorConfigScope): Promise<WatchdogConfigDoc>;
	save(scope: AdvisorConfigScope, doc: WatchdogConfigDoc): Promise<void>;
	close(): void;
	notify(message: string): void;
	warn?(message: string): void;
	getAdvisorStats?(): AdvisorConfigStat[];
	getUsageReports?(): Promise<UsageReport[] | null>;
	getQuotaLimitFilter?(
		provider: string,
		sessionId: string | undefined,
	): ((report: UsageReport, limit: UsageLimit) => boolean) | undefined;
}

export interface AdvisorConfigDeps {
	getAvailableModels(): Model[];
	browserSource: ModelBrowserSource;
	defaultToolNames: ReadonlySet<string>;
	externalEditor?(text: string): Promise<string | null>;
	scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	availableToolNames: string[];
	defaultModelLabel?: string;
}

const PREVIEW_WIDTH = 60;

/** One line of the active credential's quota information. */
export function formatCompactQuota(
	provider: string,
	reports: UsageReport[],
	nowMs: number,
	includeLimit?: (report: UsageReport, limit: UsageLimit) => boolean,
): string | null {
	const byWindow = new Map<string, { limit: UsageLimit; fraction: number }>();
	for (const report of reports) {
		if (report.provider !== provider) continue;
		for (const limit of report.limits) {
			if (includeLimit && !includeLimit(report, limit)) continue;
			const fraction = resolveUsedFraction(limit);
			if (fraction === undefined) continue;
			const key = limit.window?.id ?? limit.scope.windowId ?? "—";
			const existing = byWindow.get(key);
			if (!existing || fraction > existing.fraction) byWindow.set(key, { limit, fraction });
		}
	}
	if (byWindow.size === 0) return null;
	const entries = [...byWindow.values()].sort((left, right) => right.fraction - left.fraction);
	const lines: string[] = [];
	for (const { limit, fraction } of entries) {
		const pct = Math.round(fraction * 100);
		const windowLabel = limit.window?.label ?? limit.scope.windowId ?? "—";
		const identity = limit.label.trim();
		const header = identity && identity !== windowLabel ? `${windowLabel} (${identity})` : windowLabel;
		const parts = [`${header}: ${pct}% used`];
		const window = limit.window;
		if (window?.resetsAt !== undefined && Number.isFinite(window.resetsAt) && window.resetsAt > nowMs) {
			parts.push(`${window.resetLabel ?? "resets"} in ${formatDuration(window.resetsAt - nowMs)}`);
		}
		lines.push(parts.join(" · "));
	}
	return `Quota: ${lines.join(" │ ")}`;
}

function previewLineOrNone(text: string | undefined): string {
	if (!text?.trim()) return "(none)";
	const first = text.trim().split("\n", 1)[0] ?? "";
	return first.length > PREVIEW_WIDTH ? `${first.slice(0, PREVIEW_WIDTH - 1)}…` : first;
}

/** Omitted means default read/grep/glob; an explicit empty set means no tools. */
function commitTools(
	selected: ReadonlySet<string>,
	all: readonly string[],
	defaults: ReadonlySet<string>,
): string[] | undefined {
	if (selected.size === 0) return [];
	if (selected.size === defaults.size) {
		let matchesDefault = true;
		for (const name of defaults) {
			if (!selected.has(name)) {
				matchesDefault = false;
				break;
			}
		}
		if (matchesDefault) return undefined;
	}
	return all.filter(name => selected.has(name));
}

function formatAdvisorTools(tools: readonly string[] | undefined, emptyLabel: string): string {
	if (tools === undefined) return "read, grep, glob (default)";
	return tools.length > 0 ? tools.join(", ") : emptyLabel;
}

function otherScope(scope: AdvisorConfigScope): AdvisorConfigScope {
	return scope === "project" ? "user" : "project";
}

function ensureRosterVisible(doc: WatchdogConfigDoc): WatchdogConfigDoc {
	return doc.advisors.length === 0 ? { ...doc, advisors: [{ name: "default" }] } : doc;
}

function hasSyntheticDefaultAdvisor(doc: WatchdogConfigDoc): boolean {
	if (doc.advisors.length !== 1) return false;
	const advisor = doc.advisors[0];
	return (
		advisor?.name === "default" &&
		!advisor.model?.trim() &&
		advisor.tools === undefined &&
		!advisor.instructions?.trim() &&
		advisor.enabled !== false &&
		advisor.maxNotesPerUpdate === undefined
	);
}

function advisorSummary(advisor: AdvisorConfig, defaultModelLabel: string | undefined): string {
	const model = advisor.model?.trim() || defaultModelLabel || "advisor role default";
	return `${model} · ${formatAdvisorTools(advisor.tools, "no tools")}`;
}

interface AdvisorMenuProps {
	readonly options: readonly SelectOption[];
	readonly value: string | undefined;
	readonly maxRows: number;
	readonly onChange: (value: string) => void;
	readonly onSelect: (value: string) => void;
	readonly onCancel: () => void;
}

/** A frame-less, mouse-aware SelectList equivalent for fullscreen editor panes. */
function AdvisorMenu(props: AdvisorMenuProps): JSX.Element {
	const focus = useFocus();
	const [hoveredIndex, setHoveredIndex] = createSignal<number>();
	const selectedIndex = () => props.options.findIndex(option => option.value === props.value);
	const enabledIndex = (index: number, direction: -1 | 1): number => {
		if (props.options.length === 0) return -1;
		const clamped = Math.max(0, Math.min(index, props.options.length - 1));
		if (!props.options[clamped]?.disabled) return clamped;
		for (
			let candidate = clamped + direction;
			candidate >= 0 && candidate < props.options.length;
			candidate += direction
		) {
			if (!props.options[candidate]?.disabled) return candidate;
		}
		for (
			let candidate = clamped - direction;
			candidate >= 0 && candidate < props.options.length;
			candidate -= direction
		) {
			if (!props.options[candidate]?.disabled) return candidate;
		}
		return -1;
	};
	const selectIndex = (index: number, direction: -1 | 1): boolean => {
		const next = enabledIndex(index, direction);
		if (next < 0) return false;
		const value = props.options[next]!.value;
		if (value === props.value) return false;
		props.onChange(value);
		return true;
	};
	const move = (delta: number, wrap: boolean): void => {
		if (props.options.length === 0 || delta === 0) return;
		const direction: -1 | 1 = delta < 0 ? -1 : 1;
		let current = selectedIndex();
		if (current < 0) current = enabledIndex(0, 1);
		if (current < 0) return;
		let candidate = current;
		let remaining = Math.max(1, Math.abs(Math.trunc(delta)));
		for (let attempts = 0; attempts < props.options.length && remaining > 0; attempts++) {
			candidate += direction;
			if (candidate < 0 || candidate >= props.options.length) {
				if (!wrap) break;
				candidate = direction > 0 ? 0 : props.options.length - 1;
			}
			if (candidate === current) break;
			if (!props.options[candidate]?.disabled) remaining--;
		}
		if (candidate !== current) selectIndex(candidate, direction);
	};
	const consume = (event: HostKeyEvent | HostMouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
	};
	const handleKey = (event: HostKeyEvent): void => {
		if (matchesSelectCancel(event.data)) {
			props.onCancel();
			consume(event);
			return;
		}
		if (matchesSelectUp(event.data)) move(-1, true);
		else if (matchesSelectDown(event.data)) move(1, true);
		else if (matchesSelectPageUp(event.data)) move(-props.maxRows, false);
		else if (matchesSelectPageDown(event.data)) move(props.maxRows, false);
		else if (matchesKey(event.data, "home")) selectIndex(0, 1);
		else if (matchesKey(event.data, "end")) selectIndex(props.options.length - 1, -1);
		else if (getKeybindings().matches(event.data, "tui.select.confirm") || event.data === "\n") {
			const option = props.options[selectedIndex()];
			if (option && !option.disabled) props.onSelect(option.value);
		} else {
			return;
		}
		consume(event);
	};
	const handleMouse = (event: HostMouseEvent): void => {
		if (event.action === "wheel" && event.wheel !== 0) {
			move(event.wheel, false);
			consume(event);
			return;
		}
		const row = event.localRow;
		const count = Math.min(props.maxRows, props.options.length);
		if (row < 0 || row >= count || event.localCol <= 1) {
			if (event.action === "move") setHoveredIndex(undefined);
			return;
		}
		const option = props.options[row];
		if (!option || option.disabled) {
			if (event.action === "move") setHoveredIndex(undefined);
			return;
		}
		if (event.action === "move") {
			setHoveredIndex(row);
		} else if (event.action === "down" && event.button === 0) {
			selectIndex(row, 1);
			props.onSelect(option.value);
		} else {
			return;
		}
		consume(event);
	};
	onMount(() => focus.focus());
	return (
		<box tabIndex={focus.tabIndex} onKey={handleKey} onMouse={handleMouse}>
			<select
				options={props.options}
				selectedIndex={selectedIndex()}
				hoveredIndex={hoveredIndex()}
				maxRows={props.maxRows}
				emptyText="No advisors"
			/>
		</box>
	);
}

interface AdvisorPreviewProps {
	readonly doc: WatchdogConfigDoc;
	readonly selectedValue: string | undefined;
	readonly scope: AdvisorConfigScope;
	readonly defaultModelLabel: string | undefined;
	readonly stats: readonly AdvisorConfigStat[];
	readonly reports: UsageReport[] | null;
	readonly now: number;
	readonly callbacks: AdvisorConfigCallbacks;
	readonly contentHeight: number;
	readonly marker: string;
	readonly offset: number;
	readonly onOffsetChange: (offset: number) => void;
	readonly onViewport: (viewport: { offset: number; totalRows: number; height: number }) => void;
}

/** The right pane shown while a roster row is selected. */
function AdvisorPreview(props: AdvisorPreviewProps): JSX.Element {
	const match = /^advisor:(\d+)$/.exec(props.selectedValue ?? "");
	const advisor = match ? props.doc.advisors[Number(match[1])] : undefined;
	const liveStat = advisor ? props.stats.find(stat => stat.name === (advisor.name || "default")) : undefined;
	const explicitProvider = advisor?.model?.includes("/") ? advisor.model.split("/", 1)[0] : undefined;
	const quotaProvider = explicitProvider ?? liveStat?.model?.provider;
	const quota =
		props.reports && quotaProvider
			? formatCompactQuota(
					quotaProvider,
					props.reports,
					props.now,
					props.callbacks.getQuotaLimitFilter?.(quotaProvider, liveStat?.sessionId),
				)
			: null;
	const help =
		props.selectedValue === "add"
			? "Create a new advisor entry, then edit its model, tools, and instructions."
			: props.selectedValue === "scope"
				? `Switch between the project and user WATCHDOG.yml. Currently editing the ${props.scope}-level file.`
				: props.selectedValue === "save"
					? "Write this scope's WATCHDOG.yml and reload the live advisors without a restart."
					: props.selectedValue === "close"
						? "Close the editor. Unsaved changes are discarded."
						: "";
	return (
		<stack>
			<scroll
				height={props.contentHeight}
				offset={props.offset}
				followTail={false}
				scrollbar="never"
				onViewport={props.onViewport}
				onMouse={event => {
					if (event.action !== "wheel" || event.wheel === 0) return;
					props.onOffsetChange(Math.max(0, props.offset + event.wheel));
					event.preventDefault();
					event.stopPropagation();
				}}
			>
				<stack>
					{props.doc.warnings?.length ? (
						<>
							<text color="warning">⚠ Config problems — dropped while loading:</text>
							{sanitizeDisplayWarnings(props.doc.warnings).map(warning => (
								<text color="warning" wrap="word">
									{warning}
								</text>
							))}
							<text />
						</>
					) : null}
					{advisor ? (
						<>
							<text bold>{advisor.name || "(unnamed)"}</text>
							<text />
							<text>
								<span color="dim">Enabled:</span> {advisor.enabled === false ? "○ off" : "● on"}
							</text>
							<text>
								<span color="dim">Model:</span>{" "}
								{advisor.model?.trim() || props.defaultModelLabel || "advisor role default"}
							</text>
							<text>
								<span color="dim">Tools:</span> {formatAdvisorTools(advisor.tools, "no tools")}
							</text>
							<text />
							<text color="dim">Instructions:</text>
							{advisor.instructions?.trim() ? (
								<text wrap="word">{advisor.instructions.trim()}</text>
							) : (
								<text color="muted">(none)</text>
							)}
							{liveStat && (liveStat.status === "running" || liveStat.status === "quota_exhausted") ? (
								<>
									<text />
									<text color="dim">Usage:</text>
									<text color="dim">
										{" "}
										Tokens:{" "}
										{`${liveStat.tokens.input.toLocaleString()} in, ${liveStat.tokens.output.toLocaleString()} out${liveStat.tokens.cacheRead > 0 ? `, ${liveStat.tokens.cacheRead.toLocaleString()} cache` : ""}`}
									</text>
									{liveStat.cost > 0 ? <text color="dim"> Cost: ${liveStat.cost.toFixed(4)}</text> : null}
									{liveStat.contextWindow > 0 ? (
										<text color="dim">
											{" "}
											Context:{" "}
											{`${liveStat.contextTokens.toLocaleString()}/${liveStat.contextWindow.toLocaleString()} (${Math.round((liveStat.contextTokens / liveStat.contextWindow) * 100)}%)`}
										</text>
									) : null}
								</>
							) : null}
							{quota ? <text color="dim"> {quota}</text> : null}
						</>
					) : props.selectedValue === "shared" ? (
						<>
							<text bold>Shared instructions</text>
							<text />
							{props.doc.instructions?.trim() ? (
								<text wrap="word">{props.doc.instructions.trim()}</text>
							) : (
								<text color="muted">(none)</text>
							)}
						</>
					) : (
						<text color="muted" wrap="word">
							{help}
						</text>
					)}
				</stack>
			</scroll>
			{props.marker ? <text color="dim">{props.marker}</text> : null}
		</stack>
	);
}

type AdvisorScreen =
	| { kind: "list" }
	| { kind: "detail"; index: number }
	| { kind: "name"; index: number }
	| { kind: "model"; index: number }
	| { kind: "thinking"; index: number; selector: string; efforts: readonly string[] }
	| { kind: "tools"; index: number }
	| { kind: "instructions"; index: number; controller: HookEditorController };

interface PreviewViewport {
	offset: number;
	totalRows: number;
	height: number;
}

export interface AdvisorConfigViewProps {
	readonly tui: TUI;
	readonly deps: AdvisorConfigDeps;
	readonly scope: AdvisorConfigScope;
	readonly initialDoc: WatchdogConfigDoc;
	readonly callbacks: AdvisorConfigCallbacks;
}

/** Reactive editor for one `WATCHDOG.yml` scope. */
export function AdvisorConfigView(props: AdvisorConfigViewProps): JSX.Element {
	const [doc, setDoc] = createSignal(ensureRosterVisible(structuredClone(props.initialDoc)));
	const [scope, setScope] = createSignal(props.scope);
	const [screen, setScreen] = createSignal<AdvisorScreen>({ kind: "list" });
	const [menuSelection, setMenuSelection] = createSignal<string>("advisor:0");
	const [tools, setTools] = createSignal<ReadonlySet<string>>(new Set());
	const [dirty, setDirty] = createSignal(false);
	const [saving, setSaving] = createSignal(false);
	const [reports, setReports] = createSignal<UsageReport[] | null>(null);
	const [previewOffset, setPreviewOffset] = createSignal(0);
	const [previewViewport, setPreviewViewport] = createSignal<PreviewViewport>({ offset: 0, totalRows: 0, height: 0 });
	const [editorController, setEditorController] = createSignal<HookEditorController>();
	const now = useClock("second");
	let alive = true;

	const disposeEditor = (): void => {
		const controller = editorController();
		if (!controller) return;
		controller.dispose();
		setEditorController(undefined);
	};
	const showList = (): void => {
		disposeEditor();
		setScreen({ kind: "list" });
		setMenuSelection("advisor:0");
		setPreviewOffset(0);
		setPreviewViewport({ offset: 0, totalRows: 0, height: 0 });
	};
	const showDetail = (index: number): void => {
		disposeEditor();
		if (!doc().advisors[index]) {
			showList();
			return;
		}
		setScreen({ kind: "detail", index });
		setMenuSelection("name");
	};
	const updateAdvisor = (index: number, patch: Partial<AdvisorConfig>): void => {
		setDoc(current => ({
			...current,
			advisors: current.advisors.map((advisor, advisorIndex) =>
				advisorIndex === index ? { ...advisor, ...patch } : advisor,
			),
		}));
		setDirty(true);
	};
	const openInstructions = (index: number): void => {
		disposeEditor();
		const shared = index < 0;
		const advisor = shared ? undefined : doc().advisors[index];
		if (!shared && !advisor) {
			showList();
			return;
		}
		const controller = createHookEditorController(
			props.tui,
			shared ? doc().instructions : advisor?.instructions,
			value => {
				const text = value.trim() ? value : undefined;
				if (shared) setDoc(current => ({ ...current, instructions: text }));
				else updateAdvisor(index, { instructions: text });
				setDirty(true);
				if (shared) showList();
				else showDetail(index);
			},
			() => {
				if (shared) showList();
				else showDetail(index);
			},
			{ externalEditor: props.deps.externalEditor },
		);
		setEditorController(controller);
		setScreen({ kind: "instructions", index, controller });
	};
	const openModelPicker = (index: number): void => {
		if (!doc().advisors[index]) {
			showList();
			return;
		}
		setScreen({ kind: "model", index });
	};
	const selectModel = (index: number, model: Model, selector: string): void => {
		const efforts = getSupportedEfforts(model);
		if (efforts.length === 0) {
			updateAdvisor(index, { model: selector });
			showDetail(index);
			return;
		}
		setScreen({ kind: "thinking", index, selector, efforts });
		setMenuSelection("");
	};
	const openTools = (index: number): void => {
		const advisor = doc().advisors[index];
		if (!advisor) {
			showList();
			return;
		}
		setTools(new Set(advisor.tools ?? props.deps.defaultToolNames));
		setScreen({ kind: "tools", index });
		setMenuSelection(props.deps.availableToolNames[0] ?? "__done");
	};
	const commitToolSelection = (index: number): void => {
		updateAdvisor(index, { tools: commitTools(tools(), props.deps.availableToolNames, props.deps.defaultToolNames) });
		showDetail(index);
	};
	const save = (): void => {
		if (saving()) return;
		setSaving(true);
		const current = doc();
		const docToSave = hasSyntheticDefaultAdvisor(current) ? { ...current, advisors: [] } : current;
		void props.callbacks
			.save(scope(), docToSave)
			.then(() => {
				setDoc(value => ({ ...value, warnings: undefined }));
				setDirty(false);
				showList();
			})
			.catch(cause =>
				props.callbacks.notify(`Advisor config: ${cause instanceof Error ? cause.message : String(cause)}`),
			)
			.finally(() => setSaving(false));
	};
	const selectListValue = (value: string): void => {
		if (value === "add") {
			setDoc(current => ({
				...current,
				advisors: [...current.advisors, { name: `Advisor ${current.advisors.length + 1}` }],
			}));
			setDirty(true);
			showDetail(doc().advisors.length - 1);
			return;
		}
		if (value === "shared") {
			openInstructions(-1);
			return;
		}
		if (value === "scope") {
			if (dirty()) {
				props.callbacks.notify('Unsaved changes — "Save & apply" or Close before switching scope.');
				return;
			}
			const nextScope = otherScope(scope());
			void props.callbacks
				.loadDoc(nextScope)
				.then(loaded => {
					setDoc(ensureRosterVisible(structuredClone(loaded)));
					setScope(nextScope);
					if (loaded.warnings?.length) {
						const message = `WATCHDOG.yml: ${sanitizeDisplayWarnings(loaded.warnings).join("; ")}`;
						if (props.callbacks.warn) props.callbacks.warn(message);
						else props.callbacks.notify(message);
					}
					showList();
				})
				.catch(cause =>
					props.callbacks.notify(`Advisor config: ${cause instanceof Error ? cause.message : String(cause)}`),
				);
			return;
		}
		if (value === "save") {
			save();
			return;
		}
		if (value === "close") {
			props.callbacks.close();
			return;
		}
		const match = /^advisor:(\d+)$/.exec(value);
		if (match) showDetail(Number(match[1]));
	};
	const selectDetailValue = (index: number, value: string): void => {
		const advisor = doc().advisors[index];
		if (!advisor) {
			showList();
			return;
		}
		switch (value) {
			case "toggleEnabled":
				updateAdvisor(index, { enabled: advisor.enabled === false ? undefined : false });
				showDetail(index);
				return;
			case "name":
				setScreen({ kind: "name", index });
				return;
			case "model":
				openModelPicker(index);
				return;
			case "resetModel":
				updateAdvisor(index, { model: undefined });
				showDetail(index);
				return;
			case "tools":
				openTools(index);
				return;
			case "instructions":
				openInstructions(index);
				return;
			case "delete":
				setDoc(current => ({
					...current,
					advisors: current.advisors.filter((_, advisorIndex) => advisorIndex !== index),
				}));
				setDirty(true);
				showList();
				return;
			default:
				showList();
		}
	};
	const models = createMemo(() => {
		let available: ReadonlyArray<Model>;
		if (props.deps.scopedModels.length > 0) available = props.deps.scopedModels.map(scoped => scoped.model);
		else {
			try {
				available = props.deps.getAvailableModels();
			} catch {
				available = [];
			}
		}
		const items = buildBrowserItems(available);
		sortModelItems(items, { mruOrder: props.deps.browserSource.mruOrder });
		return items;
	});
	const listOptions = createMemo<readonly SelectOption[]>(() => [
		...doc().advisors.map((advisor, index) => ({
			value: `advisor:${index}`,
			label: `${advisor.enabled === false ? "○" : "●"} ${advisor.name || "(unnamed)"}`,
			description: advisorSummary(advisor, props.deps.defaultModelLabel),
		})),
		{ value: "add", label: "+ Add advisor" },
		{ value: "shared", label: "Shared instructions", description: previewLineOrNone(doc().instructions) },
		{ value: "scope", label: `Scope: ${scope()}`, description: `→ ${otherScope(scope())}` },
		{ value: "save", label: "Save & apply" },
		{ value: "close", label: "Close" },
	]);
	const view = createMemo(() => {
		const currentDoc = doc();
		const currentScope = scope();
		const currentScreen = screen();
		const currentSelection = menuSelection();
		const currentTools = tools();
		const currentDirty = dirty();
		const currentReports = currentScreen.kind === "list" ? reports() : null;
		const currentNow = currentScreen.kind === "list" ? now() : 0;
		const currentPreviewOffset = currentScreen.kind === "list" ? previewOffset() : 0;
		const currentPreviewViewport =
			currentScreen.kind === "list" ? previewViewport() : { offset: 0, totalRows: 0, height: 0 };
		const title = `Advisor configuration · ${currentScope}${currentDirty ? "  ● unsaved" : ""}`;
		const bodyRows = Math.max(10, (process.stdout.rows || 40) - 4);
		const footer = (): string => {
			switch (currentScreen.kind) {
				case "list":
					return "↑↓ move · Enter / click select · scroll preview on the right · Esc close";
				case "detail":
					return `Editing "${currentDoc.advisors[currentScreen.index]?.name ?? ""}" · Enter / click edit field · Esc back`;
				case "name":
					return "Type a name · Enter save · Esc cancel";
				case "model":
					return "Type to search · Enter / click twice picks · Esc back";
				case "thinking":
					return `Thinking effort for ${currentScreen.selector} · Enter / click pick · Esc back`;
				case "tools":
					return "Enter / click toggle · select Done or Esc to apply (empty = no tools; read/grep/glob = default)";
				case "instructions":
					return "";
			}
		};
		const activePane = (): JSX.Element => {
			switch (currentScreen.kind) {
				case "detail": {
					const advisor = currentDoc.advisors[currentScreen.index];
					if (!advisor) return <text color="muted">No advisor selected</text>;
					const options: SelectOption[] = [
						{ value: "name", label: "Name", description: advisor.name },
						{
							value: "toggleEnabled",
							label: "Enabled",
							description: advisor.enabled === false ? "○ off" : "● on",
						},
						{
							value: "model",
							label: "Model",
							description: advisor.model?.trim() || props.deps.defaultModelLabel || "advisor role default",
						},
					];
					if (advisor.model?.trim())
						options.push({ value: "resetModel", label: "Reset model to advisor-role default" });
					options.push(
						{ value: "tools", label: "Tools", description: formatAdvisorTools(advisor.tools, "no tools") },
						{
							value: "instructions",
							label: "Instructions",
							description: previewLineOrNone(advisor.instructions),
						},
						{ value: "delete", label: "Delete this advisor" },
						{ value: "back", label: "Back" },
					);
					return (
						<AdvisorMenu
							options={options}
							value={currentSelection}
							maxRows={Math.max(1, options.length)}
							onChange={setMenuSelection}
							onSelect={value => selectDetailValue(currentScreen.index, value)}
							onCancel={showList}
						/>
					);
				}
				case "name": {
					const advisor = currentDoc.advisors[currentScreen.index];
					return advisor ? (
						<input
							value={advisor.name}
							prompt=""
							onSubmit={value => {
								const name = value.trim();
								if (name) updateAdvisor(currentScreen.index, { name });
								showDetail(currentScreen.index);
							}}
							onEscape={() => showDetail(currentScreen.index)}
						/>
					) : (
						<text color="muted">No advisor selected</text>
					);
				}
				case "model":
					return (
						<ModelBrowserView
							items={models()}
							mruOrder={props.deps.browserSource.mruOrder}
							providerOrder={props.deps.browserSource.modelProviderOrder}
							perf={props.deps.browserSource.modelPerf}
							maxVisible={Math.max(1, bodyRows - 5)}
							onSelect={item => selectModel(currentScreen.index, item.model, item.selector)}
							onCancel={() => showDetail(currentScreen.index)}
						/>
					);
				case "thinking": {
					const options: SelectOption[] = [
						{ value: "", label: "(model default thinking)" },
						...currentScreen.efforts.map(effort => ({ value: effort, label: effort })),
					];
					return (
						<AdvisorMenu
							options={options}
							value={currentSelection}
							maxRows={Math.max(1, options.length)}
							onChange={setMenuSelection}
							onSelect={effort => {
								updateAdvisor(currentScreen.index, {
									model: effort ? `${currentScreen.selector}:${effort}` : currentScreen.selector,
								});
								showDetail(currentScreen.index);
							}}
							onCancel={() => openModelPicker(currentScreen.index)}
						/>
					);
				}
				case "tools": {
					const options: SelectOption[] = [
						...props.deps.availableToolNames.map(name => ({
							value: name,
							label: `${currentTools.has(name) ? "[x]" : "[ ]"} ${name}`,
						})),
						{ value: "__done", label: "Done" },
					];
					return (
						<AdvisorMenu
							options={options}
							value={currentSelection}
							maxRows={Math.max(1, options.length)}
							onChange={setMenuSelection}
							onSelect={value => {
								if (value === "__done") {
									commitToolSelection(currentScreen.index);
									return;
								}
								setTools(previous => {
									const next = new Set(previous);
									if (next.has(value)) next.delete(value);
									else next.add(value);
									return next;
								});
							}}
							onCancel={() => commitToolSelection(currentScreen.index)}
						/>
					);
				}
				case "instructions":
					return (
						<HookEditorView
							title={
								currentScreen.index < 0
									? "Shared advisor instructions"
									: `Instructions — ${currentDoc.advisors[currentScreen.index]?.name ?? ""}`
							}
							controller={currentScreen.controller}
						/>
					);
				case "list":
					return <text color="muted">No advisor selected</text>;
			}
		};
		return (width: number): JSX.Element => {
			const contentWidth = Math.max(0, width - 4);
			const splitAvailable = Math.max(0, contentWidth - 6);
			const leftWidth = Math.max(22, Math.min(42, splitAvailable, Math.floor(contentWidth * 0.34)));
			const dividerColumn = leftWidth + 5;
			const previewMore =
				currentPreviewViewport.totalRows > bodyRows
					? currentPreviewViewport.totalRows - bodyRows - currentPreviewViewport.offset
					: 0;
			const marker =
				currentPreviewViewport.totalRows > bodyRows
					? previewMore > 0
						? `  ↓ ${previewMore} more`
						: "  (end)"
					: "";
			const previewHeight = bodyRows - Number(marker.length > 0);
			if (currentScreen.kind === "list") {
				return (
					<frame
						title={title}
						paddingX={1}
						paddingY={0}
						borderPolicy="always"
						renderEmpty
						topDividerCols={[dividerColumn]}
						dividerCols={[dividerColumn]}
					>
						<split
							leftSize={{ ratio: 0.34, min: 22, max: 42 }}
							rightMinWidth={0}
							splitAt={0}
							height={bodyRows}
							prefix="│ "
							divider=" │ "
							suffix="│"
						>
							<AdvisorMenu
								options={listOptions()}
								value={currentSelection}
								maxRows={Math.max(1, listOptions().length)}
								onChange={value => {
									setMenuSelection(value);
									setPreviewOffset(0);
									setPreviewViewport({ offset: 0, totalRows: 0, height: 0 });
								}}
								onSelect={selectListValue}
								onCancel={props.callbacks.close}
							/>
							<AdvisorPreview
								doc={currentDoc}
								selectedValue={currentSelection}
								scope={currentScope}
								defaultModelLabel={props.deps.defaultModelLabel}
								stats={props.callbacks.getAdvisorStats?.() ?? []}
								reports={currentReports}
								now={currentNow}
								callbacks={props.callbacks}
								contentHeight={previewHeight}
								marker={marker}
								offset={currentPreviewOffset}
								onOffsetChange={setPreviewOffset}
								onViewport={next =>
									setPreviewViewport(previous =>
										previous.offset === next.offset &&
										previous.totalRows === next.totalRows &&
										previous.height === next.height
											? previous
											: next,
									)
								}
							/>
						</split>
						<hr variant="frame" />
						<text color="dim" wrap="clip">
							{footer()}
						</text>
					</frame>
				);
			}
			return (
				<frame title={title} paddingX={1} paddingY={0} borderPolicy="always" renderEmpty>
					<split
						leftSize={{ fixed: Number.MAX_SAFE_INTEGER }}
						narrowPane="left"
						splitAt={Number.MAX_SAFE_INTEGER}
						height={bodyRows}
						prefix="│ "
						suffix="│"
					>
						{activePane()}
						<text />
					</split>
					<hr variant="frame" />
					<text color="dim" wrap="clip">
						{footer()}
					</text>
				</frame>
			);
		};
	});

	createEffect(() => {
		if (!props.callbacks.getUsageReports) return;
		void props.callbacks
			.getUsageReports()
			.then(value => {
				if (alive) setReports(value);
			})
			.catch(() => {
				if (alive) setReports(null);
			});
	});
	onCleanup(() => {
		alive = false;
		editorController()?.dispose();
	});
	return (
		<box tabIndex={0}>
			<sized paint={view()} />
		</box>
	);
}

export function openAdvisorConfigOverlay(
	tui: TUI,
	deps: AdvisorConfigDeps,
	scope: AdvisorConfigScope,
	doc: WatchdogConfigDoc,
	callbacks: AdvisorConfigCallbacks,
): OverlayDisposer {
	return mountOverlay(tui, () => (
		<Portal to="overlay" fullscreen mouseTracking>
			<AdvisorConfigView tui={tui} deps={deps} scope={scope} initialDoc={doc} callbacks={callbacks} />
		</Portal>
	));
}
