import type { Model } from "@oh-my-pi/pi-ai";
import { Editor } from "../components/editor";
import { fuzzyMatch } from "../fuzzy";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import { matchesKey } from "../keys";
import { matchesAppFollowUp } from "../keybinding-matchers";
import { For, createEffect, createMemo, createSignal, onCleanup, onMount, useFocus, type JSX } from "../reactive";
import { shortenPath } from "../render/render-utils";
import { getEditorTheme } from "../theme/theme";
import type { TUI } from "../tui";
import type { AgentSource } from "../tools/task";
import { HubFrameView } from "./hub-frame";
import {
	buildBrowserItems,
	ModelBrowserView,
	sortModelItems,
	type ModelBrowserItem,
	type ModelBrowserSource,
} from "./model-browser";

/** One discovered agent with settings overrides resolved for display. */
export interface HubAgent {
	name: string;
	description: string;
	systemPrompt: string;
	source: AgentSource;
	filePath?: string;
	model?: string[];
	prewalk?: boolean | string;
	advisor?: boolean | string;
	disabled: boolean;
	overrideModel?: string;
	prewalkOverride?: string;
	advisorOverride?: string;
}

export interface GeneratedAgentSpec {
	identifier: string;
	whenToUse: string;
	systemPrompt: string;
}

type PropertyKind = "model" | "prewalk" | "advisor";
type Scope = "all" | "new" | AgentSource;
type HubFocus = "scope" | "list";
type ListRow = { readonly kind: "agent"; readonly agent: HubAgent } | { readonly kind: "new" };
type SidebarEntry =
	| {
			readonly kind: "all" | "source" | "new";
			readonly id: Scope;
			readonly label: string;
			readonly annotation?: string;
	  }
	| { readonly kind: "separator"; readonly id: "sources" | "actions" };
type StripAction =
	| { readonly kind: "toggle" }
	| { readonly kind: "property"; readonly property: PropertyKind }
	| { readonly kind: "set"; readonly property: PropertyKind; readonly value: string | undefined }
	| { readonly kind: "pick"; readonly property: PropertyKind }
	| { readonly kind: "pattern"; readonly property: PropertyKind };
type StripChip = {
	readonly label: string;
	readonly tone?: "accent" | "dim" | "warning" | "muted" | "success";
	readonly active?: boolean;
	readonly action: StripAction;
};
type AgentStrip = { readonly kind: "agent"; readonly agentName: string; readonly index: number };
type PropertyStrip = {
	readonly kind: "property";
	readonly agentName: string;
	readonly property: PropertyKind;
	readonly index: number;
};
type PatternStrip = {
	readonly kind: "pattern";
	readonly agentName: string;
	readonly property: PropertyKind;
	readonly value: string;
};
type Strip = AgentStrip | PropertyStrip | PatternStrip;

export interface AgentsHubDeps {
	browserSource: ModelBrowserSource;
	loadAgents(): Promise<HubAgent[]>;
	getAvailableModels(): Model[];
	effectiveModelPatterns(agent: HubAgent): string[];
	resolvePatterns(patterns: string[]): string | undefined;
	effectivePrewalkPattern(agent: HubAgent): string | undefined;
	effectiveAdvisorPattern(agent: HubAgent): string | undefined;
	setDisabledAgents(names: string[]): void;
	setOverrides(property: PropertyKind, overrides: Record<string, string>): void;
	generateAgent(description: string, onText: (text: string) => void): Promise<string>;
	saveAgent(scope: "project" | "user", spec: GeneratedAgentSpec): Promise<string>;
}

export interface AgentsHubCallbacks {
	onCancel(): void;
}

export interface AgentsHubViewProps {
	readonly deps: AgentsHubDeps;
	readonly callbacks: AgentsHubCallbacks;
	readonly terminalRows?: number;
}

const SOURCE_LABEL: Record<AgentSource, string> = {
	project: "Project",
	user: "User",
	bundled: "Bundled",
};
const SOURCE_ORDER: Record<AgentSource, number> = { project: 0, user: 1, bundled: 2 };
const SOURCES: readonly AgentSource[] = ["project", "user", "bundled"];
const PROPERTIES: readonly PropertyKind[] = ["model", "prewalk", "advisor"];

function isAgentSource(scope: Scope): scope is AgentSource {
	return scope === "project" || scope === "user" || scope === "bundled";
}

function extractJsonObject(raw: string): string {
	const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
	if (fence) return fence.trim();
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	return start >= 0 && end >= start ? raw.slice(start, end + 1).trim() : raw.trim();
}

