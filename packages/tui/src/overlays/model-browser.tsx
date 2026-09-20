import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ModelKind } from "@oh-my-pi/pi-catalog/types";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import { fuzzyRank } from "../fuzzy";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import { matchesKey } from "../keys";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import {
	For,
	createEffect,
	createMemo,
	createSignal,
	onMount,
	untrack,
	useFocus,
	useTheme,
	useViewport,
	type JSX,
} from "../reactive";
import { thinkingLevelGlyph } from "../render/render-utils";
import type { ThemeColor } from "../theme/schema";
import type { ConfiguredThinkingLevel } from "../thinking";
import { parseConfiguredThinkingLevel } from "../thinking";
import type { TUI } from "../tui";
import { replaceTabs } from "../utils";

export type ModelRole =
	| "default"
	| "smol"
	| "slow"
	| "vision"
	| "plan"
	| "commit"
	| "tiny"
	| "memory"
	| "task"
	| "advisor"
	| "image"
	| "web"
	| "speech"
	| "dictation"
	| "judge";
export const MODEL_ROLE_IDS: ModelRole[] = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"memory",
	"task",
	"advisor",
	"image",
	"web",
	"speech",
	"dictation",
	"judge",
];
export const KIND_ROLE_IDS: ModelRole[] = ["image", "web", "speech", "dictation", "judge"];
export const CHAT_MODEL_ROLE_IDS: ModelRole[] = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"memory",
	"task",
	"advisor",
];

export interface ModelBrowserPerf {
	samples: number;
	tps: number;
	ttftMs: number | null;
}

export interface ModelBrowserRoleInfo {
	tag?: string;
	name: string;
	color?: ThemeColor;
	hidden?: boolean;
	accepts(model: Model): boolean;
	section: "chat" | "kind";
}

export interface ModelRoleLookup {
	getModelRole(role: string): string | undefined;
}

export interface ResolvedModelRoleValue {
	model: Model | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
	warning?: string;
}

export interface ModelBrowserSource extends ModelRoleLookup {
	readonly defaultThinkingLevel: string;
	readonly modelProviderOrder: readonly string[];
	readonly knownRoleIds: readonly string[];
	readonly mruOrder: readonly string[];
	readonly modelPerf: ReadonlyMap<string, ModelBrowserPerf>;
	getRoleInfo(role: string): ModelBrowserRoleInfo;
	defaultRoleChain(role: string): string[];
	resolveRoleValue(value: string | undefined, models: Model[], roleLookup?: ModelRoleLookup): ResolvedModelRoleValue;
}

export interface ModelBrowserRegistry {
	getError(): unknown;
	getAvailable(kind?: ModelKind | "all"): Model[];
	getAll(kind?: ModelKind | "all"): Model[];
}

export interface ModelBrowserItem {
	provider: string;
	id: string;
	model: Model;
	selector: string;
	labelColor?: ThemeColor;
}

export interface RoleAssignment {
	model: Model;
	thinkingLevel: ConfiguredThinkingLevel;
	autoSelected: boolean;
}

export type RoleAssignments = Record<string, RoleAssignment | undefined>;

export function resolveRoleAssignments(
	settings: ModelBrowserSource,
	allModels: ReadonlyArray<Model>,
	autoCandidates: ReadonlyArray<Model>,
): RoleAssignments {
	const resolvedLevel = (role: string, value: ResolvedModelRoleValue): ConfiguredThinkingLevel =>
		value.explicitThinkingLevel && value.thinkingLevel !== undefined
			? value.thinkingLevel
			: role === "default"
				? (parseConfiguredThinkingLevel(settings.defaultThinkingLevel) ?? ThinkingLevel.Inherit)
				: ThinkingLevel.Inherit;
	const roles: RoleAssignments = {};
	const configured = new Set<string>();
	for (const role of settings.knownRoleIds) {
		const value = settings.getModelRole(role);
		if (!value) continue;
		configured.add(role);
		const resolved = settings.resolveRoleValue(value, [...allModels].filter(settings.getRoleInfo(role).accepts));
		if (resolved.model)
			roles[role] = { model: resolved.model, thinkingLevel: resolvedLevel(role, resolved), autoSelected: false };
	}
	for (const role of settings.knownRoleIds) {
		if (configured.has(role) || autoCandidates.length === 0) continue;
		const resolved = settings.resolveRoleValue(
			`pi/${role}`,
			[...autoCandidates].filter(settings.getRoleInfo(role).accepts),
		);
		if (resolved.model)
			roles[role] = { model: resolved.model, thinkingLevel: resolvedLevel(role, resolved), autoSelected: true };
	}
	return roles;
}

