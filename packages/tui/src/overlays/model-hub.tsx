import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { MODEL_KINDS, modelKind, type ModelKind } from "@oh-my-pi/pi-catalog/types";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { extractPrintableText, matchesKey } from "../keys";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import type { TableCell, TableRow } from "../host/elements/table";
import {
	For,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
	useClock,
	useViewport,
	type JSX,
} from "../reactive";
import { thinkingLevelGlyph } from "../render/render-utils";
import { useTheme } from "../theme/reactive";
import { AUTO_THINKING, type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../thinking";
import type { TUI } from "../tui";
import {
	buildBrowserItems,
	buildSearchAffinity,
	ModelBrowserView,
	rankModelItems,
	resolveRoleAssignments,
	sortModelItems,
	type ModelBrowserItem,
	type ModelBrowserRegistry,
	type ModelBrowserSource,
	type ModelRoleLookup,
	type ResolvedModelRoleValue,
	type RoleAssignments,
} from "./model-browser";
import { HubFrameView } from "./hub-frame";
import { formatModelSelectorValue, parseModelString, splitUpstreamRouting } from "./model-selector";

export interface ModelHubSource extends ModelBrowserSource {
	readonly disabledProviders: ReadonlyArray<string>;
	readonly fallbackChains: Record<string, string[]>;
	readonly modelRoleStorage: "global" | "project";
	readonly cycleOrder: ReadonlyArray<string>;
	getProjectModelRole(role: string): string | undefined;
	getGlobalModelRole(role: string): string | undefined;
	getModelRoleSource(role: string): "global" | "project" | "default";
}

export interface ModelHubRegistry extends ModelBrowserRegistry {
	readonly authStorage: { hasAuth(provider: string): boolean };
	getDiscoverableProviders(): string[];
	getProviderDiscoveryState(provider: string):
		| {
				optional: boolean;
				status: "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";
				fetchedAt?: number;
				error?: string;
		  }
		| undefined;
	find(provider: string, id: string): Model | undefined;
	refresh(strategy: "online"): Promise<void>;
	refreshProvider(
		provider: string,
		strategy: "online",
		options?: { refreshCommandCredentials?: boolean },
	): Promise<void>;
}

export interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

export type ModelRoleSelectionScope = "global" | "project";

export interface ModelHubCallbacks {
	onAssign(
		model: Model,
		role: string,
		thinkingLevel: ConfiguredThinkingLevel | undefined,
		selector: string,
		scope?: ModelRoleSelectionScope,
	): void | boolean | Promise<void | boolean>;
	onUnassign(role: string, scope?: ModelRoleSelectionScope): void | Promise<void>;
	onFallbackChainChange?(role: string, chain: string[]): void;
	onLoginRequest?(providerId: string): void;
	onCycleOrderChange?(order: string[]): void;
	onCancel(): void;
}

export interface ModelHubOptions {
	initialProviderId?: string;
}

type HubSection = "roles" | "all" | `provider:${string}`;
type HubEntry =
	| { kind: "roles" | "all"; id: HubSection; label: string; annotation: string }
	| {
			kind: "provider";
			id: HubSection;
			label: string;
			provider: string;
			annotation?: string;
			catalogCount: number;
			locked: boolean;
			oauth: boolean;
	  }
	| { kind: "separator"; id: string };
type RolesRow =
	| { kind: "role"; role: string }
	| { kind: "chainKey"; role: string }
	| { kind: "fallback"; role: string; chainIndex: number; selector: string }
	| { kind: "separator" }
	| { kind: "newRole" }
	| { kind: "newFallback" };
type AssignTarget =
	| { kind: "role"; role: string }
	| { kind: "fallback"; role: string; index: number | null }
	| { kind: "fallbackKey" };
type StripAction = "assign" | "unassign" | "fallback" | "fallbackModel" | "fallbackProvider" | "scope" | "thinking";
interface StripChip {
	label: string;
	action: StripAction;
	role?: string;
	scope?: ModelRoleSelectionScope;
	thinkingLevel?: ConfiguredThinkingLevel;
}
type Strip =
	| { kind: "role"; item: ModelBrowserItem; chips: readonly StripChip[]; index: number }
	| {
			kind: "scope";
			item: ModelBrowserItem;
			role: string;
			chips: readonly StripChip[];
			index: number;
			returnToRoles: boolean;
	  }
	| {
			kind: "thinking";
			item: ModelBrowserItem;
			role: string;
			chips: readonly StripChip[];
			index: number;
			returnToRoles: boolean;
			scope?: ModelRoleSelectionScope;
			fallbackIndex?: number;
			initialThinkingLevel?: ConfiguredThinkingLevel;
	  }
	| { kind: "roleName" };
interface CatalogSnapshot {
	available: readonly Model[];
	all: readonly Model[];
	error?: string;
}

const PROVIDER_REFRESH_DEBOUNCE_MS = 120;
const MODEL_KIND_TABS: ReadonlyArray<"all" | ModelKind> = ["all", ...MODEL_KINDS];

/** Providers already live-refreshed during this process. */
const autoRefreshedProviders = new Set<string>();
export function resetProviderAutoRefreshGuard(): void {
	autoRefreshedProviders.clear();
}

export interface ModelHubViewProps {
	readonly source: ModelHubSource;
	readonly registry: ModelHubRegistry;
	readonly scopedModels: ReadonlyArray<ScopedModelItem>;
	readonly callbacks: ModelHubCallbacks;
	readonly options?: ModelHubOptions;
}

function selectorFor(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function visibleRoleLabel(source: ModelHubSource, role: string): string {
	const info = source.getRoleInfo(role);
	return info.tag ?? info.name ?? role;
}

function catalogSnapshot(props: ModelHubViewProps): CatalogSnapshot {
	if (props.scopedModels.length > 0) {
		const models = props.scopedModels.map(entry => entry.model);
		return { available: models, all: models };
	}
	let all: readonly Model[] = [];
	let available: readonly Model[] = [];
	let error: string | undefined;
	try {
		all = props.registry.getAll("all");
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	}
	try {
		available = props.registry.getAvailable("all");
	} catch (cause) {
		error ??= cause instanceof Error ? cause.message : String(cause);
	}
	const registryError = props.registry.getError();
	if (registryError) error ??= String(registryError);
	return { available, all, error };
}

/** Fullscreen /models hub: model-kind browsing, role assignment, fallback chains, and provider discovery. */
export function ModelHubView(props: ModelHubViewProps): JSX.Element {
	const { theme } = useTheme();
	const clock = useClock("second");
	const viewport = useViewport();
	const [snapshot, setSnapshot] = createSignal(catalogSnapshot(props));
	const [revision, setRevision] = createSignal(0);
	const [section, setSection] = createSignal<HubSection>(
		props.options?.initialProviderId ? `provider:${props.options.initialProviderId}` : "all",
	);
	const [focus, setFocus] = createSignal<"scope" | "list">("scope");
	const [query, setQuery] = createSignal("");
	const [preferredSelector, setPreferredSelector] = createSignal<string>();
	const [modelKindTab, setModelKindTab] = createSignal<"all" | ModelKind>("all");
	const [roleIndex, setRoleIndex] = createSignal(0);
	const [roleTab, setRoleTab] = createSignal<"all" | "chat" | "kind">("all");
	const [target, setTarget] = createSignal<AssignTarget>();
	const [strip, setStrip] = createSignal<Strip>();
	const [roleName, setRoleName] = createSignal("");
	const [pending, setPending] = createSignal(false);
	const [refreshError, setRefreshError] = createSignal<string>();
	const [refreshing, setRefreshing] = createSignal<ReadonlySet<string>>(new Set());
	const [sidebarOffset, setSidebarOffset] = createSignal(0);
	const [bodyWidth, setBodyWidth] = createSignal(1);
	// The frame consumes its top and bottom border plus the footer divider and
	// footer row. Keep every pane derived from that physical viewport instead
	// of freezing a partial-height window into the fullscreen overlay.
	const contentRows = createMemo(() => Math.max(1, viewport().rows - 4));
	const sidebarRows = contentRows;
	const roleViewRows = createMemo(() => Math.max(1, contentRows() - 5));
	const modelViewRows = createMemo(() => Math.max(1, contentRows() - 7));
	let alive = true;
	const refreshTimers = new Map<string, Timer>();
	const pendingCredentialRefreshes = new Set<string>();

	const synchronize = (): void => {
		if (!alive) return;
		setSnapshot(catalogSnapshot(props));
		setRevision(value => value + 1);
	};
	const touchSettings = (): void => {
		setRevision(value => value + 1);
	};
	const availableModels = createMemo(() => snapshot().available);
	const allModels = createMemo(() => snapshot().all);
	const roles = createMemo(() => {
		revision();
		return props.source.knownRoleIds.filter(role => !props.source.getRoleInfo(role).hidden);
	});
	const assignments = createMemo<RoleAssignments>(() => {
		revision();
		return resolveRoleAssignments(props.source, [...allModels()], [...availableModels()]);
	});
	const available = createMemo(() => {
		const items = buildBrowserItems(availableModels());
		sortModelItems(items, { roles: assignments(), mruOrder: props.source.mruOrder });
		return items;
	});
	const fallbackChains = createMemo<Record<string, string[]>>(() => {
		revision();
		const chains = props.source.fallbackChains;
		if (!chains || typeof chains !== "object" || Array.isArray(chains)) return {};
		const sanitized: Record<string, string[]> = {};
		for (const key in chains) {
			const chain = chains[key];
			if (Array.isArray(chain)) sanitized[key] = chain.filter((entry): entry is string => typeof entry === "string");
		}
		return sanitized;
	});
	const providerState = createMemo(() => {
		revision();
		const disabled = new Set(props.source.disabledProviders);
		const availableCounts = new Map<string, number>();
		const catalogCounts = new Map<string, number>();
		for (const model of availableModels())
			availableCounts.set(model.provider, (availableCounts.get(model.provider) ?? 0) + 1);
		for (const model of allModels()) catalogCounts.set(model.provider, (catalogCounts.get(model.provider) ?? 0) + 1);
		const unlocked = new Set(availableCounts.keys());
		const locked = new Set<string>();
		if (props.scopedModels.length === 0) {
			for (const provider of catalogCounts.keys())
				if (!unlocked.has(provider) && !disabled.has(provider)) locked.add(provider);
			for (const provider of props.registry.getDiscoverableProviders()) {
				if (unlocked.has(provider) || disabled.has(provider)) continue;
				const hasAuth = props.registry.authStorage.hasAuth(provider);
				const discovery = props.registry.getProviderDiscoveryState(provider);
				if (!hasAuth && discovery?.optional && (discovery.status === "idle" || discovery.status === "unavailable"))
					continue;
				if (hasAuth || !locked.has(provider)) {
					locked.delete(provider);
					unlocked.add(provider);
				}
			}
		}
		return { availableCounts, catalogCounts, unlocked, locked };
	});
	const searchItems = createMemo(() => {
		const affinity = buildSearchAffinity(props.source.modelProviderOrder, assignments(), props.source.mruOrder);
		return rankModelItems(query(), available(), { roles: assignments(), mruOrder: props.source.mruOrder, affinity });
	});
	const searchCounts = createMemo(() => {
		const counts = new Map<string, number>();
		for (const item of searchItems()) counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
		return counts;
	});
	const entries = createMemo<readonly HubEntry[]>(() => {
		const state = providerState();
		const assigned = roles().filter(role => {
			const assignment = assignments()[role];
			return assignment !== undefined && !assignment.autoSelected;
		}).length;
		const oauthProviders = new Set(getOAuthProviders().map(provider => provider.id));
		const provider = (id: string, locked: boolean): HubEntry => ({
			kind: "provider",
			id: `provider:${id}`,
			label: id,
			provider: id,
			annotation: locked ? undefined : String(state.availableCounts.get(id) ?? 0),
			catalogCount: state.catalogCounts.get(id) ?? 0,
			locked,
			oauth: oauthProviders.has(id),
		});
		const rankedProviders = [...state.unlocked].sort((left, right) => {
			if (!query().trim()) return left.localeCompare(right);
			const leftMatches = searchCounts().get(left) ?? 0;
			const rightMatches = searchCounts().get(right) ?? 0;
			return (rightMatches > 0 ? 1 : 0) - (leftMatches > 0 ? 1 : 0) || left.localeCompare(right);
		});
		const result: HubEntry[] = [
			{ kind: "roles", id: "roles", label: "Roles", annotation: `${assigned}/${roles().length}` },
			{ kind: "all", id: "all", label: "All models", annotation: String(available().length) },
		];
		if (rankedProviders.length)
			result.push({ kind: "separator", id: "providers" }, ...rankedProviders.map(id => provider(id, false)));
		const locked = [...state.locked].sort((left, right) => left.localeCompare(right));
		if (locked.length) result.push({ kind: "separator", id: "locked" }, ...locked.map(id => provider(id, true)));
		return result;
	});
	const activeEntry = createMemo(() => entries().find(entry => entry.id === section()));
	const providerId = (): string | undefined => {
		const active = activeEntry();
		return active?.kind === "provider" ? active.provider : undefined;
	};
	const locked = (): boolean => {
		const entry = activeEntry();
		return entry?.kind === "provider" && entry.locked;
	};
	const rolesRows = createMemo<readonly RolesRow[]>(() => {
		const chainByRole = fallbackChains();
		const visibleRoles = roles().filter(
			role => roleTab() === "all" || props.source.getRoleInfo(role).section === roleTab(),
		);
		const rows: RolesRow[] = [];
		for (const role of visibleRoles) {
			rows.push({ kind: "role", role });
			for (const [chainIndex, selector] of (chainByRole[role] ?? []).entries())
				rows.push({ kind: "fallback", role, chainIndex, selector });
		}
		rows.push({ kind: "newRole" }, { kind: "separator" });
		for (const role of Object.keys(chainByRole)
			.filter(key => key.includes("/"))
			.sort()) {
			rows.push({ kind: "chainKey", role });
			for (const [chainIndex, selector] of (chainByRole[role] ?? []).entries())
				rows.push({ kind: "fallback", role, chainIndex, selector });
		}
		rows.push({ kind: "newFallback" });
		return rows;
	});
	const candidateItems = createMemo(() => {
		const activeTarget = target();
		if (activeTarget?.kind === "role")
			return available().filter(item => props.source.getRoleInfo(activeTarget.role).accepts(item.model));
		if (activeTarget) return available();
		const provider = providerId();
		return provider && !locked() ? available().filter(item => item.provider === provider) : available();
	});
	const kindItems = createMemo(() => {
		const tab = modelKindTab();
		return tab === "all" ? candidateItems() : candidateItems().filter(item => modelKind(item.model) === tab);
	});
	const roleOffset = createMemo(() => {
		const rows = roleViewRows();
		return Math.max(0, Math.min(Math.max(0, rolesRows().length - rows), roleIndex() - rows + 1));
	});
	const cycleRole = createMemo(() => {
		const row = rolesRows()[roleIndex()];
		return row?.kind === "role" ? row.role : "";
	});

	createEffect(() => {
		if (!entries().some(entry => entry.id === section())) setSection("all");
	});
	createEffect(() => {
		setRoleIndex(index => Math.min(index, Math.max(0, rolesRows().length - 1)));
	});
	createEffect(() => {
		const rows = sidebarRows();
		const activeIndex = entries().findIndex(entry => entry.id === section());
		if (activeIndex < 0) return;
		setSidebarOffset(offset => {
			const maxOffset = Math.max(0, entries().length - rows);
			const clamped = Math.min(offset, maxOffset);
			if (activeIndex < clamped) return activeIndex;
			if (activeIndex >= clamped + rows) return activeIndex - rows + 1;
			return clamped;
		});
	});

	const setRefreshingProvider = (provider: string, value: boolean): void => {
		setRefreshing(current => {
			const next = new Set(current);
			if (value) next.add(provider);
			else next.delete(provider);
			return next;
		});
	};
	const refreshProvider = async (provider: string, credentials: boolean): Promise<void> => {
		try {
			if (credentials) await props.registry.refreshProvider(provider, "online", { refreshCommandCredentials: true });
			else await props.registry.refreshProvider(provider, "online");
			setRefreshError(undefined);
			synchronize();
		} catch (cause) {
			if (alive) setRefreshError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (alive) {
				setRefreshingProvider(provider, false);
				if (pendingCredentialRefreshes.delete(provider)) {
					setRefreshingProvider(provider, true);
					void refreshProvider(provider, true);
				}
			}
		}
	};
	const scheduleProviderRefresh = (provider: string, force = false): void => {
		if (!provider || props.scopedModels.length > 0) return;
		const scheduled = refreshTimers.get(provider);
		if (force && scheduled) {
			clearTimeout(scheduled);
			refreshTimers.delete(provider);
			autoRefreshedProviders.add(provider);
			void refreshProvider(provider, true);
			return;
		}
		if (force && refreshing().has(provider)) {
			pendingCredentialRefreshes.add(provider);
			return;
		}
		if (!force && (scheduled || refreshing().has(provider) || autoRefreshedProviders.has(provider))) return;
		setRefreshingProvider(provider, true);
		const timer = setTimeout(() => {
			refreshTimers.delete(provider);
			autoRefreshedProviders.add(provider);
			void refreshProvider(provider, force);
		}, PROVIDER_REFRESH_DEBOUNCE_MS);
		refreshTimers.set(provider, timer);
	};
	const selectSection = (next: HubSection): void => {
		const entry = entries().find(candidate => candidate.id === next);
		if (!entry || entry.kind === "separator") return;
		if (entry.kind === "roles") setTarget(undefined);
		for (const [provider, timer] of refreshTimers) {
			if (entry.kind === "provider" && provider === entry.provider) continue;
			clearTimeout(timer);
			refreshTimers.delete(provider);
			setRefreshingProvider(provider, false);
		}
		setSection(next);
		setFocus("scope");
		if (entry.kind === "provider" && !entry.locked) scheduleProviderRefresh(entry.provider);
	};
	const moveSection = (delta: number): void => {
		const list = entries();
		let index = list.findIndex(entry => entry.id === section());
		if (index < 0) index = 0;
		for (let step = 0; step < list.length; step++) {
			index = (index + delta + list.length) % list.length;
			const next = list[index];
			if (!next || next.kind === "separator") continue;
			if (
				query().trim() &&
				(next.kind === "roles" ||
					(next.kind === "provider" && (next.locked || (searchCounts().get(next.provider) ?? 0) === 0)))
			)
				continue;
			selectSection(next.id);
			return;
		}
	};
	const finishMutation = (result: void | boolean | Promise<void | boolean>, onSuccess: () => void): void => {
		if (result instanceof Promise) {
			setPending(true);
			void result
				.then(value => {
					if (!alive) return;
					setPending(false);
					if (value !== false) onSuccess();
				})
				.catch(() => {
					if (alive) setPending(false);
				});
			return;
		}
		if (result !== false) onSuccess();
	};
	const roleForScope = (role: string, scope: ModelRoleSelectionScope): ResolvedModelRoleValue => {
		const roleLookup: ModelRoleLookup = {
			getModelRole: requested =>
				scope === "project"
					? (props.source.getProjectModelRole(requested) ?? props.source.getGlobalModelRole(requested))
					: props.source.getGlobalModelRole(requested),
		};
		const value =
			scope === "project" ? props.source.getProjectModelRole(role) : props.source.getGlobalModelRole(role);
		return props.source.resolveRoleValue(value, [...allModels()], roleLookup);
	};
	const thinkingLevelForScope = (role: string, scope: ModelRoleSelectionScope): ConfiguredThinkingLevel => {
		const value = roleForScope(role, scope);
		return value.explicitThinkingLevel ? (value.thinkingLevel ?? ThinkingLevel.Inherit) : ThinkingLevel.Inherit;
	};
	const thinkingOptions = (model: Model): readonly ConfiguredThinkingLevel[] => [
		ThinkingLevel.Inherit,
		ThinkingLevel.Off,
		AUTO_THINKING,
		...getSupportedEfforts(model),
	];
	const setFallbackChain = (role: string, chain: string[]): void => {
		props.callbacks.onFallbackChainChange?.(role, chain);
		touchSettings();
	};
	const findFallbackItem = (provider: string, id: string): ModelBrowserItem | undefined => {
		const model = props.registry.find(provider, id);
		return model ? { provider: model.provider, id: model.id, model, selector: selectorFor(model) } : undefined;
	};
	const parseFallback = (
		value: string,
	): { provider: string; id: string; thinkingLevel?: ConfiguredThinkingLevel; upstream?: string } | undefined => {
		const parse = (candidate: string) =>
			parseModelString(candidate, {
				allowMaxSuffix: true,
				allowAutoAlias: true,
				isLiteralModelId: (provider, id) => findFallbackItem(provider, id) !== undefined,
			});
		const literal = parse(value.trim());
		if (literal && findFallbackItem(literal.provider, literal.id)) return literal;
		const routing = splitUpstreamRouting(value.trim());
		if (!routing) return literal;
		const parsed = parse(routing.base.trim());
		return parsed ? { ...parsed, upstream: routing.upstream } : undefined;
	};
	const resolveFallback = (
		role: string,
		index: number,
	): { item: ModelBrowserItem; thinkingLevel?: ConfiguredThinkingLevel; upstream?: string } | undefined => {
		const raw = fallbackChains()[role]?.[index];
		if (!raw || raw.endsWith("/*")) return undefined;
		const parsed = parseFallback(raw);
		if (!parsed) return undefined;
		const item = findFallbackItem(parsed.provider, parsed.id);
		return item ? { item, thinkingLevel: parsed.thinkingLevel, upstream: parsed.upstream } : undefined;
	};
	const openThinkingStrip = (
		item: ModelBrowserItem,
		role: string,
		returnToRoles: boolean,
		scope?: ModelRoleSelectionScope,
		committed?: ConfiguredThinkingLevel,
	): void => {
		const options = thinkingOptions(item.model);
		const current =
			committed ??
			(scope ? thinkingLevelForScope(role, scope) : (assignments()[role]?.thinkingLevel ?? ThinkingLevel.Inherit));
		const index = Math.max(0, options.indexOf(current));
		setStrip({
			kind: "thinking",
			item,
			role,
			chips: options.map<StripChip>(thinkingLevel => ({
				label: getConfiguredThinkingLevelMetadata(thinkingLevel).label,
				action: "thinking",
				thinkingLevel,
			})),
			index,
			returnToRoles,
			scope,
			initialThinkingLevel: current,
		});
	};
	const assignRole = (
		item: ModelBrowserItem,
		role: string,
		returnToRoles: boolean,
		scope?: ModelRoleSelectionScope,
	): void => {
		if (props.source.modelRoleStorage === "project" && !scope) {
			setStrip({
				kind: "scope",
				item,
				role,
				chips: [
					{ label: "project", action: "scope", scope: "project" },
					{ label: "global", action: "scope", scope: "global" },
				],
				index: 0,
				returnToRoles,
			});
			return;
		}
		const previous = assignments()[role];
		let level = scope
			? thinkingLevelForScope(role, scope)
			: previous && !previous.autoSelected
				? previous.thinkingLevel
				: ThinkingLevel.Inherit;
		if (!thinkingOptions(item.model).includes(level)) level = ThinkingLevel.Inherit;
		finishMutation(props.callbacks.onAssign(item.model, role, level, item.selector, scope ?? "global"), () => {
			synchronize();
			openThinkingStrip(item, role, returnToRoles, scope, level);
		});
	};
	const unassignRole = (role: string, scope?: ModelRoleSelectionScope): void => {
		const assignment = assignments()[role];
		if (!assignment || assignment.autoSelected) return;
		const targetScope =
			scope ?? (props.source.modelRoleStorage === "project" ? props.source.getModelRoleSource(role) : "global");
		if (targetScope === "default") return;
		finishMutation(props.callbacks.onUnassign(role, targetScope), synchronize);
	};
	const startAssign = (next: AssignTarget): void => {
		setTarget(next);
		setStrip(undefined);
		setQuery("");
		setFocus("scope");
		if (next.kind === "role") {
			const assignment = assignments()[next.role];
			setPreferredSelector(assignment ? selectorFor(assignment.model) : undefined);
		} else if (next.kind === "fallback" && next.index !== null) {
			const selector = fallbackChains()[next.role]?.[next.index];
			const parsed = selector ? parseFallback(selector) : undefined;
			setPreferredSelector(parsed ? `${parsed.provider}/${parsed.id}` : undefined);
		} else {
			setPreferredSelector(undefined);
		}
	};
	const appendFallback = (item: ModelBrowserItem, role: string): void => {
		const chain = [...(fallbackChains()[role] ?? [])];
		if (chain.includes(item.selector)) return;
		chain.push(item.selector);
		setFallbackChain(role, chain);
	};
	const commitFallback = (item: ModelBrowserItem, fallbackTarget: { role: string; index: number | null }): void => {
		const chain = [...(fallbackChains()[fallbackTarget.role] ?? [])];
		if (fallbackTarget.index !== null && fallbackTarget.index < chain.length) {
			chain[fallbackTarget.index] = item.selector;
			for (let index = chain.length - 1; index >= 0; index--)
				if (index !== fallbackTarget.index && chain[index] === item.selector) chain.splice(index, 1);
		} else if (!chain.includes(item.selector)) {
			chain.push(item.selector);
		}
		setFallbackChain(fallbackTarget.role, chain);
		setTarget(undefined);
		setSection("roles");
		setFocus("list");
		setQuery("");
		const row = rolesRows().findIndex(
			entry => entry.kind === "fallback" && entry.role === fallbackTarget.role && entry.selector === item.selector,
		);
		if (row >= 0) setRoleIndex(row);
	};
	const activateItem = (item: ModelBrowserItem): void => {
		const activeTarget = target();
		if (activeTarget?.kind === "role") {
			setTarget(undefined);
			assignRole(item, activeTarget.role, true);
			return;
		}
		if (activeTarget?.kind === "fallback") {
			commitFallback(item, activeTarget);
			return;
		}
		if (activeTarget?.kind === "fallbackKey") {
			setTarget(undefined);
			setStrip({
				kind: "role",
				item,
				chips: [
					{ label: `for ${item.selector}`, action: "fallbackModel" },
					{ label: `for ${item.provider}/*`, action: "fallbackProvider" },
				],
				index: 0,
			});
			return;
		}
		const chips: StripChip[] = [];
		const scopes: readonly ModelRoleSelectionScope[] =
			props.source.modelRoleStorage === "project" ? ["project", "global"] : ["global"];
		for (const role of roles()) {
			for (const scope of scopes) {
				const configured =
					scope === "project" ? props.source.getProjectModelRole(role) : props.source.getGlobalModelRole(role);
				const assigned = configured ? roleForScope(role, scope).model : undefined;
				const assignedHere = assigned !== undefined && modelsAreEqual(assigned, item.model);
				chips.push({
					label:
						props.source.modelRoleStorage === "project"
							? `${scope} ${visibleRoleLabel(props.source, role).toLowerCase()}`
							: visibleRoleLabel(props.source, role).toLowerCase(),
					action: assignedHere ? "unassign" : "assign",
					role,
					scope,
				});
			}
		}
		chips.push(
			{ label: `fallbacks:${item.id}`, action: "fallbackModel" },
			{ label: `fallbacks:${item.provider}/*`, action: "fallbackProvider" },
			{ label: "retry-fallback", action: "fallback" },
		);
		setStrip({ kind: "role", item, chips, index: 0 });
	};
	const closeStrip = (): void => {
		const current = strip();
		setStrip(undefined);
		if ((current?.kind === "scope" || current?.kind === "thinking") && current.returnToRoles) {
			setSection("roles");
			setFocus("list");
		}
	};
	const activateStrip = (): void => {
		const current = strip();
		if (!current || current.kind === "roleName") return;
		const chip = current.chips[current.index];
		if (!chip) return;
		switch (chip.action) {
			case "assign":
				if (chip.role) {
					setStrip(undefined);
					assignRole(current.item, chip.role, false, chip.scope);
				}
				return;
			case "unassign":
				if (chip.role) unassignRole(chip.role, chip.scope);
				closeStrip();
				return;
			case "fallback":
				appendFallback(current.item, "default");
				closeStrip();
				return;
			case "fallbackModel":
				setStrip(undefined);
				startAssign({ kind: "fallback", role: current.item.selector, index: null });
				return;
			case "fallbackProvider":
				setStrip(undefined);
				startAssign({ kind: "fallback", role: `${current.item.provider}/*`, index: null });
				return;
			case "scope":
				if (current.kind === "scope" && chip.scope) {
					setStrip(undefined);
					assignRole(current.item, current.role, current.returnToRoles, chip.scope);
				}
				return;
			case "thinking": {
				if (current.kind !== "thinking" || chip.thinkingLevel === undefined) return;
				if (current.fallbackIndex !== undefined) {
					const resolved = resolveFallback(current.role, current.fallbackIndex);
					if (!resolved) return;
					const chain = [...(fallbackChains()[current.role] ?? [])];
					const routed = resolved.upstream
						? `${resolved.item.selector}@${resolved.upstream}`
						: resolved.item.selector;
					const value = formatModelSelectorValue(routed, chip.thinkingLevel);
					chain[current.fallbackIndex] = value;
					for (let index = chain.length - 1; index >= 0; index--)
						if (index !== current.fallbackIndex && chain[index] === value) chain.splice(index, 1);
					setFallbackChain(current.role, chain);
					setStrip(undefined);
					return;
				}
				const changed = chip.thinkingLevel !== current.initialThinkingLevel;
				closeStrip();
				if (changed)
					finishMutation(
						props.callbacks.onAssign(
							current.item.model,
							current.role,
							chip.thinkingLevel,
							current.item.selector,
							current.scope ?? "global",
						),
						synchronize,
					);
				return;
			}
		}
	};
	const openFallbackThinking = (row: { role: string; chainIndex: number }): void => {
		const resolved = resolveFallback(row.role, row.chainIndex);
		if (!resolved) return;
		const options: readonly ConfiguredThinkingLevel[] = [
			ThinkingLevel.Inherit,
			ThinkingLevel.Off,
			...getSupportedEfforts(resolved.item.model),
		];
		const current =
			resolved.thinkingLevel === undefined || resolved.thinkingLevel === AUTO_THINKING
				? ThinkingLevel.Inherit
				: resolved.thinkingLevel;
		setStrip({
			kind: "thinking",
			item: resolved.item,
			role: row.role,
			chips: options.map<StripChip>(thinkingLevel => ({
				label: getConfiguredThinkingLevelMetadata(thinkingLevel).label,
				action: "thinking",
				thinkingLevel,
			})),
			index: Math.max(0, options.indexOf(current)),
			returnToRoles: true,
			fallbackIndex: row.chainIndex,
		});
	};
	const removeFallback = (row: { role: string; chainIndex: number }): void => {
		const chain = [...(fallbackChains()[row.role] ?? [])];
		if (row.chainIndex >= chain.length) return;
		chain.splice(row.chainIndex, 1);
		setFallbackChain(row.role, chain);
	};
	const moveFallback = (row: { role: string; chainIndex: number }, delta: -1 | 1): void => {
		const chain = [...(fallbackChains()[row.role] ?? [])];
		const next = row.chainIndex + delta;
		if (next < 0 || next >= chain.length) return;
		[chain[row.chainIndex], chain[next]] = [chain[next], chain[row.chainIndex]];
		setFallbackChain(row.role, chain);
		setRoleIndex(index => index + delta);
	};
	const cycleOrder = (): string[] => {
		revision();
		return [...props.source.cycleOrder];
	};
	const toggleCycle = (role: string): void => {
		const order = cycleOrder();
		const index = order.indexOf(role);
		if (index >= 0) order.splice(index, 1);
		else order.push(role);
		props.callbacks.onCycleOrderChange?.(order);
		touchSettings();
	};
	const moveCycle = (role: string, delta: -1 | 1): void => {
		const order = cycleOrder();
		const index = order.indexOf(role);
		const next = index + delta;
		if (index < 0 || next < 0 || next >= order.length) return;
		[order[index], order[next]] = [order[next], order[index]];
		props.callbacks.onCycleOrderChange?.(order);
		touchSettings();
	};
	const stepRole = (delta: -1 | 1, wrap = true): void => {
		const rows = rolesRows();
		if (!rows.length) return;
		let index = roleIndex();
		for (let step = 0; step < rows.length; step++) {
			const next = index + delta;
			if (next < 0 || next >= rows.length) {
				if (!wrap) return;
				index = (next + rows.length) % rows.length;
			} else index = next;
			if (rows[index]?.kind !== "separator") {
				setRoleIndex(index);
				return;
			}
		}
	};
	const activateRoleRow = (row: RolesRow): void => {
		if (row.kind === "role") startAssign({ kind: "role", role: row.role });
		else if (row.kind === "chainKey") startAssign({ kind: "fallback", role: row.role, index: null });
		else if (row.kind === "fallback") startAssign({ kind: "fallback", role: row.role, index: row.chainIndex });
		else if (row.kind === "newFallback") startAssign({ kind: "fallbackKey" });
		else if (row.kind === "newRole") {
			setRoleName("");
			setStrip({ kind: "roleName" });
		}
	};
	const submitRoleName = (): void => {
		const name = roleName().trim();
		if (!/^[a-zA-Z0-9_-]+$/.test(name) || roles().includes(name)) return;
		setStrip(undefined);
		startAssign({ kind: "role", role: name });
	};
	const cancelAssign = (): void => {
		setTarget(undefined);
		setQuery("");
		setSection("roles");
		setFocus("list");
	};
	const moveKind = (delta: -1 | 1): void => {
		const current = MODEL_KIND_TABS.indexOf(modelKindTab());
		const next = (Math.max(0, current) + delta + MODEL_KIND_TABS.length) % MODEL_KIND_TABS.length;
		setModelKindTab(MODEL_KIND_TABS[next] ?? "all");
		setPreferredSelector(undefined);
	};
	const moveRoleTab = (delta: -1 | 1): void => {
		const tabs: readonly ("all" | "chat" | "kind")[] = ["all", "chat", "kind"];
		const current = tabs.indexOf(roleTab());
		setRoleTab(tabs[(Math.max(0, current) + delta + tabs.length) % tabs.length] ?? "all");
		setRoleIndex(0);
	};
	const handleRoleInput = (data: string): boolean => {
		if (focus() === "scope") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" || matchesKey(data, "space")) {
				setFocus("list");
				return true;
			}
			return false;
		}
		if (matchesSelectUp(data)) {
			stepRole(-1);
			return true;
		}
		if (matchesSelectDown(data)) {
			stepRole(1);
			return true;
		}
		const row = rolesRows()[roleIndex()];
		if (!row) return false;
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			activateRoleRow(row);
			return true;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "delete") || data === "x") {
			if (row.kind === "role") unassignRole(row.role);
			else if (row.kind === "fallback") removeFallback(row);
			else if (row.kind === "chainKey") setFallbackChain(row.role, []);
			return true;
		}
		if (data === "f") {
			if (row.kind === "newFallback") startAssign({ kind: "fallbackKey" });
			else if (row.kind === "role" || row.kind === "chainKey" || row.kind === "fallback")
				startAssign({ kind: "fallback", role: row.role, index: null });
			return true;
		}
		if (data === "c" && row.kind === "role") {
			toggleCycle(row.role);
			return true;
		}
		if (data === "[" || matchesKey(data, "shift+up")) {
			if (row.kind === "role") moveCycle(row.role, -1);
			else if (row.kind === "fallback") moveFallback(row, -1);
			return true;
		}
		if (data === "]" || matchesKey(data, "shift+down")) {
			if (row.kind === "role") moveCycle(row.role, 1);
			else if (row.kind === "fallback") moveFallback(row, 1);
			return true;
		}
		if (data === "n") {
			setRoleName("");
			setStrip({ kind: "roleName" });
			return true;
		}
		if (data === "t") {
			if (row.kind === "role") {
				const assignment = assignments()[row.role];
				if (!assignment) return true;
				const source =
					props.source.modelRoleStorage === "project" ? props.source.getModelRoleSource(row.role) : "global";
				const scope = source === "project" || source === "global" ? source : undefined;
				const model = scope ? roleForScope(row.role, scope).model : assignment.model;
				if (model)
					openThinkingStrip(
						{ provider: model.provider, id: model.id, model, selector: selectorFor(model) },
						row.role,
						true,
						scope,
					);
			} else if (row.kind === "fallback") openFallbackThinking(row);
			return true;
		}
		return false;
	};
	const handleStripInput = (data: string, fromInput: boolean): boolean => {
		const current = strip();
		if (!current) return false;
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			closeStrip();
			return true;
		}
		if (current.kind === "roleName") {
			if (!fromInput && (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n")) {
				submitRoleName();
				return true;
			}
			if (!fromInput) {
				const printable = extractPrintableText(data);
				if (printable) setRoleName(value => value + printable);
			}
			return false;
		}
		if (matchesKey(data, "left") || matchesSelectUp(data) || matchesKey(data, "shift+tab")) {
			setStrip(value =>
				value && value.kind !== "roleName"
					? { ...value, index: (value.index - 1 + value.chips.length) % value.chips.length }
					: value,
			);
			return true;
		}
		if (matchesKey(data, "right") || matchesSelectDown(data) || matchesKey(data, "tab")) {
			setStrip(value =>
				value && value.kind !== "roleName" ? { ...value, index: (value.index + 1) % value.chips.length } : value,
			);
			return true;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			activateStrip();
			return true;
		}
		return true;
	};
	const handleKey = (event: HostKeyEvent, fromInput = false): boolean => {
		const data = event.data;
		if (pending()) {
			if (matchesKey(data, "escape") || matchesKey(data, "esc")) props.callbacks.onCancel();
			return true;
		}
		if (strip()) return handleStripInput(data, fromInput);
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			if (target()) cancelAssign();
			else if (query()) setQuery("");
			else props.callbacks.onCancel();
			return true;
		}
		if (matchesKey(data, "f5")) {
			const active = activeEntry();
			if (active?.kind === "provider" && !active.locked) scheduleProviderRefresh(active.provider, true);
			return true;
		}
		if (matchesKey(data, "ctrl+left") && section() === "roles" && !target()) {
			moveRoleTab(-1);
			return true;
		}
		if (matchesKey(data, "ctrl+right") && section() === "roles" && !target()) {
			moveRoleTab(1);
			return true;
		}
		if (matchesKey(data, "alt+left")) {
			moveKind(-1);
			return true;
		}
		if (matchesKey(data, "alt+right")) {
			moveKind(1);
			return true;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			setFocus(value => (value === "scope" ? "list" : "scope"));
			return true;
		}
		if (matchesKey(data, "left")) {
			setFocus("scope");
			return true;
		}
		if (matchesKey(data, "right")) {
			if (!locked()) setFocus("list");
			return true;
		}
		if (focus() === "scope") {
			if (matchesSelectUp(data)) {
				moveSection(-1);
				return true;
			}
			if (matchesSelectDown(data)) {
				moveSection(1);
				return true;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				if (locked()) {
					const active = activeEntry();
					if (active?.kind === "provider" && active.oauth) props.callbacks.onLoginRequest?.(active.provider);
				} else setFocus("list");
				return true;
			}
		}
		if (section() === "roles" && !target()) {
			const printable = extractPrintableText(data);
			if (focus() === "scope" && printable?.trim()) {
				setSection("all");
				setFocus("list");
				if (!fromInput) setQuery(value => value + printable);
				return !fromInput;
			}
			return handleRoleInput(data);
		}
		if (locked() && !target()) {
			const printable = extractPrintableText(data);
			if (printable?.trim()) {
				setSection("all");
				setFocus("list");
				if (!fromInput) setQuery(value => value + printable);
				return !fromInput;
			}
			return true;
		}
		const printable = extractPrintableText(data);
		if (printable?.trim()) {
			setFocus("list");
			if (!fromInput) setQuery(value => value + printable);
			return !fromInput;
		}
		return false;
	};
	const outerKey = (event: HostKeyEvent): void => {
		if (event.defaultPrevented || !handleKey(event)) return;
		event.preventDefault();
		event.stopPropagation();
	};
	const browserKey = (event: HostKeyEvent): boolean => {
		const data = event.data;
		if (pending() || strip()) return handleKey(event, true);
		if (matchesKey(data, "f5")) {
			const active = activeEntry();
			if (active?.kind === "provider" && !active.locked) scheduleProviderRefresh(active.provider, true);
			return true;
		}
		if (matchesKey(data, "ctrl+left") && section() === "roles" && !target()) {
			moveRoleTab(-1);
			return true;
		}
		if (matchesKey(data, "ctrl+right") && section() === "roles" && !target()) {
			moveRoleTab(1);
			return true;
		}
		if (matchesKey(data, "alt+left")) {
			moveKind(-1);
			return true;
		}
		if (matchesKey(data, "alt+right")) {
			moveKind(1);
			return true;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			setFocus(value => (value === "scope" ? "list" : "scope"));
			return true;
		}
		if (matchesKey(data, "left")) {
			setFocus("scope");
			return true;
		}
		if (matchesKey(data, "right")) {
			setFocus("list");
			return true;
		}
		if (focus() === "scope") {
			if (matchesSelectUp(data)) {
				moveSection(-1);
				return true;
			}
			if (matchesSelectDown(data)) {
				moveSection(1);
				return true;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				if (target()) return false;
				setFocus("list");
				return true;
			}
		}
		const printable = extractPrintableText(data);
		if (section() === "roles" && !target() && printable?.trim()) setSection("all");
		if (printable?.trim()) setFocus("list");
		return false;
	};
	const sidebarMouse = (event: HostMouseEvent): void => {
		if (event.action !== "wheel" || event.wheel === 0) return;
		setSidebarOffset(offset =>
			Math.max(0, Math.min(Math.max(0, entries().length - sidebarRows()), offset + event.wheel)),
		);
		event.stopPropagation();
	};
	const rolesMouse = (event: HostMouseEvent): void => {
		if (event.action !== "wheel" || event.wheel === 0) return;
		stepRole(event.wheel > 0 ? 1 : -1, false);
		event.stopPropagation();
	};
	const selectRoleRow = (index: number, row: RolesRow, event: HostMouseEvent): void => {
		if (event.action !== "down") return;
		setFocus("list");
		if (index === roleIndex()) activateRoleRow(row);
		else setRoleIndex(index);
		event.preventDefault();
		event.stopPropagation();
	};
	const selectSidebarEntry = (entry: HubEntry, event: HostMouseEvent): void => {
		if (event.action !== "down" || entry.kind === "separator") return;
		const selected = entry.id === section();
		selectSection(entry.id);
		if (entry.kind === "roles") setFocus("list");
		if (selected && entry.kind === "provider" && entry.locked && entry.oauth)
			props.callbacks.onLoginRequest?.(entry.provider);
		event.preventDefault();
		event.stopPropagation();
	};
	const selectStripChip = (index: number, event: HostMouseEvent): void => {
		if (event.action !== "down") return;
		const current = strip();
		if (!current || current.kind === "roleName") return;
		if (current.index === index) activateStrip();
		else setStrip({ ...current, index });
		event.preventDefault();
		event.stopPropagation();
	};
	const stripChips = createMemo(() => {
		const current = strip();
		if (!current || current.kind === "roleName") return [];
		return current.index === 0 ? current.chips : current.chips.slice(current.index);
	});
	const emptyBrowserText = (): string => {
		const failedRefresh = refreshError();
		if (failedRefresh) return failedRefresh;
		const snapshotError = snapshot().error;
		if (snapshotError) return snapshotError;
		if (query().trim()) {
			const provider = providerId();
			return provider && !target()
				? `No matching models in ${provider}. Switch to All models to search every provider.`
				: "No matching models";
		}
		if (target()) return "No models available for this role and kind";
		const active = activeEntry();
		if (active?.kind !== "provider" || active.locked) return "No models available in this scope";
		const discovery = props.registry.getProviderDiscoveryState(active.provider);
		if (!discovery) return "No models available in this scope";
		const age = discovery.fetchedAt ? Math.max(0, clock() - discovery.fetchedAt) : undefined;
		const ageText =
			age === undefined ? undefined : age < 60_000 ? "less than a minute ago" : `${Math.round(age / 60_000)}m ago`;
		if (discovery.status === "cached")
			return ageText
				? `Using cached model list from ${ageText}. Live refresh is still pending.`
				: "Using cached model list. Live refresh is still pending.";
		if (discovery.status === "unavailable") {
			const http = discovery.error?.match(/^HTTP (\\d+) from (.+)$/);
			if (http?.[1] === "404")
				return `Discovery endpoint ${http[2]} returned 404. Point baseUrl at the host that serves /models (usually .../v1).`;
			return discovery.error
				? `Discovery failed: ${discovery.error}`
				: ageText
					? `Provider unavailable. Using cached model list from ${ageText}.`
					: "Provider unavailable.";
		}
		if (discovery.status === "unauthenticated")
			return "Provider requires authentication before models can be discovered.";
		if (discovery.status === "idle") return "Provider has not been refreshed yet.";
		if (discovery.status === "empty")
			return "Discovery succeeded but returned 0 models. Check that /models returns { data: [{ id }] }.";
		return "No models available in this scope";
	};

	onMount(() => {
		if (props.scopedModels.length) return;
		void props.registry
			.refresh("online")
			.then(synchronize)
			.catch(() => synchronize());
	});
	onCleanup(() => {
		alive = false;
		for (const timer of refreshTimers.values()) clearTimeout(timer);
		refreshTimers.clear();
		pendingCredentialRefreshes.clear();
	});

	const roleRow = (row: RolesRow, index: number): TableRow => {
		const selected = index === roleIndex();
		const cursor: TableCell = {
			text: selected && focus() === "list" ? `${theme().nav.cursor} ` : "",
			color: selected ? "accent" : "dim",
		};
		if (row.kind === "separator") return { rule: true, color: "border" };
		if (row.kind === "newRole" || row.kind === "newFallback")
			return [
				cursor,
				{
					text: row.kind === "newRole" ? "+ New role…" : "+ New fallback…",
					span: 5,
					color: selected ? "accent" : "dim",
				},
			];
		if (row.kind === "chainKey" || row.kind === "fallback")
			return [
				cursor,
				{ text: `${theme().status.shadowed} `, color: "dim" },
				{
					text: row.kind === "fallback" ? `↳ ${row.selector}` : row.role,
					span: 4,
					color: selected ? "accent" : "dim",
				},
			];
		const assignment = assignments()[row.role];
		const info = props.source.getRoleInfo(row.role);
		const cycle = cycleOrder().indexOf(row.role);
		const thinking =
			assignment && !assignment.autoSelected && assignment.thinkingLevel !== ThinkingLevel.Inherit
				? ` ${thinkingLevelGlyph(assignment.thinkingLevel, theme())} ${getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label}`
				: "";
		const value = assignment
			? `${assignment.autoSelected ? "auto → " : ""}${assignment.model.provider}/${assignment.model.id}`
			: "—";
		const color = assignment?.autoSelected ? "dim" : info.color;
		return [
			cursor,
			{
				text: `${assignment && !assignment.autoSelected ? theme().status.enabled : theme().status.shadowed} `,
				color,
			},
			{ text: `${visibleRoleLabel(props.source, row.role)} `, color, bold: selected },
			{ text: value, color: "dim" },
			{ text: thinking, color: "dim" },
			{ text: cycle >= 0 ? ` ${theme().icon.loop} ${cycle + 1}` : "", color: "accent" },
		];
	};
	const sidebar = (): JSX.Element => (
		<box height="fill" onMouse={sidebarMouse}>
			<scroll
				height={sidebarRows()}
				offset={sidebarOffset()}
				followTail={false}
				shrinkToFit={false}
				scrollbar="never"
			>
				<For each={entries()}>
					{entry => {
						if (entry.kind === "separator") return <hr char="─" ruleColor="border" />;
						const selected = () => entry.id === section();
						const searching = () => query().trim().length > 0;
						const matchCount = () =>
							entry.kind === "provider" && !entry.locked
								? searchCounts().get(entry.provider)
								: entry.kind === "all"
									? searchItems().length
									: undefined;
						const muted = () =>
							entry.kind === "provider"
								? entry.locked || (searching() && (matchCount() ?? 0) === 0)
								: searching() && entry.kind === "roles";
						const icon = () =>
							entry.kind === "roles"
								? theme().icon.extensionSkill
								: entry.kind === "all"
									? theme().icon.model
									: muted()
										? theme().status.shadowed
										: theme().status.enabled;
						return (
							<row onMouse={event => selectSidebarEntry(entry, event)}>
								<text color={selected() && focus() === "scope" ? "accent" : "dim"}>
									{selected() && focus() === "scope" ? `${theme().nav.cursor} ` : "  "}
								</text>
								<text color={muted() ? "dim" : entry.kind === "provider" ? "success" : "accent"}>
									{icon()}{" "}
								</text>
								<text
									color={muted() ? "dim" : selected() ? "accent" : undefined}
									bold={selected() && !muted()}
									wrap="clip"
									overflow="ellipsis"
								>
									{entry.label}
								</text>
								<box grow={1} minWidth={1} />
								{refreshing().has(entry.kind === "provider" ? entry.provider : "") ? (
									<spinner color="warning" />
								) : (
									<text color="dim">
										{searching() && matchCount() !== undefined ? matchCount() : (entry.annotation ?? "")}
									</text>
								)}
							</row>
						);
					}}
				</For>
			</scroll>
		</box>
	);
	const browser = (): JSX.Element => (
		<box>
			<tabs
				wrap={false}
				label="Kind"
				tabs={MODEL_KIND_TABS.map(kind => ({
					id: kind,
					label: kind,
					short: kind === "all" ? "all" : kind.slice(0, 3),
					disabled: !candidateItems().some(item => kind === "all" || modelKind(item.model) === kind),
				}))}
				active={modelKindTab()}
				showHint
				hint="Alt+←/→"
			/>
			<ModelBrowserView
				items={kindItems()}
				roles={assignments()}
				mruOrder={props.source.mruOrder}
				providerOrder={props.source.modelProviderOrder}
				perf={props.source.modelPerf}
				roleInfo={role => props.source.getRoleInfo(role)}
				query={query()}
				onQueryChange={setQuery}
				selectedSelector={preferredSelector()}
				maxVisible={modelViewRows()}
				showProvider={target() !== undefined || providerId() === undefined}
				focused={focus() === "list"}
				width={bodyWidth()}
				emptyText={emptyBrowserText()}
				onSelect={activateItem}
				onCancel={() => {
					if (target()) cancelAssign();
					else props.callbacks.onCancel();
				}}
				onKey={browserKey}
			/>
		</box>
	);
	const rolesView = (): JSX.Element => (
		<stack height="fill" onMouse={rolesMouse}>
			<tabs
				wrap={false}
				label="Roles"
				tabs={[
					{ id: "all", label: "All" },
					{ id: "chat", label: "Chat" },
					{ id: "kind", label: "Kinds" },
				]}
				active={roleTab()}
				showHint
				hint="Ctrl+←/→"
			/>
			<text color="muted" wrap="clip">
				Model roles · f retry fallback · x clear · t thinking · c Ctrl+P cycle
			</text>
			<scroll height={roleViewRows()} offset={roleOffset()} followTail={false} shrinkToFit={false}>
				<table
					columns={[
						{ width: 2 },
						{ width: 2 },
						{ intrinsic: true },
						{ grow: 1, minWidth: 1 },
						{ intrinsic: true },
						{ intrinsic: true },
					]}
					gap={0}
					rows={rolesRows().map(roleRow)}
					onMouse={event => {
						const row = rolesRows()[event.localRow];
						if (row && row.kind !== "separator") selectRoleRow(event.localRow, row, event);
					}}
				/>
			</scroll>
			{rolesRows().length > roleViewRows() ? (
				<text color="dim" wrap="clip">
					{roleOffset() > 0 ? `↑ ${roleOffset()} more` : ""}
					{roleOffset() + roleViewRows() < rolesRows().length
						? `${roleOffset() > 0 ? " · " : ""}↓ ${rolesRows().length - roleOffset() - roleViewRows()} more`
						: ""}
				</text>
			) : (
				<box grow={1} />
			)}
			{cycleOrder().length ? (
				<row>
					<text color="dim">Ctrl+P cycle: </text>
					<For each={cycleOrder()}>
						{(role, index) => (
							<text color={role === cycleRole() ? "accent" : "muted"} bold={role === cycleRole()}>
								{role}
								{index() < cycleOrder().length - 1 ? " → " : ""}
							</text>
						)}
					</For>
				</row>
			) : (
				<text color="dim" wrap="clip">
					Ctrl+P cycle is empty — press c on a role to add it
				</text>
			)}
		</stack>
	);
	const lockedView = (): JSX.Element => {
		const active = activeEntry();
		if (!active || active.kind !== "provider") return <box />;
		const envVars = providerEntry(active.provider)?.envVars ?? [];
		const catalog = allModels().filter(model => model.provider === active.provider);
		return (
			<box>
				<text color="warning">{active.provider} has no credentials configured</text>
				<text color="dim" wrap="word">
					{envVars.length
						? `Set ${envVars.join(" or ")} in your environment, or add a key in config.`
						: "Add an API key for this provider in config."}
				</text>
				{active.oauth ? (
					<text
						color="accent"
						onMouse={event => {
							if (event.action === "down") {
								props.callbacks.onLoginRequest?.(active.provider);
								event.preventDefault();
								event.stopPropagation();
							}
						}}
					>
						› Log in with OAuth (Enter)
					</text>
				) : null}
				{catalog.length ? (
					<box>
						<text color="dim">{catalog.length} models in catalog:</text>
						<For each={catalog.slice(0, 10)}>{model => <text color="dim"> {model.id}</text>}</For>
					</box>
				) : null}
			</box>
		);
	};
	const status = (): string => {
		if (pending()) return "Applying model…";
		const activeTarget = target();
		if (activeTarget?.kind === "fallbackKey")
			return "New fallback chain — Enter picks the model it protects, Esc cancels";
		if (activeTarget?.kind === "fallback")
			return `${activeTarget.index === null ? "Adding" : "Replacing"} fallback for ${visibleRoleLabel(props.source, activeTarget.role)} — Enter picks the fallback model, Esc cancels`;
		if (activeTarget?.kind === "role")
			return `Assigning ${visibleRoleLabel(props.source, activeTarget.role)} — Enter assigns, Esc cancels`;
		const active = activeEntry();
		const failedRefresh = refreshError();
		if (failedRefresh) return failedRefresh;
		const snapshotError = snapshot().error;
		if (snapshotError && active?.kind !== "provider") return snapshotError;
		if (active?.kind === "roles") return "Model roles — cleared roles fall back to auto-selection";
		if (active?.kind === "provider") {
			if (active.locked) return `${active.provider} · not configured`;
			if (refreshing().has(active.provider)) return `${active.provider} · refreshing model list…`;
			return `${active.provider} · ${active.annotation ?? "0"} models${props.scopedModels.length ? " · --models scope" : ""}`;
		}
		return `All available models${props.scopedModels.length ? " · --models scope" : ""}`;
	};
	const footer = (): JSX.Element => {
		const current = strip();
		if (current?.kind === "roleName")
			return (
				<row>
					<text color="accent">New role name:</text>
					<box grow={1}>
						<input
							value={roleName()}
							prompt=" "
							onChange={setRoleName}
							onSubmit={submitRoleName}
							onEscape={closeStrip}
						/>
					</box>
					<text color="dim">letters, digits, - and _</text>
				</row>
			);
		if (current)
			return (
				<row>
					<text color="dim" wrap="clip">
						{current.kind === "role"
							? `${current.item.id} → `
							: `${visibleRoleLabel(props.source, current.role).toLowerCase()} · ${current.item.id} → `}
					</text>
					{current.index > 0 ? <text color="dim">… </text> : null}
					<For each={stripChips()}>
						{chip => {
							const index = current.chips.indexOf(chip);
							return (
								<text
									color={index === current.index ? "accent" : "muted"}
									bold={index === current.index}
									wrap="clip"
									onMouse={event => selectStripChip(index, event)}
								>
									{index === current.index ? `[ ${chip.label} ] ` : `${chip.label} `}
								</text>
							);
						}}
					</For>
				</row>
			);
		if (target())
			return (
				<text color="dim" wrap="clip">
					Enter pick · ↑/↓ providers · type to search · Alt+←/→ kind · Esc cancel
				</text>
			);
		if (section() === "roles") {
			if (focus() === "scope") return <text color="dim">↑/↓ providers · → roles · Esc close</text>;
			const row = rolesRows()[roleIndex()];
			if (row?.kind === "fallback")
				return (
					<text color="dim">
						↑/↓ rows · Enter replace · f add · x remove
						{resolveFallback(row.role, row.chainIndex) ? " · t thinking" : ""} · [/] reorder · ← providers
					</text>
				);
			if (row?.kind === "chainKey")
				return <text color="dim">↑/↓ rows · Enter/f add fallback · x clear chain · ← providers</text>;
			if (row?.kind === "newFallback")
				return <text color="dim">↑/↓ rows · Enter new model/provider fallback chain · ← providers</text>;
			return (
				<text color="dim">
					↑/↓ rows · Enter pick · f fallback · x clear · t thinking · c cycle · [/] reorder · n new
				</text>
			);
		}
		if (locked()) {
			const active = activeEntry();
			return (
				<text color="dim">
					{active?.kind === "provider" && active.oauth ? "Enter log in · " : ""}↑/↓ providers · Esc close
				</text>
			);
		}
		return (
			<text color="dim" wrap="clip">
				Enter assign roles · {focus() === "scope" ? "↑/↓ providers · → models" : "↑/↓ models · ← providers"} · type
				to search · Alt+←/→ kind{providerId() ? " · F5 refresh" : ""} · Esc close
			</text>
		);
	};
	const body = (): JSX.Element =>
		section() === "roles" && !target() ? rolesView() : locked() && !target() ? lockedView() : browser();
	return (
		<box height="fill" tabIndex={0} onKey={outerKey}>
			<HubFrameView
				title="Models"
				sidebar={sidebar()}
				body={
					<stack height="fill">
						<text color={snapshot().error || refreshError() ? "error" : "muted"} wrap="clip">
							{status()}
						</text>
						<box grow={1}>{body()}</box>
					</stack>
				}
				footer={footer()}
				sidebarSize={{ content: true, min: 18, max: 26 }}
				onPaneLayout={({ rightWidth }) => setBodyWidth(Math.max(1, rightWidth))}
				scrollPanes={false}
				viewportHeight={viewport().rows}
			/>
		</box>
	);
}

export function openModelHubOverlay(
	tui: TUI,
	source: ModelHubSource,
	registry: ModelHubRegistry,
	scopedModels: ReadonlyArray<ScopedModelItem>,
	callbacks: ModelHubCallbacks,
	options?: ModelHubOptions,
): OverlayDisposer {
	return mountOverlay(tui, () => (
		<Portal to="overlay" fullscreen anchor="top-left" width="100%" maxHeight="100%" margin={0} mouseTracking>
			<ModelHubView
				source={source}
				registry={registry}
				scopedModels={scopedModels}
				callbacks={callbacks}
				options={options}
			/>
		</Portal>
	));
}