/** Validate the architect's complete agent file contract before it can be persisted. */
export function parseGeneratedAgentSpec(raw: string): GeneratedAgentSpec {
	const parsed: unknown = JSON.parse(extractJsonObject(raw));
	if (typeof parsed !== "object" || parsed === null) throw new Error("Model output is not a JSON object");
	if (
		!("identifier" in parsed) ||
		!("whenToUse" in parsed) ||
		!("systemPrompt" in parsed) ||
		typeof parsed.identifier !== "string" ||
		typeof parsed.whenToUse !== "string" ||
		typeof parsed.systemPrompt !== "string"
	) {
		throw new Error("Model output is missing required fields (identifier, whenToUse, systemPrompt)");
	}
	const result = {
		identifier: parsed.identifier.trim(),
		whenToUse: parsed.whenToUse.trim(),
		systemPrompt: parsed.systemPrompt.trim(),
	};
	if (!/^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/.test(result.identifier)) {
		throw new Error("Generated identifier is invalid (must be lowercase kebab-case, 2+ words)");
	}
	if (!result.whenToUse.toLowerCase().startsWith("use this agent when")) {
		throw new Error("Generated whenToUse must start with 'Use this agent when...'");
	}
	if (!result.systemPrompt) throw new Error("Generated systemPrompt is empty");
	return result;
}

function matchesAgent(agent: HubAgent, query: string): boolean {
	const text = `${agent.name} ${agent.description} ${SOURCE_LABEL[agent.source]} ${agent.overrideModel ?? ""}`;
	return query
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.every(token => fuzzyMatch(token, text).matches);
}

function isSubmit(data: string): boolean {
	return matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n";
}

function overrideFor(agent: HubAgent, property: PropertyKind): string | undefined {
	if (property === "model") return agent.overrideModel;
	if (property === "prewalk") return agent.prewalkOverride;
	return agent.advisorOverride;
}

function withOverride(agent: HubAgent, property: PropertyKind, value: string | undefined): HubAgent {
	if (property === "model") return { ...agent, overrideModel: value };
	if (property === "prewalk") return { ...agent, prewalkOverride: value };
	return { ...agent, advisorOverride: value };
}