export function buildBrowserItems(models: ReadonlyArray<Model>): ModelBrowserItem[] {
	return models.map(model => ({
		provider: model.provider,
		id: model.id,
		model,
		selector: `${model.provider}/${model.id}`,
	}));
}

function version(id: string): number {
	const decimal = id.match(/(?:^|[-_])(\d+\.\d+)/)?.[1];
	if (decimal) return Number.parseFloat(decimal);
	const pair = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
	if (pair) return Number.parseFloat(`${pair[1]}.${pair[2]}`);
	return Number.parseFloat(id.match(/(?:^|[-_])(\d+)/)?.[1] ?? "0");
}

function roleRank(model: Model, roles: RoleAssignments): number {
	const index = MODEL_ROLE_IDS.findIndex(role => {
		const assignment = roles[role];
		return assignment !== undefined && modelsAreEqual(assignment.model, model);
	});
	return index < 0 ? MODEL_ROLE_IDS.length : index;
}

export interface SortModelItemsOptions {
	roles?: RoleAssignments;
	mruOrder?: ReadonlyArray<string>;
	skipRoleRank?: boolean;
}

export function sortModelItems(items: ModelBrowserItem[], options: SortModelItemsOptions = {}): void {
	const mru = new Map((options.mruOrder ?? []).map((selector, index) => [selector, index]));
	const date = /-(\d{8})$/;
	const latest = /-latest$/;
	items.sort((left, right) => {
		if (!options.skipRoleRank) {
			const roleOrder = roleRank(left.model, options.roles ?? {}) - roleRank(right.model, options.roles ?? {});
			if (roleOrder) return roleOrder;
		}
		const recent =
			(mru.get(left.selector) ?? Number.MAX_SAFE_INTEGER) - (mru.get(right.selector) ?? Number.MAX_SAFE_INTEGER);
		if (recent) return recent;
		const provider = left.provider.localeCompare(right.provider);
		if (provider) return provider;
		const priority =
			(left.model.priority ?? Number.MAX_SAFE_INTEGER) - (right.model.priority ?? Number.MAX_SAFE_INTEGER);
		if (priority) return priority;
		const newer = version(right.id) - version(left.id);
		if (newer) return newer;
		const leftLatest = latest.test(left.id);
		const rightLatest = latest.test(right.id);
		const leftDate = left.id.match(date)?.[1] ?? "";
		const rightDate = right.id.match(date)?.[1] ?? "";
		const leftHasRecency = leftLatest || leftDate !== "";
		const rightHasRecency = rightLatest || rightDate !== "";
		if (leftHasRecency !== rightHasRecency) return leftHasRecency ? -1 : 1;
		if (!leftHasRecency) return left.id.localeCompare(right.id);
		if (leftLatest !== rightLatest) return leftLatest ? -1 : 1;
		if (leftDate && rightDate) return rightDate.localeCompare(leftDate);
		return leftLatest ? -1 : rightLatest ? 1 : left.id.localeCompare(right.id);
	});
}

export interface SessionModelScope {
	items: ModelBrowserItem[];
	roles: RoleAssignments;
	mruOrder: ReadonlyArray<string>;
	error: string | undefined;
}