/** Fullscreen /agents roster: scopes, persistent configuration strips, model assignment and architect creation. */
export function AgentsHubView(props: AgentsHubViewProps): JSX.Element {
	const viewportHeight = Math.max(16, props.terminalRows ?? process.stdout.rows ?? 40);
	const listViewportRows = Math.max(3, viewportHeight - 11);
	const rootFocus = useFocus();
	const createFocus = useFocus();
	const patternFocus = useFocus();
	const [agents, setAgents] = createSignal<readonly HubAgent[]>([]);
	const [scope, setScope] = createSignal<Scope>("all");
	const [focus, setFocus] = createSignal<HubFocus>("list");
	const [rowIndex, setRowIndex] = createSignal(0);
	const [listOffset, setListOffset] = createSignal(0);
	const [sidebarOffset, setSidebarOffset] = createSignal(0);
	const [query, setQuery] = createSignal("");
	const [notice, setNotice] = createSignal<string>();
	const [loadError, setLoadError] = createSignal<string>();
	const [strip, setStrip] = createSignal<Strip>();
	const [assigning, setAssigning] = createSignal<{ readonly agentName: string; readonly property: PropertyKind }>();
	const [browserQuery, setBrowserQuery] = createSignal("");
	const [rowHover, setRowHover] = createSignal<number>();
	const [sidebarHover, setSidebarHover] = createSignal<Scope>();
	const [createEditor, setCreateEditor] = createSignal<Editor>();
	const [createDescription, setCreateDescription] = createSignal("");
	const [createScope, setCreateScope] = createSignal<"project" | "user">("project");
	const [creating, setCreating] = createSignal(false);
	const [createdSpec, setCreatedSpec] = createSignal<GeneratedAgentSpec>();
	const [createError, setCreateError] = createSignal<string>();
	const [streamingText, setStreamingText] = createSignal("");
	let alive = true;
	let loadGeneration = 0;
	let createGeneration = 0;

	const sidebarEntries = createMemo<readonly SidebarEntry[]>(() => {
		const counts: Record<AgentSource, number> = { project: 0, user: 0, bundled: 0 };
		for (const agent of agents()) counts[agent.source]++;
		const entries: SidebarEntry[] = [
			{ kind: "all", id: "all", label: "All agents", annotation: String(agents().length) },
		];
		const available = SOURCES.filter(source => counts[source] > 0);
		if (available.length > 0) {
			entries.push({ kind: "separator", id: "sources" });
			for (const source of available)
				entries.push({
					kind: "source",
					id: source,
					label: SOURCE_LABEL[source],
					annotation: String(counts[source]),
				});
		}
		entries.push({ kind: "separator", id: "actions" }, { kind: "new", id: "new", label: "New agent" });
		return entries;
	});
	const sidebarWidth = createMemo(() => {
		let longest = 0;
		for (const entry of sidebarEntries()) {
			if (entry.kind === "separator") continue;
			longest = Math.max(longest, entry.label.length + (entry.annotation?.length ?? 0) + 5);
		}
		return Math.max(16, Math.min(24, longest));
	});
	const scopedAgents = createMemo(() => {
		const selectedScope = scope();
		const candidates = isAgentSource(selectedScope)
			? agents().filter(agent => agent.source === selectedScope)
			: agents();
		return candidates.filter(agent => matchesAgent(agent, query()));
	});
	const rows = createMemo<readonly ListRow[]>(() => {
		const result: ListRow[] = [];
		for (const agent of scopedAgents()) result.push({ kind: "agent", agent });
		result.push({ kind: "new" });
		return result;
	});
	const selectedRow = createMemo(() => rows()[rowIndex()]);
	const selectedAgent = createMemo(() => {
		const row = selectedRow();
		return row?.kind === "agent" ? row.agent : undefined;
	});
	const creationActive = createMemo(() => createEditor() !== undefined || creating() || createdSpec() !== undefined);
	const currentStripAgent = createMemo(() => {
		const current = strip();
		return current ? agents().find(agent => agent.name === current.agentName) : undefined;
	});
	const browserItems = createMemo<readonly ModelBrowserItem[]>(() => {
		if (!assigning()) return [];
		const items = buildBrowserItems(props.deps.getAvailableModels());
		sortModelItems(items, { mruOrder: props.deps.browserSource.mruOrder });
		return items;
	});

	const clampRow = (index: number): number => Math.max(0, Math.min(Math.max(0, rows().length - 1), index));
	const revealRow = (index: number) => {
		setListOffset(previous => {
			if (index < previous) return index;
			if (index >= previous + listViewportRows) return index - listViewportRows + 1;
			return previous;
		});
	};
	const selectRow = (index: number) => {
		const next = clampRow(index);
		setRowIndex(next);
		revealRow(next);
	};
	const resetList = () => {
		setRowIndex(0);
		setListOffset(0);
		setRowHover(undefined);
	};
	const setSearch = (value: string) => {
		setQuery(value);
		resetList();
	};
	const agentByName = (name: string): HubAgent | undefined => agents().find(agent => agent.name === name);
	const closeStrip = () => setStrip(undefined);

	const reload = async (): Promise<void> => {
		const generation = ++loadGeneration;
		const selectedName = selectedAgent()?.name;
		setLoadError(undefined);
		try {
			const loaded = [...(await props.deps.loadAgents())].sort(
				(left, right) =>
					SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || left.name.localeCompare(right.name),
			);
			if (!alive || generation !== loadGeneration) return;
			setAgents(loaded);
			const activeStrip = strip();
			if (activeStrip && !loaded.some(agent => agent.name === activeStrip.agentName)) setStrip(undefined);
			const activeAssignment = assigning();
			if (activeAssignment && !loaded.some(agent => agent.name === activeAssignment.agentName)) {
				setAssigning(undefined);
				setBrowserQuery("");
			}
			const nextScope = scope();
			const visible = (
				isAgentSource(nextScope) ? loaded.filter(agent => agent.source === nextScope) : loaded
			).filter(agent => matchesAgent(agent, query()));
			const index = selectedName ? visible.findIndex(agent => agent.name === selectedName) : -1;
			selectRow(index >= 0 ? index : 0);
		} catch (cause) {
			if (!alive || generation !== loadGeneration) return;
			setAgents([]);
			resetList();
			setLoadError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const describeProperty = (agent: HubAgent, property: PropertyKind): string => {
		if (property === "model") {
			const patterns = props.deps.effectiveModelPatterns(agent);
			const resolved = props.deps.resolvePatterns(patterns);
			const base = agent.overrideModel ?? (patterns.length > 0 ? patterns.join(",") : "session model");
			return `${agent.name} model: ${base}${resolved ? ` → ${resolved}` : ""}`;
		}
		const pattern =
			property === "prewalk" ? props.deps.effectivePrewalkPattern(agent) : props.deps.effectiveAdvisorPattern(agent);
		return `${agent.name} ${property}: ${pattern ? `on (${pattern})` : "off"}`;
	};
	const toggleAgent = (agentName: string) => {
		const target = agentByName(agentName);
		if (!target) return;
		const next = agents().map(agent => (agent.name === agentName ? { ...agent, disabled: !agent.disabled } : agent));
		setAgents(next);
		props.deps.setDisabledAgents(
			next
				.filter(agent => agent.disabled)
				.map(agent => agent.name)
				.sort((left, right) => left.localeCompare(right)),
		);
		const updated = next.find(agent => agent.name === agentName);
		if (updated) setNotice(`${updated.name} ${updated.disabled ? "disabled" : "enabled"}`);
	};
	const setOverride = (agentName: string, property: PropertyKind, value: string | undefined) => {
		const target = agentByName(agentName);
		if (!target) return;
		const trimmed = value?.trim() || undefined;
		const next = agents().map(agent => (agent.name === agentName ? withOverride(agent, property, trimmed) : agent));
		setAgents(next);
		const overrides: Record<string, string> = {};
		for (const agent of next) {
			const override = overrideFor(agent, property)?.trim();
			if (override) overrides[agent.name] = override;
		}
		props.deps.setOverrides(property, overrides);
		const updated = next.find(agent => agent.name === agentName);
		if (updated) setNotice(describeProperty(updated, property));
	};
	const propertySummary = (agent: HubAgent, property: PropertyKind): string => {
		if (property === "model") return agent.overrideModel ?? "auto";
		return (
			(property === "prewalk"
				? props.deps.effectivePrewalkPattern(agent)
				: props.deps.effectiveAdvisorPattern(agent)) ?? "off"
		);
	};
	const openAgentStrip = (agentName: string) => setStrip({ kind: "agent", agentName, index: 1 });
	const openPropertyStrip = (agentName: string, property: PropertyKind) =>
		setStrip({ kind: "property", agentName, property, index: 0 });
	const openPatternStrip = (agentName: string, property: PropertyKind) => {
		const agent = agentByName(agentName);
		if (!agent) return;
		setStrip({ kind: "pattern", agentName, property, value: overrideFor(agent, property) ?? "" });
		patternFocus.focus();
	};
	const startAssign = (agentName: string, property: PropertyKind) => {
		closeStrip();
		setBrowserQuery("");
		setAssigning({ agentName, property });
	};
	const cancelAssign = () => {
		setAssigning(undefined);
		setBrowserQuery("");
		rootFocus.focus();
	};
	const commitPickedModel = (item: ModelBrowserItem) => {
		const target = assigning();
		if (!target) return;
		setAssigning(undefined);
		setBrowserQuery("");
		setOverride(target.agentName, target.property, item.selector);
		rootFocus.focus();
	};

	const stripChips = createMemo<readonly StripChip[]>(() => {
		const current = strip();
		const agent = currentStripAgent();
		if (!current || current.kind === "pattern" || !agent) return [];
		if (current.kind === "agent") {
			const chips: StripChip[] = [
				{
					label: agent.disabled ? "enable" : "disable",
					tone: agent.disabled ? "success" : "dim",
					action: { kind: "toggle" },
				},
			];
			for (const property of PROPERTIES) {
				chips.push({
					label: `${property}: ${propertySummary(agent, property)}`,
					tone: "accent",
					action: { kind: "property", property },
				});
			}
			return chips;
		}
		const currentValue = overrideFor(agent, current.property)?.toLowerCase();
		if (current.property === "model") {
			const chips: StripChip[] = [
				{ label: "pick model…", tone: "accent", action: { kind: "pick", property: "model" } },
				{ label: "pattern…", tone: "muted", action: { kind: "pattern", property: "model" } },
			];
			if (agent.overrideModel)
				chips.push({
					label: "clear override",
					tone: "warning",
					action: { kind: "set", property: "model", value: undefined },
				});
			return chips;
		}
		const option = (label: string, value: string | undefined): StripChip => ({
			label,
			tone: currentValue === value ? "accent" : "muted",
			active: currentValue === value,
			action: { kind: "set", property: current.property, value },
		});
		return [
			option("agent default", undefined),
			option("on", "on"),
			option("off", "off"),
			{ label: "pick model…", tone: "accent", action: { kind: "pick", property: current.property } },
			{ label: "pattern…", tone: "muted", action: { kind: "pattern", property: current.property } },
		];
	});
	const setStripIndex = (index: number) => {
		setStrip(current => (current?.kind === "pattern" ? current : current ? { ...current, index } : current));
	};
	const activateStripChip = () => {
		const current = strip();
		const agent = currentStripAgent();
		if (!current || current.kind === "pattern" || !agent) return;
		const chip = stripChips()[current.index];
		if (!chip) return;
		switch (chip.action.kind) {
			case "toggle":
				toggleAgent(agent.name);
				closeStrip();
				return;
			case "property":
				openPropertyStrip(agent.name, chip.action.property);
				return;
			case "set":
				setOverride(agent.name, chip.action.property, chip.action.value);
				closeStrip();
				return;
			case "pick":
				startAssign(agent.name, chip.action.property);
				return;
			case "pattern":
				openPatternStrip(agent.name, chip.action.property);
				return;
		}
	};
	const submitPattern = () => {
		const current = strip();
		if (!current || current.kind !== "pattern") return;
		setOverride(current.agentName, current.property, current.value);
		closeStrip();
		rootFocus.focus();
	};
	const changePattern = (value: string) =>
		setStrip(current => (current?.kind === "pattern" ? { ...current, value } : current));

	const beginCreateFlow = () => {
		if (creating()) return;
		const editor = new Editor(getEditorTheme());
		editor.setBorderVisible(false);
		editor.setPromptGutter("> ");
		editor.setMaxHeight(8);
		editor.disableSubmit = true;
		setCreateEditor(editor);
		setCreateDescription("");
		setCreateScope("project");
		setCreatedSpec(undefined);
		setCreateError(undefined);
		setStreamingText("");
		createFocus.focus();
	};
	const clearCreateFlow = () => {
		createGeneration++;
		setCreateEditor(undefined);
		setCreateDescription("");
		setCreating(false);
		setCreatedSpec(undefined);
		setCreateError(undefined);
		setStreamingText("");
		rootFocus.focus();
	};
	const generateAgent = (rawDescription: string) => {
		const description = rawDescription.trim();
		setCreateDescription(description);
		if (!description) {
			setCreateError("Description is required.");
			return;
		}
		const generation = ++createGeneration;
		setCreating(true);
		setCreateError(undefined);
		setCreatedSpec(undefined);
		setStreamingText("");
		void props.deps
			.generateAgent(description, text => {
				if (alive && generation === createGeneration) setStreamingText(current => current + text);
			})
			.then(parseGeneratedAgentSpec)
			.then(spec => {
				if (alive && generation === createGeneration) setCreatedSpec(spec);
			})
			.catch(cause => {
				if (alive && generation === createGeneration)
					setCreateError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (alive && generation === createGeneration) setCreating(false);
			});
	};
	const saveGeneratedAgent = () => {
		const spec = createdSpec();
		if (!spec || creating()) return;
		setCreating(true);
		setCreateError(undefined);
		void props.deps
			.saveAgent(createScope(), spec)
			.then(filePath => {
				if (!alive) return;
				setNotice(`Created agent ${spec.identifier} at ${shortenPath(filePath)}`);
				clearCreateFlow();
				void reload();
			})
			.catch(cause => {
				if (alive) setCreateError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (alive) setCreating(false);
			});
	};
	const handleCreateEditorKey = (event: HostKeyEvent) => {
		const data = event.data;
		const editor = createEditor();
		if (!editor) return;
		if (matchesKey(data, "escape")) {
			if (!creating()) clearCreateFlow();
		} else if (!creating() && matchesAppFollowUp(data)) {
			generateAgent(editor.getExpandedText());
		} else if (!creating() && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
			setCreateScope(current => (current === "project" ? "user" : "project"));
		} else if (!creating()) {
			editor.handleInput(data);
			setCreateDescription(editor.getExpandedText());
		}
		event.preventDefault();
		event.stopPropagation();
	};
	const handleCreateRootKey = (data: string): boolean => {
		if (creating()) return true;
		if (createdSpec()) {
			if (matchesKey(data, "escape")) clearCreateFlow();
			else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))
				setCreateScope(current => (current === "project" ? "user" : "project"));
			else if (data.toLowerCase() === "r") generateAgent(createDescription());
			else if (isSubmit(data)) saveGeneratedAgent();
			return true;
		}
		return false;
	};

	const selectScope = (entry: SidebarEntry) => {
		if (entry.kind === "separator") return;
		setScope(entry.id);
		setFocus("scope");
		setSidebarOffset(previous => Math.max(0, previous));
		if (entry.kind !== "new") resetList();
	};
	const activateScope = () => {
		if (scope() === "new") beginCreateFlow();
		else setFocus("list");
	};
	const moveScope = (delta: number) => {
		const entries = sidebarEntries().filter(
			(entry): entry is Exclude<SidebarEntry, { readonly kind: "separator" }> => entry.kind !== "separator",
		);
		const current = Math.max(
			0,
			entries.findIndex(entry => entry.id === scope()),
		);
		const target = entries[(current + delta + entries.length) % entries.length];
		if (target) selectScope(target);
	};
	const activateRow = (row: ListRow | undefined) => {
		if (!row || creating()) return;
		if (row.kind === "new") beginCreateFlow();
		else openAgentStrip(row.agent.name);
	};
	const handleStripKey = (data: string): boolean => {
		const current = strip();
		if (!current) return false;
		if (current.kind === "pattern") return false;
		if (matchesKey(data, "escape")) {
			if (current.kind === "property") openAgentStrip(current.agentName);
			else closeStrip();
			return true;
		}
		const chips = stripChips();
		if (chips.length === 0) return true;
		if (matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
			setStripIndex((current.index + chips.length - 1) % chips.length);
			return true;
		}
		if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) {
			setStripIndex((current.index + 1) % chips.length);
			return true;
		}
		if (isSubmit(data)) {
			activateStripChip();
			return true;
		}
		return true;
	};
	const handleKey = (event: HostKeyEvent) => {
		if (event.defaultPrevented) return;
		const data = event.data;
		if (strip()) {
			if (handleStripKey(data)) {
				event.preventDefault();
				event.stopPropagation();
			}
			return;
		}
		if (creationActive()) {
			if (handleCreateRootKey(data)) {
				event.preventDefault();
				event.stopPropagation();
			}
			return;
		}
		if (assigning()) return;
		if (matchesKey(data, "escape")) {
			if (query()) setSearch("");
			else props.callbacks.onCancel();
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			void reload();
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			setFocus(current => (current === "scope" ? "list" : "scope"));
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (matchesKey(data, "left")) {
			setFocus("scope");
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (matchesKey(data, "right")) {
			setFocus("list");
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (focus() === "scope") {
			if (matchesKey(data, "up")) moveScope(-1);
			else if (matchesKey(data, "down")) moveScope(1);
			else if (isSubmit(data)) activateScope();
			else return;
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (matchesKey(data, "up")) selectRow(rowIndex() - 1);
		else if (matchesKey(data, "down")) selectRow(rowIndex() + 1);
		else if (isSubmit(data)) activateRow(selectedRow());
		else if (data === " " && !query()) {
			const agent = selectedAgent();
			if (agent) toggleAgent(agent.name);
		} else if (matchesKey(data, "backspace")) {
			if (query()) setSearch(query().slice(0, -1));
			else return;
		} else if (data.length === 1 && data >= " " && data !== "\x7f") {
			setSearch(query() + data);
			setFocus("list");
		} else return;
		event.preventDefault();
		event.stopPropagation();
	};

	const sidebarMouse = (event: HostMouseEvent) => {
		if (event.action === "move") setSidebarHover(undefined);
		if (event.action === "wheel" && !assigning() && !creationActive() && !strip()) {
			setSidebarOffset(previous => Math.max(0, previous + event.wheel));
			event.stopPropagation();
		}
	};
	const bodyMouse = (event: HostMouseEvent) => {
		if (event.action === "move") {
			setRowHover(undefined);
			setSidebarHover(undefined);
		}
		if (event.action === "wheel" && !assigning() && !creationActive() && !strip()) {
			selectRow(rowIndex() + event.wheel);
			event.stopPropagation();
		}
	};
	const clickSidebar = (entry: SidebarEntry, event: HostMouseEvent) => {
		if (event.action === "move") {
			if (entry.kind !== "separator") setSidebarHover(entry.id);
			return;
		}
		if (
			event.action !== "down" ||
			event.button !== 0 ||
			entry.kind === "separator" ||
			assigning() ||
			creationActive() ||
			strip()
		)
			return;
		if (entry.kind === "new") beginCreateFlow();
		else selectScope(entry);
		event.preventDefault();
		event.stopPropagation();
	};
	const clickRow = (index: number, row: ListRow, event: HostMouseEvent) => {
		if (event.action === "move") {
			setRowHover(index);
			event.stopPropagation();
			return;
		}
		if (event.action !== "down" || event.button !== 0 || assigning() || creationActive() || strip()) return;
		setFocus("list");
		if (index === rowIndex()) activateRow(row);
		else selectRow(index);
		event.preventDefault();
		event.stopPropagation();
	};

	createEffect(() => {
		const current = strip();
		if (current?.kind === "pattern") patternFocus.focus();
	});
	onMount(() => {
		void reload();
	});
	onCleanup(() => {
		alive = false;
		loadGeneration++;
		createGeneration++;
	});

	const renderStatus = (): JSX.Element => {
		if (loadError())
			return (
				<text color="error" wrap="clip">
					{" "}
					{loadError()}
				</text>
			);
		const assigningAgent = assigning();
		if (assigningAgent) {
			return (
				<text color="accent" wrap="clip">
					{" "}
					Picking {assigningAgent.property === "model"
						? "model override"
						: `${assigningAgent.property} model`} for{" "}
					<span bold>{assigningAgent.agentName}</span> — Enter assigns, Esc cancels
				</text>
			);
		}
		if (creationActive())
			return (
				<text color="accent" wrap="clip">
					{" "}
					New agent — describe it and let the architect draft it
				</text>
			);
		if (notice())
			return (
				<text color="success" wrap="clip">
					{" "}
					{notice()}
				</text>
			);
		const activeScope = scope();
		const label = isAgentSource(activeScope) ? `${SOURCE_LABEL[activeScope]} agents` : "All agents";
		return (
			<text color="muted" wrap="clip">
				{" "}
				{label} · {scopedAgents().length}
			</text>
		);
	};
	const renderAgentRow = (row: ListRow, index: number): JSX.Element => {
		const selected = index === rowIndex();
		const hovered = index === rowHover();
		if (row.kind === "new") {
			return (
				<row background={hovered ? "selectedBg" : undefined} onMouse={event => clickRow(index, row, event)}>
					<box width={2} shrink={0}>
						{selected && focus() === "list" ? <icon name="nav.cursor" color="accent" /> : null}
					</box>
					<text color={selected ? "accent" : "dim"} bold={selected}>
						+ New agent…
					</text>
				</row>
			);
		}
		const agent = row.agent;
		const prewalk = props.deps.effectivePrewalkPattern(agent);
		const advisor = props.deps.effectiveAdvisorPattern(agent);
		const badges = [
			agent.overrideModel,
			prewalk ? `pre:${prewalk}` : undefined,
			advisor ? `adv:${advisor}` : undefined,
		]
			.filter((badge): badge is string => Boolean(badge))
			.join("  ");
		return (
			<row background={hovered ? "selectedBg" : undefined} onMouse={event => clickRow(index, row, event)}>
				<box width={2} shrink={0}>
					{selected && focus() === "list" ? <icon name="nav.cursor" color="accent" /> : null}
				</box>
				<icon
					name={agent.disabled ? "status.disabled" : "status.enabled"}
					color={agent.disabled ? "dim" : "success"}
				/>
				<text> </text>
				<box minWidth={1} shrink={1}>
					<text
						color={agent.disabled ? "dim" : selected ? "accent" : undefined}
						bold={!agent.disabled && selected}
						wrap="clip"
					>
						{agent.name}
					</text>
				</box>
				<text color="dim"> {SOURCE_LABEL[agent.source].toLowerCase()}</text>
				<box grow={1} />
				{badges ? (
					<text color="dim" wrap="clip">
						{" "}
						{badges}
					</text>
				) : null}
			</row>
		);
	};
	const renderRoster = (): JSX.Element => {
		const current = selectedAgent();
		const patterns = current ? props.deps.effectiveModelPatterns(current) : [];
		const resolved = current ? props.deps.resolvePatterns(patterns) : undefined;
		const prewalk = current ? props.deps.effectivePrewalkPattern(current) : undefined;
		const advisor = current ? props.deps.effectiveAdvisorPattern(current) : undefined;
		return (
			<stack>
				{renderStatus()}
				<text wrap="clip">
					{" "}
					<span color="muted">search:</span>{" "}
					<span color={query() ? "accent" : "dim"}>{query() || "type to filter"}</span>
				</text>
				<br />
				<scroll height={listViewportRows} offset={listOffset()} followTail={false} shrinkToFit={false}>
					<For each={rows()}>{(row, index) => renderAgentRow(row, index())}</For>
				</scroll>
				<hr />
				{current ? (
					<stack>
						<text color="dim" wrap="clip">
							{" "}
							{current.description}
						</text>
						<text wrap="clip">
							{" "}
							<span color="muted">model:</span>{" "}
							{patterns.length > 0 ? patterns.join(",") : <span color="dim">(session model)</span>}
							{resolved ? (
								<>
									<span color="dim"> → </span>
									<span color="success">{resolved}</span>
								</>
							) : null}
						</text>
						<text wrap="clip">
							<span color="muted"> prewalk:</span>{" "}
							<span color={prewalk ? "success" : "dim"}>{prewalk ?? "off"}</span>
							<span color="muted"> advisor:</span>{" "}
							<span color={advisor ? "success" : "dim"}>{advisor ?? "off"}</span>
							{current.filePath ? <span color="dim"> {shortenPath(current.filePath)}</span> : null}
						</text>
					</stack>
				) : (
					<stack>
						<text color="dim"> Select an agent to inspect</text>
						<br />
						<br />
					</stack>
				)}
			</stack>
		);
	};
	const renderCreation = (): JSX.Element => {
		const spec = createdSpec();
		const editor = createEditor();
		return (
			<stack>
				{renderStatus()}
				<br />
				{spec ? (
					<stack>
						<text color="accent" bold>
							{" "}
							Review generated agent
						</text>
						<br />
						<text color="muted"> Identifier: {spec.identifier}</text>
						<text color="muted"> Scope: {createScope()}</text>
						<br />
						<text color="muted"> whenToUse:</text>
						<text wrap="word"> {spec.whenToUse}</text>
						<br />
						<text color="muted"> systemPrompt preview:</text>
						<scroll height={6} followTail={false} shrinkToFit>
							<text color="dim" wrap="word">
								{" "}
								{spec.systemPrompt}
							</text>
						</scroll>
					</stack>
				) : (
					<stack>
						<text color="accent" bold>
							{" "}
							Create new agent
						</text>
						<br />
						<text color="muted" wrap="clip">
							{" "}
							Describe what the agent should do; scope: <span color="accent">{createScope()}</span>
						</text>
						<br />
						{creating() ? (
							<stack>
								<text color="muted"> Generating…</text>
								<br />
								<scroll height={6} anchor="end" followTail shrinkToFit>
									<text color="dim" wrap="word">
										{" "}
										{streamingText()}
									</text>
								</scroll>
							</stack>
						) : editor ? (
							<editor editor={editor} tabIndex={createFocus.tabIndex} onKey={handleCreateEditorKey} />
						) : null}
					</stack>
				)}
				{createError() ? (
					<>
						<br />
						<text color="error" wrap="word">
							{" "}
							{createError()}
						</text>
					</>
				) : null}
			</stack>
		);
	};
	const assignmentSelector = createMemo(() => {
		const target = assigning();
		const agent = target ? agentByName(target.agentName) : undefined;
		return target && agent ? overrideFor(agent, target.property) : undefined;
	});
	const renderAssignment = (): JSX.Element => (
		<stack>
			{renderStatus()}
			<ModelBrowserView
				items={browserItems()}
				mruOrder={props.deps.browserSource.mruOrder}
				roleInfo={props.deps.browserSource.getRoleInfo}
				selectedSelector={assignmentSelector()}
				showProvider
				maxVisible={10}
				query={browserQuery()}
				onQueryChange={setBrowserQuery}
				onSelect={commitPickedModel}
				onCancel={cancelAssign}
				emptyText="No models available — configure a provider in /models first."
			/>
		</stack>
	);
	const renderFooter = (): JSX.Element => {
		const current = strip();
		if (current?.kind === "pattern") {
			return (
				<row>
					<text color="accent" wrap="clip">
						{current.agentName} {current.property} pattern:{" "}
					</text>
					<box grow={1}>
						<input
							tabIndex={patternFocus.tabIndex}
							value={current.value}
							prompt=""
							onChange={changePattern}
							onSubmit={submitPattern}
							onEscape={() => openPropertyStrip(current.agentName, current.property)}
						/>
					</box>
				</row>
			);
		}
		if (current) {
			const agent = currentStripAgent();
			const prefix =
				current.kind === "property"
					? `${agent?.name ?? current.agentName} · ${current.property} →`
					: `${agent?.name ?? current.agentName} →`;
			return (
				<row>
					<text color="accent">{prefix} </text>
					<For each={stripChips()}>
						{(chip, index) => (
							<text
								color={chip.tone}
								bold={index() === current.index}
								inverse={index() === current.index}
								onMouse={event => {
									if (event.action !== "down" || event.button !== 0) return;
									setStripIndex(index());
									activateStripChip();
									event.preventDefault();
									event.stopPropagation();
								}}
							>
								[{" "}
								{chip.active ? (
									<>
										<icon name="status.enabled" color="accent" />{" "}
									</>
								) : null}
								{chip.label} ]{" "}
							</text>
						)}
					</For>
				</row>
			);
		}
		const hint = assigning()
			? "Enter pick · ↑/↓ models · type to search · Esc cancel"
			: creationActive()
				? createdSpec()
					? "Enter save · Tab scope · r regenerate · Esc cancel"
					: creating()
						? "Generating…"
						: "Ctrl+Q/Ctrl+Enter generate · Enter newline · Tab scope · Esc cancel"
				: focus() === "scope"
					? "↑/↓ scopes · →/Enter agents · Esc close"
					: "Enter configure · Space enable/disable · ↑/↓ rows · type to search · Ctrl+R reload · Esc close";
		return (
			<text color="dim" wrap="clip">
				{hint}
			</text>
		);
	};
	const sidebar = (
		<box onMouse={sidebarMouse}>
			<For each={sidebarEntries()}>
				{entry => {
					if (entry.kind === "separator") return <hr variant="frame" />;
					const selected = entry.id === scope();
					const hovered = entry.id === sidebarHover();
					return (
						<row background={hovered ? "selectedBg" : undefined} onMouse={event => clickSidebar(entry, event)}>
							<box width={2} shrink={0}>
								{selected && focus() === "scope" ? <icon name="nav.cursor" color="accent" /> : null}
							</box>
							{entry.kind === "all" ? (
								<icon name="icon.model" color="accent" />
							) : entry.kind === "new" ? (
								<text color="dim">+</text>
							) : (
								<icon name="status.enabled" color="accent" />
							)}
							<text> </text>
							<text
								color={entry.kind === "new" ? "dim" : selected ? "accent" : undefined}
								bold={selected && entry.kind !== "new"}
								wrap="clip"
							>
								{entry.label}
							</text>
							<box grow={1} />
							{entry.annotation ? <text color="dim">{entry.annotation}</text> : null}
						</row>
					);
				}}
			</For>
		</box>
	);
	const body = (
		<box onMouse={bodyMouse}>
			{assigning() ? renderAssignment() : creationActive() ? renderCreation() : renderRoster()}
		</box>
	);
	return (
		<box tabIndex={rootFocus.tabIndex} onKey={handleKey}>
			<HubFrameView
				title="Agents"
				sidebar={sidebar}
				sidebarOffset={sidebarOffset()}
				body={body}
				bodyOffset={0}
				sidebarWidth={sidebarWidth()}
				viewportHeight={viewportHeight}
				footer={renderFooter()}
			/>
		</box>
	);
}

export function openAgentsHubOverlay(
	tui: TUI,
	deps: AgentsHubDeps,
	callbacks: AgentsHubCallbacks = { onCancel() {} },
): OverlayDisposer {
	return mountOverlay(tui, () => (
		<Portal to="overlay" fullscreen mouseTracking>
			<AgentsHubView deps={deps} callbacks={callbacks} terminalRows={tui.terminal?.rows} />
		</Portal>
	));
}