export function buildSessionModelScope(
	settings: ModelBrowserSource,
	registry: ModelBrowserRegistry,
	scopedModels: ReadonlyArray<Model>,
): SessionModelScope {
	let models = [...scopedModels];
	let error: string | undefined;
	if (models.length === 0) {
		try {
			models = registry.getAvailable();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
		error ??= registry.getError() ? String(registry.getError()) : undefined;
	}
	const allModels = scopedModels.length > 0 ? models : registry.getAll("all");
	const roles = resolveRoleAssignments(settings, allModels, models);
	const items = buildBrowserItems(models);
	sortModelItems(items, { roles, mruOrder: settings.mruOrder });
	return { items, roles, mruOrder: settings.mruOrder, error };
}

interface RoleProviderStats {
	count: number;
	firstRole: number;
}

export interface SearchAffinity {
	models: Map<string, number>;
	providers: Map<string, number>;
}

export function buildSearchAffinity(
	providerOrder: ReadonlyArray<string>,
	roles: RoleAssignments,
	mruOrder: ReadonlyArray<string>,
): SearchAffinity {
	const models: string[] = [];
	const seenModels = new Set<string>();
	const addModel = (selector: string) => {
		const normalized = selector.toLowerCase();
		if (seenModels.has(normalized)) return;
		seenModels.add(normalized);
		models.push(normalized);
	};
	const providers: string[] = [];
	const seenProviders = new Set<string>();
	const addProvider = (provider: string) => {
		const normalized = provider.trim().toLowerCase();
		if (!normalized || seenProviders.has(normalized)) return;
		seenProviders.add(normalized);
		providers.push(normalized);
	};
	for (const provider of providerOrder) addProvider(provider);
	const roleStats = new Map<string, RoleProviderStats>();
	const seenRoles = new Set<string>();
	let roleIndex = 0;
	const recordRole = (role: string) => {
		if (seenRoles.has(role)) return;
		seenRoles.add(role);
		const assignment = roles[role];
		if (assignment && !assignment.autoSelected) {
			addModel(`${assignment.model.provider}/${assignment.model.id}`);
			const provider = assignment.model.provider.toLowerCase();
			const current = roleStats.get(provider);
			if (current) current.count++;
			else roleStats.set(provider, { count: 1, firstRole: roleIndex });
		}
		roleIndex++;
	};
	for (const role of MODEL_ROLE_IDS) recordRole(role);
	for (const role in roles) recordRole(role);
	for (const selector of mruOrder) addModel(selector);
	for (const [provider] of [...roleStats.entries()].sort(
		([, left], [, right]) => right.count - left.count || left.firstRole - right.firstRole,
	))
		addProvider(provider);
	for (const selector of mruOrder) {
		const slash = selector.indexOf("/");
		if (slash > 0) addProvider(selector.slice(0, slash));
	}
	return {
		models: new Map(models.map((selector, index) => [selector, index])),
		providers: new Map(providers.map((provider, index) => [provider, index])),
	};
}

function compact(value: string): string {
	return value.toLowerCase().replace(/[^\p{Letter}\p{Mark}\p{Number}]+/gu, "");
}

export function modelSearchText(item: ModelBrowserItem): string {
	const free = (item.model.cost?.input ?? 0) === 0 && (item.model.cost?.output ?? 0) === 0;
	return `${item.provider}/${item.id} ${item.model.name ?? ""}${free ? " free" : ""}`;
}

function searchTier(query: string, item: ModelBrowserItem): number {
	if (!query) return 2;
	const id = compact(item.id);
	const selector = compact(item.selector);
	if (query === id || query === selector) return 0;
	return id.includes(query) || selector.includes(query) ? 1 : 2;
}

export function rankModelItems(
	query: string,
	items: ReadonlyArray<ModelBrowserItem>,
	options: { roles: RoleAssignments; mruOrder: ReadonlyArray<string>; affinity: SearchAffinity },
): ModelBrowserItem[] {
	if (!query.trim()) return [...items];
	const ranked = fuzzyRank(items, query, modelSearchText);
	const matches = ranked.map(result => result.item);
	sortModelItems(matches, { roles: options.roles, mruOrder: options.mruOrder, skipRoleRank: true });
	const fallbackRanks = new Map(matches.map((item, index) => [item, index]));
	const queryKey = compact(query);
	const searchRanks = new Map<ModelBrowserItem, { tier: number; bucket: number }>();
	for (const result of ranked)
		searchRanks.set(result.item, { tier: searchTier(queryKey, result.item), bucket: Math.round(result.score / 10) });
	matches.sort((left, right) => {
		const leftSearch = searchRanks.get(left);
		const rightSearch = searchRanks.get(right);
		const tier = (leftSearch?.tier ?? Number.MAX_SAFE_INTEGER) - (rightSearch?.tier ?? Number.MAX_SAFE_INTEGER);
		if (tier) return tier;
		const modelAffinity =
			(options.affinity.models.get(left.selector.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
			(options.affinity.models.get(right.selector.toLowerCase()) ?? Number.MAX_SAFE_INTEGER);
		if (modelAffinity) return modelAffinity;
		const providerAffinity =
			(options.affinity.providers.get(left.provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
			(options.affinity.providers.get(right.provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER);
		if (providerAffinity) return providerAffinity;
		const score = (leftSearch?.bucket ?? Number.MAX_SAFE_INTEGER) - (rightSearch?.bucket ?? Number.MAX_SAFE_INTEGER);
		if (score) return score;
		return (
			(fallbackRanks.get(left) ?? Number.MAX_SAFE_INTEGER) - (fallbackRanks.get(right) ?? Number.MAX_SAFE_INTEGER)
		);
	});
	return matches;
}

export function formatRoleChip(role: string, assignment: RoleAssignment, settings: ModelBrowserSource): string {
	const info = settings.getRoleInfo(role);
	return `${assignment.autoSelected ? "○" : "●"} ${(info.tag ?? info.name ?? role).toLowerCase()}`;
}

function isFree(model: Model): boolean {
	const value = model.cost;
	return !value || (value.input === 0 && value.output === 0);
}

function cost(model: Model): string {
	if (isFree(model)) return "free";
	const value = model.cost;
	if (!value) return "free";
	const format = (number: number): string => {
		if (!Number.isFinite(number) || number < 0) return "?";
		if (number > 0 && number < 0.01)
			return number.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
		const result = number >= 100 ? String(Math.round(number)) : number >= 10 ? number.toFixed(1) : number.toFixed(2);
		return result.includes(".") ? result.replace(/\.?0+$/, "") : result;
	};
	return `$${format(value.input)}/${format(value.output)}`;
}

function description(value: string): string {
	return replaceTabs(sanitizeText(value))
		.replace(/[\r\n]+/g, " ")
		.trim();
}

function context(model: Model, icon: string): string {
	const limit = model.contextWindow ?? 0;
	return limit > 0 ? `${formatNumber(limit).toLowerCase()} ${icon.replace(/:$/, "")}` : "";
}

function tps(value: number): string {
	return `${value >= 10 ? String(Math.round(value)) : value.toFixed(1)}t/s`;
}

function intelligence(model: Model, icon: string): string {
	return model.int == null || !Number.isFinite(model.int) ? "" : `${icon} ${Math.round(model.int)}`;
}

function ttft(milliseconds: number): string {
	const seconds = milliseconds / 1000;
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}

interface Separator {
	readonly separator: true;
}
type BrowserRow = ModelBrowserItem | Separator;

interface MetricColumn {
	readonly priority: number;
	readonly cells: readonly (string | undefined)[];
}

function isModelRow(row: BrowserRow): row is ModelBrowserItem {
	return !("separator" in row);
}

function orderedRoleIds(roles: RoleAssignments): string[] {
	const ordered: string[] = [];
	const seen = new Set<string>();
	for (const role of MODEL_ROLE_IDS) {
		seen.add(role);
		ordered.push(role);
	}
	for (const role in roles) {
		if (seen.has(role)) continue;
		seen.add(role);
		ordered.push(role);
	}
	return ordered;
}

export interface ModelBrowserOptions {
	showProvider?: boolean;
	currentContextTokens?: number;
	markOverContext?: boolean;
	emptyText?: () => string | undefined;
}

export interface ModelBrowserViewProps {
	readonly items: readonly ModelBrowserItem[];
	readonly roles?: RoleAssignments;
	readonly mruOrder?: ReadonlyArray<string>;
	readonly selectedSelector?: string;
	readonly maxVisible?: number;
	readonly showProvider?: boolean;
	readonly currentContextTokens?: number;
	readonly markOverContext?: boolean;
	readonly emptyText?: string;
	readonly onSelect: (item: ModelBrowserItem) => void;
	readonly onCancel?: () => void;
	readonly query?: string;
	readonly onQueryChange?: (query: string) => void;
	readonly onKey?: (event: HostKeyEvent) => boolean;
	/** Explicit provider preference resolves otherwise-equal fuzzy matches. */
	readonly providerOrder?: ReadonlyArray<string>;
	/** Per-model observed output speed and time-to-first-token. */
	readonly perf?: ReadonlyMap<string, ModelBrowserPerf>;
	/** Virtual role rows keep their host-defined order after fuzzy filtering. */
	readonly preserveQueryOrder?: boolean;
	/** Whether the embedding pane owns keyboard focus. */
	readonly focused?: boolean;
	/** Role metadata controls role-chip labels, colors, and visibility. */
	readonly roleInfo?: (role: string) => ModelBrowserRoleInfo;
	/** Browser content width, used for the historical perf-column boundaries. */
	readonly width?: number;
	readonly onSelectionChange?: (item: ModelBrowserItem | undefined) => void;
}

const EMPTY_PERF: ReadonlyMap<string, ModelBrowserPerf> = new Map();
const PERF_TPS_MIN_WIDTH = 76;
const PERF_FULL_MIN_WIDTH = 96;
type PerfMode = "off" | "tps" | "full";

/** Rich, windowed model browser shared by the compact picker and /models hubs. */
export function ModelBrowserView(props: ModelBrowserViewProps): JSX.Element {
	const focus = useFocus();
	const theme = useTheme();
	onMount(() => focus.focus());
	const [uncontrolledQuery, setUncontrolledQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);
	const [windowStart, setWindowStart] = createSignal(0);
	const [hovered, setHovered] = createSignal<number | null>(null);
	let selectedKey: string | undefined;
	let appliedSelectedSelector: string | undefined;
	let selectedSelectorInitialized = false;
	const query = () => props.query ?? uncontrolledQuery();
	const setQuery = (value: string) => {
		setUncontrolledQuery(value);
		props.onQueryChange?.(value);
	};
	const maximum = () => Math.max(1, Math.trunc(props.maxVisible ?? 10));
	const affinity = createMemo(() =>
		buildSearchAffinity(props.providerOrder ?? [], props.roles ?? {}, props.mruOrder ?? []),
	);
	const filtered = createMemo(() => {
		if (!query().trim()) return [...props.items];
		if (props.preserveQueryOrder) return fuzzyRank(props.items, query(), modelSearchText).map(result => result.item);
		return rankModelItems(query(), props.items, {
			roles: props.roles ?? {},
			mruOrder: props.mruOrder ?? [],
			affinity: affinity(),
		});
	});
	const rows = createMemo<BrowserRow[]>(() => {
		const models = filtered();
		const recentOrRole = (item: ModelBrowserItem): boolean => {
			if ((props.mruOrder ?? []).includes(item.selector)) return true;
			for (const role in props.roles) {
				const assignment = props.roles?.[role];
				if (assignment && modelsAreEqual(assignment.model, item.model)) return true;
			}
			return false;
		};
		const firstOther = models.findIndex(item => !recentOrRole(item));
		if (firstOther <= 0 || firstOther === models.length) return models;
		return [...models.slice(0, firstOther), { separator: true }, ...models.slice(firstOther)];
	});
	const isSelected = (index: number) => selected() === index && isModelRow(rows()[index] ?? { separator: true });
	const selectedItem = (): ModelBrowserItem | undefined => {
		const row = rows()[selected()];
		return row && isModelRow(row) ? row : undefined;
	};
	const clampWindow = (value: number): number => Math.max(0, Math.min(Math.max(0, rows().length - maximum()), value));
	const ensureSelectedVisible = () => {
		const index = selected();
		if (!isSelected(index)) return;
		let next = windowStart();
		if (index < next) next = index;
		else if (index >= next + maximum()) next = index - maximum() + 1;
		next = clampWindow(next);
		if (next !== windowStart()) setWindowStart(next);
	};
	const setSelectedRow = (index: number): boolean => {
		const row = rows()[index];
		if (!row || !isModelRow(row)) return false;
		selectedKey = row.selector;
		setSelected(index);
		return true;
	};
	const selectIndex = (index: number): boolean => {
		if (!setSelectedRow(index)) return false;
		ensureSelectedVisible();
		return true;
	};
	const firstSelectable = (from: number, direction: 1 | -1, wrap: boolean): number | undefined => {
		const list = rows();
		if (!list.some(isModelRow)) return undefined;
		let index = from;
		for (let attempts = 0; attempts < list.length; attempts++) {
			index += direction;
			if (index < 0 || index >= list.length) {
				if (!wrap) return undefined;
				index = index < 0 ? list.length - 1 : 0;
			}
			if (isModelRow(list[index]!)) return index;
		}
		return undefined;
	};
	const move = (delta: number, wrap = true) => {
		const count = Math.abs(delta);
		const direction: 1 | -1 = delta < 0 ? -1 : 1;
		let index = selected();
		for (let step = 0; step < count; step++) {
			const next = firstSelectable(index, direction, wrap);
			if (next === undefined) break;
			index = next;
		}
		selectIndex(index);
	};
	const choose = () => {
		const item = selectedItem();
		if (item) props.onSelect(item);
	};
	const cancel = () => {
		if (query()) setQuery("");
		else props.onCancel?.();
	};
	const navigation = (event: HostKeyEvent): boolean => {
		if (props.onKey?.(event)) return true;
		if (matchesSelectCancel(event.data)) {
			cancel();
			return true;
		}
		if (matchesSelectUp(event.data)) {
			move(-1);
			return true;
		}
		if (matchesSelectDown(event.data)) {
			move(1);
			return true;
		}
		if (matchesSelectPageUp(event.data)) {
			move(-maximum(), false);
			return true;
		}
		if (matchesSelectPageDown(event.data)) {
			move(maximum(), false);
			return true;
		}
		if (matchesKey(event.data, "home")) {
			const first = rows().findIndex(isModelRow);
			if (first >= 0) selectIndex(first);
			return true;
		}
		if (matchesKey(event.data, "end")) {
			for (let index = rows().length - 1; index >= 0; index--) {
				if (isModelRow(rows()[index]!)) {
					selectIndex(index);
					break;
				}
			}
			return true;
		}
		if (matchesKey(event.data, "enter") || matchesKey(event.data, "return") || event.data === "\n") {
			choose();
			return true;
		}
		return false;
	};
	const onKey = (event: HostKeyEvent) => {
		if (!event.defaultPrevented && navigation(event)) {
			event.preventDefault();
			event.stopPropagation();
		}
	};
	const onInputKey = (event: HostKeyEvent) => {
		if (navigation(event)) {
			event.preventDefault();
			event.stopPropagation();
		}
	};
	const overContext = (item: ModelBrowserItem): boolean => {
		const limit = item.model.contextWindow ?? 0;
		return (
			props.markOverContext === true &&
			(props.currentContextTokens ?? 0) > 0 &&
			limit > 0 &&
			(props.currentContextTokens ?? 0) > limit
		);
	};
	const isFocused = () => props.focused ?? focus.focused();
	const perfMode = (): PerfMode => {
		const width = props.width;
		if (width === undefined || width >= PERF_FULL_MIN_WIDTH) return "full";
		return width >= PERF_TPS_MIN_WIDTH ? "tps" : "off";
	};
	const perfCell = (item: ModelBrowserItem, mode = perfMode()): string => {
		if (mode === "off") return "";
		const measured = (props.perf ?? EMPTY_PERF).get(item.selector);
		if (measured) {
			const output = tps(measured.tps);
			return mode === "full" && measured.ttftMs !== null ? `${ttft(measured.ttftMs)} ${output}` : output;
		}
		const catalog = item.model.tps;
		return catalog != null && Number.isFinite(catalog) && catalog > 0 ? `~${tps(catalog)}` : "";
	};
	const visibleRows = createMemo(() => rows().slice(windowStart(), windowStart() + maximum()));
	const metricColumns = createMemo(() => {
		const columns: MetricColumn[] = [];
		const addColumn = (priority: number, content: (item: ModelBrowserItem) => string): void => {
			const cells = visibleRows().map(entry => (isModelRow(entry) ? content(entry) : undefined));
			if (cells.some(value => value !== undefined && value.length > 0)) columns.push({ priority, cells });
		};
		if (perfMode() !== "off") {
			addColumn(0, entry => intelligence(entry.model, theme.symbol("icon.intelligence")));
			addColumn(1, perfCell);
		}
		addColumn(2, entry => context(entry.model, theme.symbol("icon.context")));
		addColumn(3, entry => cost(entry.model));
		return columns;
	});
	const roleChips = createMemo<Array<{ label: string; color: ThemeColor | undefined; assignment: RoleAssignment }>>(
		() => {
			const item = selectedItem();
			if (!item) return [];
			const matching: Array<{ label: string; color: ThemeColor | undefined; assignment: RoleAssignment }> = [];
			for (const role of orderedRoleIds(props.roles ?? {})) {
				const assignment = props.roles?.[role];
				const info = props.roleInfo?.(role);
				if (!assignment || !modelsAreEqual(assignment.model, item.model) || info?.hidden) continue;
				matching.push({ label: (info?.tag ?? info?.name ?? role).toLowerCase(), color: info?.color, assignment });
			}
			return matching;
		},
	);
	const detailFacts = createMemo(() => {
		const item = selectedItem();
		if (!item) return "";
		const model = item.model;
		const facts = [model.name];
		if (model.isNew) facts.push("new");
		if (model.isBeta) facts.push("beta");
		if (model.isRecommended) facts.push("recommended");
		if (model.contextWindow) facts.push(`${formatNumber(model.contextWindow).toLowerCase()} ctx`);
		if (model.maxTokens) facts.push(`${formatNumber(model.maxTokens).toLowerCase()} out`);
		facts.push(`${cost(model)} per M`);
		if (model.reasoning) facts.push("reasoning");
		if (model.input.includes("image")) facts.push("vision");
		const modelIntelligence = intelligence(model, theme.symbol("icon.intelligence"));
		if (modelIntelligence) facts.push(modelIntelligence);
		const measured = (props.perf ?? EMPTY_PERF).get(item.selector);
		if (measured) {
			facts.push(`~${tps(measured.tps)}`);
			if (measured.ttftMs !== null) facts.push(`${ttft(measured.ttftMs)} ttft`);
		} else if (model.tps != null && Number.isFinite(model.tps) && model.tps > 0) {
			facts.push(`~${tps(model.tps)}`);
		}
		if (model.description) {
			const modelDescription = description(model.description);
			if (modelDescription) facts.push(modelDescription);
		}
		return facts.join(" · ");
	});
	const onMouse = (event: HostMouseEvent) => {
		const listRow = event.localRow - 2;
		const index = windowStart() + listRow;
		const item = listRow >= 0 && listRow < maximum() ? rows()[index] : undefined;
		if (event.action === "wheel") {
			setWindowStart(clampWindow(windowStart() + event.wheel));
			setHovered(item && isModelRow(item) ? index : null);
			return;
		}
		if (event.action === "move") {
			setHovered(item && isModelRow(item) ? index : null);
			return;
		}
		if (event.action !== "down" || event.button !== 0 || !item || !isModelRow(item)) return;
		if (isSelected(index)) props.onSelect(item);
		else selectIndex(index);
		event.stopPropagation();
	};
	createEffect(() => {
		const list = rows();
		const externalSelector = props.selectedSelector;
		const selectorChanged = !selectedSelectorInitialized || externalSelector !== appliedSelectedSelector;
		selectedSelectorInitialized = true;
		appliedSelectedSelector = externalSelector;
		const pinned =
			selectorChanged && externalSelector
				? list.findIndex(row => isModelRow(row) && row.selector === externalSelector)
				: -1;
		const retained = selectedKey ? list.findIndex(row => isModelRow(row) && row.selector === selectedKey) : -1;
		const fallback = list.findIndex(isModelRow);
		const next = pinned >= 0 ? pinned : retained >= 0 ? retained : fallback;
		if (next >= 0) setSelectedRow(next);
		else {
			selectedKey = undefined;
			setSelected(0);
		}
		setWindowStart(current => clampWindow(current));
	});
	createEffect(() => {
		selected();
		rows();
		untrack(ensureSelectedVisible);
		props.onSelectionChange?.(selectedItem());
	});
	return (
		<box tabIndex={0} onKey={onKey} onMouse={onMouse} onMouseLeave={() => setHovered(null)}>
			<input
				tabIndex={focus.tabIndex}
				value={query()}
				prompt={` ${theme.symbol("icon.search")} > `}
				promptStyle={theme.theme().style("accent")}
				onKey={onInputKey}
				onChange={setQuery}
			/>
			<text>{""}</text>
			<scroll
				height={maximum()}
				offset={windowStart()}
				totalRows={rows().length}
				contentWindowed
				followTail={false}
				shrinkToFit={false}
			>
				{rows().length === 0 ? (
					<text color="muted" wrap="clip">
						{props.emptyText ?? (query().trim() ? "  No matching models" : "  No models available in this scope")}
					</text>
				) : (
					<row>
						<stack width={2}>
							<For each={visibleRows()}>
								{(entry, index) => (
									<text
										background={
											isModelRow(entry) && hovered() === windowStart() + index() ? "selectedBg" : undefined
										}
										color={
											isModelRow(entry) && isSelected(windowStart() + index()) && isFocused()
												? "accent"
												: "dim"
										}
									>
										{isModelRow(entry) && isSelected(windowStart() + index()) && isFocused()
											? `${theme.symbol("nav.cursor")} `
											: "  "}
									</text>
								)}
							</For>
						</stack>
						<stack grow={1} minWidth={Math.min(24, Math.max(1, (props.width ?? 26) - 2))}>
							<For each={visibleRows()}>
								{(entry, index) => {
									if (!isModelRow(entry))
										return (
											<box>
												<hr char="─" ruleColor="muted" />
											</box>
										);
									const faded = () => overContext(entry);
									return (
										<text
											background={hovered() === windowStart() + index() ? "selectedBg" : undefined}
											color={
												faded()
													? "dim"
													: (entry.labelColor ??
														(isSelected(windowStart() + index()) ? "accent" : undefined))
											}
											wrap="clip"
										>
											{props.showProvider === false ? "" : <span color="dim">{entry.provider}/</span>}
											{entry.id}
											{entry.selector === props.selectedSelector ? (
												<span color={faded() ? "dim" : "success"}> {theme.symbol("status.enabled")}</span>
											) : null}
											{faded() ? (
												<span>
													{" "}
													{theme.symbol("status.disabled")} {"context>"}
													{formatNumber(entry.model.contextWindow ?? 0).toLowerCase()}
												</span>
											) : null}
										</text>
									);
								}}
							</For>
						</stack>
						<For each={metricColumns()}>
							{(column, columnIndex) => (
								<>
									<stack width={columnIndex() === 0 ? 1 : 2}>
										<For each={visibleRows()}>
											{(entry, index) =>
												isModelRow(entry) ? (
													<text
														background={hovered() === windowStart() + index() ? "selectedBg" : undefined}
													>
														{columnIndex() === 0 ? " " : "  "}
													</text>
												) : (
													<hr char="─" ruleColor="muted" />
												)
											}
										</For>
									</stack>
									<stack shrink={1} overflowPriority={column.priority}>
										<For each={column.cells}>
											{(cell, index) =>
												cell === undefined ? (
													column.priority === 3 ? (
														<row>
															<hr grow={1} char="─" ruleColor="muted" />
															<text width={2}>{"  "}</text>
														</row>
													) : (
														<hr char="─" ruleColor="muted" />
													)
												) : (
													<text
														background={hovered() === windowStart() + index() ? "selectedBg" : undefined}
														color="dim"
														align="right"
														wrap="clip"
													>
														{cell || " "}
													</text>
												)
											}
										</For>
									</stack>
								</>
							)}
						</For>
					</row>
				)}
			</scroll>
			<text>{""}</text>
			<text color="muted" wrap="clip">
				{selectedItem() ? `  ${detailFacts()}` : ""}
			</text>
			{selectedItem() && overContext(selectedItem()!) ? (
				<text color="warning" wrap="clip">
					{"  "}
					{theme.symbol("status.disabled")} context {formatNumber(props.currentContextTokens ?? 0).toLowerCase()}{" "}
					exceeds {formatNumber(selectedItem()!.model.contextWindow ?? 0).toLowerCase()} limit · compacts with
					current model, then switches
				</text>
			) : (
				<text wrap="clip">
					{"  "}
					{selectedItem()?.selector === props.selectedSelector ? (
						<span color="success">{theme.symbol("status.enabled")} current</span>
					) : null}
					<For each={roleChips()}>
						{(entry, index) => (
							<>
								<span color="dim">
									{selectedItem()?.selector === props.selectedSelector || index() > 0 ? " · " : ""}
								</span>
								<span color={entry.assignment.autoSelected ? "dim" : (entry.color ?? "muted")}>
									{entry.assignment.autoSelected
										? theme.symbol("status.shadowed")
										: theme.symbol("status.enabled")}{" "}
									{entry.label}
								</span>
								{thinkingLevelGlyph(entry.assignment.thinkingLevel, theme.theme()) ? (
									<span color="dim"> {thinkingLevelGlyph(entry.assignment.thinkingLevel, theme.theme())}</span>
								) : null}
							</>
						)}
					</For>
				</text>
			)}
		</box>
	);
}

export function ModelBrowserOverlay(props: ModelBrowserViewProps): JSX.Element {
	const viewport = useViewport();
	return (
		<Portal to="overlay" anchor="bottom-center">
			<frame title="Models" paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
				<ModelBrowserView {...props} width={props.width ?? Math.max(1, Math.min(80, viewport().columns) - 4)} />
			</frame>
		</Portal>
	);
}

export function openModelBrowserOverlay(tui: TUI, props: ModelBrowserViewProps): OverlayDisposer {
	return mountOverlay(tui, () => <ModelBrowserOverlay {...props} />);
}
