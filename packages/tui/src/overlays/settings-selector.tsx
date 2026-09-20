import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort } from "@oh-my-pi/pi-ai";
import type { ShapeTarget } from "@oh-my-pi/snapcompact";
import {
	CONTEXT_LINE_MODE_VALUES,
	STATUS_LINE_PRESET_VALUES,
	STATUS_LINE_SEGMENT_IDS,
	STATUS_LINE_SEPARATOR_VALUES,
	type ContextLineMode,
	type StatusLinePreset,
	type StatusLineSegmentId,
	type StatusLineSeparatorStyle,
} from "../status-line/schema";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	type Accessor,
	type JSX,
	type ThemeAccess,
	useFocus,
	useTheme,
} from "../reactive";
import { fuzzyRank } from "../fuzzy";
import { extractPrintableText, matchesKey } from "../keys";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { Portal, bindOverlayController, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import type { TUI } from "../tui";
import type { ImageBudget } from "../components/image";
import { scrollOffsetForRow } from "../components/scroll-viewport";
import type { SelectOption } from "../host/elements/select";
import { getComposerShapeOptions } from "./composer-shape-registry";
import { ComposerShapePreviewView, type ComposerPreviewStatusSource } from "./composer-shape-preview";
import { SnapcompactShapePreviewView } from "./snapcompact-shape-preview";
import {
	createPluginSettingsController,
	PluginSettingsView,
	type PluginSettingsController,
	type PluginSettingsHost,
} from "./plugin-settings";
import { getPreset } from "../status-line/presets";
import {
	getSettingDef,
	getSettingsForTab,
	SETTING_TABS,
	TAB_METADATA,
	type MultiSelectSettingDef,
	type SettingDef,
	type SettingTab,
	type SettingsDisplayEntry,
	type SettingsHost,
	type SubmenuOption,
	type SubmenuSettingDef,
} from "./settings-defs";

export interface SettingsRuntimeContext {
	settings: SettingsHost;
	plugins: PluginSettingsHost;
	availableThinkingLevels: Effort[];
	thinkingLevel: ThinkingLevel | undefined;
	availableThemes: string[];
	providers: string[];
	model?: ShapeTarget;
	imageBudget?: ImageBudget;
	composerPreviewStatus?: ComposerPreviewStatusSource;
}

export interface StatusLinePreviewSettings {
	preset?: StatusLinePreset;
	contextLine?: ContextLineMode;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	sessionAccent?: boolean;
	transparent?: boolean;
	compactThinkingLevel?: boolean;
}

export interface SettingsCallbacks {
	onChange: (path: string, newValue: unknown) => void;
	onThemePreview?: (theme: string) => void | Promise<void>;
	onStatusLinePreview?: (settings: StatusLinePreviewSettings) => void;
	getStatusLinePreview?: () => JSX.Element;
	onPluginsChanged?: () => void | Promise<void>;
	onCancel: () => void;
}

export type SettingsPanel = SettingTab | "plugins";
export type SettingsEditorMode = "closed" | "choice" | "text" | "provider-list" | "provider-editor" | "multiselect";
type EditorMode = SettingsEditorMode;
type Row =
	| { readonly kind: "heading"; readonly label: string }
	| { readonly kind: "setting"; readonly def: SettingDef };
type SearchRow = { readonly result?: SearchResult };
export type SettingsSearchResult = { readonly def: SettingDef; readonly tab: SettingTab; readonly score: number };
type SearchResult = SettingsSearchResult;
type TabItem = {
	readonly id: SettingsPanel;
	readonly label: string;
	readonly short: string;
	readonly disabled?: boolean;
};

const CHOICE_ROWS = 10;
const LIST_ROWS = 12;

function editorOptionIndex(data: string, index: number, count: number, pageRows: number): number | undefined {
	let next: number;
	if (matchesSelectUp(data)) next = index - 1;
	else if (matchesSelectDown(data)) next = index + 1;
	else if (matchesSelectPageUp(data)) next = index - pageRows;
	else if (matchesSelectPageDown(data)) next = index + pageRows;
	else if (matchesKey(data, "home")) next = 0;
	else if (matchesKey(data, "end")) next = count - 1;
	else return undefined;
	return Math.max(0, Math.min(Math.max(0, count - 1), next));
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
	return values.some(candidate => candidate === value);
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(entry => typeof entry === "string") ? value : undefined;
}

function statusLineSegments(value: unknown): StatusLineSegmentId[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const segments: StatusLineSegmentId[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !isOneOf(entry, STATUS_LINE_SEGMENT_IDS)) return undefined;
		segments.push(entry);
	}
	return segments;
}

function visibleDefs(context: SettingsRuntimeContext, tab: SettingTab): SettingDef[] {
	return getSettingsForTab(context.settings.entries, tab).filter(def => def.condition?.() !== false);
}

function rowsForDefs(defs: readonly SettingDef[]): Row[] {
	const rows: Row[] = [];
	let group: string | undefined;
	for (const def of defs) {
		if (def.group && def.group !== group) {
			rows.push({ kind: "heading", label: def.group });
			group = def.group;
		}
		rows.push({ kind: "setting", def });
	}
	return rows;
}

function searchRows(results: readonly SearchResult[]): SearchRow[] {
	const rows: SearchRow[] = [];
	let tab: SettingTab | undefined;
	for (const result of results) {
		if (result.tab !== tab) rows.push({});
		rows.push({ result });
		tab = result.tab;
	}
	return rows;
}

function sectionsForDefs(
	defs: readonly SettingDef[],
): readonly { readonly label: string; readonly firstPath: string }[] {
	const sections: { label: string; firstPath: string }[] = [];
	let group: string | undefined;
	for (const def of defs) {
		const next = def.group ?? "";
		if (next !== group) {
			sections.push({ label: next, firstPath: def.path });
			group = next;
		}
	}
	return sections;
}

function valueForDisplay(context: SettingsRuntimeContext, def: SettingDef): string {
	const value = context.settings.get(def.path);
	if (def.type === "boolean") return value === true ? "true" : "false";
	if (def.type === "providerLimits") {
		const entries = Object.entries(context.settings.normalizeProviderLimits(value)).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		return entries.length === 0
			? "Unlimited"
			: entries.map(([provider, limit]) => `${provider}: ${limit}`).join(", ");
	}
	if (def.type === "multiselect") {
		const options = multiOptions(context, def);
		const labels = (stringArray(value) ?? []).flatMap(item => {
			const option = options.find(candidate => candidate.value === item);
			return option ? [option.label] : [];
		});
		return labels.length === 0 ? (def.ordered ? "default" : "none") : labels.join(def.ordered ? " → " : ", ");
	}
	if (def.type === "text") {
		if (def.secret) return value ? "••••••••" : "";
		return editValue(value);
	}
	if (
		(def.path === "compaction.thresholdPercent" || def.path === "compaction.thresholdTokens") &&
		(value === -1 || value === undefined || value === null)
	) {
		return "default";
	}
	return value === undefined || value === null ? "" : String(value);
}

function editValue(value: unknown): string {
	if (value === undefined || value === null) return "";
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function multiOptions(context: SettingsRuntimeContext, def: MultiSelectSettingDef): readonly SubmenuOption[] {
	if (def.path !== "providers.webSearchOrder") return def.options;
	const excluded = stringArray(context.settings.get("providers.webSearchExclude"));
	return excluded === undefined ? def.options : def.options.filter(option => !excluded.includes(option.value));
}

function optionsFor(context: SettingsRuntimeContext, def: SubmenuSettingDef): readonly SubmenuOption[] {
	if (def.path === "defaultThinkingLevel") {
		const configured = ["auto", ...context.availableThinkingLevels];
		return [...new Set(configured)].map(
			value => def.options.find(option => option.value === value) ?? { value, label: value },
		);
	}
	if (def.path === "theme.dark" || def.path === "theme.light") {
		return context.availableThemes.map(value => ({ value, label: value }));
	}
	if (def.path === "composer.shape") return getComposerShapeOptions();
	return def.options;
}

function changed(context: SettingsRuntimeContext, def: SettingDef): boolean {
	const value = context.settings.get(def.path);
	const defaultValue = def.defaultValue;
	if (Array.isArray(value) && Array.isArray(defaultValue)) {
		if (value.length !== defaultValue.length) return true;
		for (let index = 0; index < value.length; index++) {
			if (value[index] !== defaultValue[index]) return true;
		}
		return false;
	}
	return !Object.is(value, defaultValue);
}

function entryFor(context: SettingsRuntimeContext, def: SettingDef): SettingsDisplayEntry | undefined {
	return context.settings.entries.find(entry => entry.path === def.path);
}

export interface SettingsSelectorController {
	readonly tab: Accessor<SettingTab>;
	readonly panel: Accessor<SettingsPanel>;
	readonly query: Accessor<string>;
	readonly selectedIndex: Accessor<number>;
	readonly editing: Accessor<SettingsDisplayEntry | undefined>;
	readonly draft: Accessor<string>;
	readonly editorMode: Accessor<EditorMode>;
	readonly choiceIndex: Accessor<number>;
	readonly multiIndex: Accessor<number>;
	readonly multiValues: Accessor<readonly string[]>;
	readonly providerIndex: Accessor<number>;
	readonly providerId: Accessor<string | undefined>;
	readonly error: Accessor<string | undefined>;
	readonly sectionFocused: Accessor<boolean>;
	readonly plugins: Accessor<PluginSettingsController | undefined>;
	readonly searchResults: Accessor<readonly SearchResult[]>;
	readonly statusLinePreview: Accessor<JSX.Element>;
	/** Advances after saved settings change so retained values update without remounting editors. */
	readonly revision: Accessor<number>;
	/** Highlight an option in the active editor, previewing choices without committing. */
	focusOption(index: number): void;
	handleInput(data: string): void;
	setQuery(value: string): void;
	setDraft(value: string): void;
	selectPath(path: string, activate?: boolean): void;
	selectPanel(panel: SettingsPanel): void;
	selectSearchTab(tab: SettingTab): void;
	selectSection(index: number): void;
	activate(): void;
	cancel(): void;
	mouseSetting(path: string, event: HostMouseEvent): void;
	mouseMulti(value: string, event: HostMouseEvent): void;
	mouseRoot(event: HostMouseEvent): void;
	setPageRows(rows: number): void;
	dispose(): void;
}

export function createSettingsSelectorController(
	context: SettingsRuntimeContext,
	callbacks: SettingsCallbacks,
): SettingsSelectorController {
	const [tab, setTab] = createSignal<SettingTab>(SETTING_TABS[0] ?? "appearance");
	const [panel, setPanel] = createSignal<SettingsPanel>(tab());
	const [query, setQueryValue] = createSignal("");
	const [selectedIndex, setSelectedIndex] = createSignal(0);
	const [editing, setEditing] = createSignal<SettingsDisplayEntry>();
	const [draft, setDraft] = createSignal("");
	const [editorMode, setEditorMode] = createSignal<EditorMode>("closed");
	const [choiceIndex, setChoiceIndex] = createSignal(0);
	const [multiIndex, setMultiIndex] = createSignal(0);
	const [multiValues, setMultiValues] = createSignal<readonly string[]>([]);
	const [providerIndex, setProviderIndex] = createSignal(0);
	const [providerId, setProviderId] = createSignal<string>();
	const [error, setError] = createSignal<string>();
	const [sectionFocused, setSectionFocused] = createSignal(false);
	const [version, setVersion] = createSignal(0);
	const [pluginController, setPluginController] = createSignal<PluginSettingsController>();
	let preSearchTab: SettingTab = tab();
	let themePreviewGeneration = 0;
	let pageRows = 1;
	let dragValue: string | undefined;
	let dragTarget: string | undefined;
	let disposed = false;

	const activeDefs = createMemo(() => {
		version();
		return visibleDefs(context, tab());
	});
	const searchResults = createMemo(() => {
		version();
		const needle = query();
		if (!needle) return [];
		const groups: { tab: SettingTab; results: SearchResult[]; bestScore: number }[] = [];
		for (const candidateTab of SETTING_TABS) {
			const ranked = fuzzyRank(
				visibleDefs(context, candidateTab),
				needle,
				def => `${def.label} ${def.description} ${def.path}`,
			);
			if (ranked.length === 0) continue;
			groups.push({
				tab: candidateTab,
				results: ranked.map(result => ({ def: result.item, tab: candidateTab, score: result.score })),
				bestScore: ranked[0]!.score,
			});
		}
		groups.sort(
			(left, right) =>
				left.bestScore - right.bestScore || SETTING_TABS.indexOf(left.tab) - SETTING_TABS.indexOf(right.tab),
		);
		return groups.flatMap(group => group.results);
	});
	const selectedDef = createMemo(() => {
		const index = selectedIndex();
		if (query()) return searchResults()[index]?.def;
		return activeDefs()[index];
	});

	const markChanged = (): void => {
		setVersion(version => version + 1);
		const choices = query() ? searchResults() : activeDefs();
		setSelectedIndex(index => Math.max(0, Math.min(Math.max(0, choices.length - 1), index)));
	};
	const statusPreview = (): void => {
		const presetValue = context.settings.get("statusLine.preset");
		const separatorValue = context.settings.get("statusLine.separator");
		const contextLineValue = context.settings.get("statusLine.contextLine");
		const preview: StatusLinePreviewSettings = {};
		if (typeof presetValue === "string" && isOneOf(presetValue, STATUS_LINE_PRESET_VALUES))
			preview.preset = presetValue;
		if (typeof separatorValue === "string" && isOneOf(separatorValue, STATUS_LINE_SEPARATOR_VALUES))
			preview.separator = separatorValue;
		if (typeof contextLineValue === "string" && isOneOf(contextLineValue, CONTEXT_LINE_MODE_VALUES))
			preview.contextLine = contextLineValue;
		preview.leftSegments = statusLineSegments(context.settings.get("statusLine.leftSegments"));
		preview.rightSegments = statusLineSegments(context.settings.get("statusLine.rightSegments"));
		const sessionAccent = context.settings.get("statusLine.sessionAccent");
		const transparent = context.settings.get("statusLine.transparent");
		const compactThinkingLevel = context.settings.get("statusLine.compactThinkingLevel");
		if (typeof sessionAccent === "boolean") preview.sessionAccent = sessionAccent;
		if (typeof transparent === "boolean") preview.transparent = transparent;
		if (typeof compactThinkingLevel === "boolean") preview.compactThinkingLevel = compactThinkingLevel;
		callbacks.onStatusLinePreview?.(preview);
	};
	const apply = (def: SettingDef, value: unknown): void => {
		if (disposed) return;
		context.settings.set(def.path, value);
		callbacks.onChange(def.path, value);
		if (def.tab === "appearance") statusPreview();
		markChanged();
	};
	const closeEditor = (restorePreview: boolean): void => {
		const entry = editing();
		const def = entry ? getSettingDef(context.settings.entries, entry.path) : selectedDef();
		if (def?.path === "theme.dark" || def?.path === "theme.light") {
			// A preview can resolve after the choice was committed or cancelled.
			// Invalidate it in both cases so its completion restores the saved value.
			themePreviewGeneration++;
			if (restorePreview) {
				const saved = context.settings.get(def.path);
				if (typeof saved === "string") void callbacks.onThemePreview?.(saved);
			}
		} else if (restorePreview && def?.path.startsWith("statusLine.")) {
			statusPreview();
		}
		dragValue = undefined;
		dragTarget = undefined;
		setEditing(undefined);
		setDraft("");
		setEditorMode("closed");
		setError(undefined);
	};
	const currentDef = (): SettingDef | undefined => {
		const entry = editing();
		return entry ? getSettingDef(context.settings.entries, entry.path) : selectedDef();
	};
	const previewChoice = (def: SubmenuSettingDef, value: string): void => {
		if (def.path === "theme.dark" || def.path === "theme.light") {
			const generation = ++themePreviewGeneration;
			const preview = callbacks.onThemePreview?.(value);
			void Promise.resolve(preview).then(() => {
				if (disposed || generation === themePreviewGeneration) return;
				const active = currentDef();
				const target =
					editorMode() === "choice" && active?.path === def.path
						? choiceOptions()[choiceIndex()]?.value
						: context.settings.get(def.path);
				if (typeof target === "string" && target !== value) void callbacks.onThemePreview?.(target);
			});
			return;
		}
		if (def.path === "statusLine.preset" && isOneOf(value, STATUS_LINE_PRESET_VALUES)) {
			const preset = getPreset(value);
			callbacks.onStatusLinePreview?.({
				preset: value,
				leftSegments: [...preset.leftSegments],
				rightSegments: [...preset.rightSegments],
				separator: preset.separator,
			});
			return;
		}
		if (def.path === "statusLine.separator" && isOneOf(value, STATUS_LINE_SEPARATOR_VALUES)) {
			callbacks.onStatusLinePreview?.({ separator: value });
			return;
		}
		if (def.path === "statusLine.contextLine" && isOneOf(value, CONTEXT_LINE_MODE_VALUES)) {
			callbacks.onStatusLinePreview?.({ contextLine: value });
		}
	};
	const choiceOptions = (): readonly SubmenuOption[] => {
		const def = currentDef();
		return def?.type === "submenu" ? optionsFor(context, def) : [];
	};
	const moveChoice = (delta: number): void => {
		const def = currentDef();
		const options = choiceOptions();
		if (!def || def.type !== "submenu" || options.length === 0) return;
		setChoiceIndex(index => {
			const next = Math.max(0, Math.min(options.length - 1, index + delta));
			const value = options[next]?.value;
			if (value !== undefined) previewChoice(def, value);
			return next;
		});
	};
	const openChoice = (def: SubmenuSettingDef): void => {
		const entry = entryFor(context, def);
		if (!entry) return;
		const options = optionsFor(context, def);
		const current = valueForDisplay(context, def);
		setEditing(entry);
		setEditorMode("choice");
		setChoiceIndex(
			Math.max(
				0,
				options.findIndex(option => option.value === current),
			),
		);
		setError(undefined);
	};
	const submitText = (): void => {
		const def = currentDef();
		if (!def || def.type !== "text") return;
		let value: unknown = draft();
		if (def.schemaType === "record") {
			try {
				const parsed: unknown = JSON.parse(draft() || "{}");
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					setError(`Invalid record JSON for ${def.path}`);
					return;
				}
				value = parsed;
			} catch {
				setError(`Invalid record JSON for ${def.path}`);
				return;
			}
		}
		apply(def, value);
		closeEditor(false);
	};
	const providerIds = (): readonly string[] => {
		const limits = context.settings.normalizeProviderLimits(context.settings.get("providers.maxInFlightRequests"));
		return [...new Set([...context.providers, ...Object.keys(limits)])].sort((left, right) =>
			left.localeCompare(right),
		);
	};
	const providerChoices = (): readonly string[] => {
		const limits = context.settings.normalizeProviderLimits(context.settings.get("providers.maxInFlightRequests"));
		return Object.keys(limits).length === 0 ? providerIds() : [...providerIds(), "__clear_all"];
	};
	const openProviderEditor = (id: string): void => {
		const limits = context.settings.normalizeProviderLimits(context.settings.get("providers.maxInFlightRequests"));
		setProviderId(id);
		setDraft(limits[id]?.toString() ?? "");
		setEditorMode("provider-editor");
		setError(undefined);
	};
	const submitProvider = (): void => {
		const id = providerId();
		const def = currentDef();
		if (!id || !def || def.type !== "providerLimits") return;
		const trimmed = draft().trim();
		if (trimmed) {
			const limit = Number(trimmed);
			if (!Number.isFinite(limit) || limit <= 0) {
				setError("Limit must be a positive number.");
				return;
			}
		}
		const limits = context.settings.normalizeProviderLimits(context.settings.get(def.path));
		const next = { ...limits };
		if (!trimmed) delete next[id];
		else next[id] = Math.max(1, Math.floor(Number(trimmed)));
		apply(def, context.settings.validateProviderLimits(next));
		setEditorMode("provider-list");
		setProviderId(undefined);
		setError(undefined);
	};
	const multiDef = (): MultiSelectSettingDef | undefined => {
		const def = currentDef();
		return def?.type === "multiselect" ? def : undefined;
	};
	const applyMulti = (next: readonly string[]): void => {
		const def = multiDef();
		if (!def) return;
		setMultiValues([...next]);
		apply(def, [...next]);
	};
	const toggleMulti = (value: string): void => {
		const values = multiValues();
		applyMulti(values.includes(value) ? values.filter(item => item !== value) : [...values, value]);
	};
	const moveMulti = (delta: -1 | 1): void => {
		const def = multiDef();
		const value = multiOptionsForEditor()[multiIndex()]?.value;
		if (!def || !def.ordered || value === undefined) return;
		const values = [...multiValues()];
		const from = values.indexOf(value);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= values.length) return;
		values[from] = values[to]!;
		values[to] = value;
		applyMulti(values);
	};
	const placeMulti = (position: number): void => {
		const def = multiDef();
		const value = multiOptionsForEditor()[multiIndex()]?.value;
		if (!def || !def.ordered || value === undefined) return;
		const values = multiValues().filter(item => item !== value);
		values.splice(Math.min(position - 1, values.length), 0, value);
		applyMulti(values);
	};
	const multiOptionsForEditor = (): readonly SubmenuOption[] => {
		const def = multiDef();
		return def ? multiOptions(context, def) : [];
	};
	const activateCurrent = (): void => {
		const def = selectedDef();
		if (!def) return;
		if (def.type === "boolean") {
			apply(def, context.settings.get(def.path) !== true);
			return;
		}
		if (def.type === "enum") {
			const current = String(context.settings.get(def.path) ?? "");
			const values = def.values;
			if (values.length === 0) return;
			const index = values.indexOf(current);
			apply(def, values[(index + 1) % values.length]!);
			return;
		}
		if (def.type === "submenu") {
			openChoice(def);
			return;
		}
		const entry = entryFor(context, def);
		if (!entry) return;
		setEditing(entry);
		setError(undefined);
		if (def.type === "text") {
			setDraft(editValue(context.settings.get(def.path)));
			setEditorMode("text");
			return;
		}
		if (def.type === "providerLimits") {
			setProviderIndex(0);
			setEditorMode("provider-list");
			return;
		}
		if (def.type === "multiselect") {
			const options = multiOptions(context, def);
			const valid = (stringArray(context.settings.get(def.path)) ?? []).filter(value =>
				options.some(option => option.value === value),
			);
			setMultiValues(valid);
			setMultiIndex(0);
			setEditorMode("multiselect");
		}
	};
	const commitChoice = (): void => {
		const def = currentDef();
		const option = choiceOptions()[choiceIndex()];
		if (!def || def.type !== "submenu" || !option) return;
		let value: unknown = option.value;
		if (def.path === "compaction.thresholdPercent" || def.path === "compaction.thresholdTokens") {
			if (option.value === "default") value = -1;
		} else if (typeof context.settings.get(def.path) === "number") {
			value = Number(option.value);
		}
		apply(def, value);
		closeEditor(false);
	};
	const activeSections = (): readonly { readonly label: string; readonly firstPath: string }[] =>
		sectionsForDefs(activeDefs());
	const selectSection = (index: number): void => {
		const sections = activeSections();
		const section = sections[Math.max(0, Math.min(sections.length - 1, index))];
		if (!section) return;
		const target = activeDefs().findIndex(def => def.path === section.firstPath);
		if (target >= 0) setSelectedIndex(target);
	};
	const moveSection = (delta: number): void => {
		const sections = activeSections();
		if (sections.length < 2) return;
		const currentPath = activeDefs()[selectedIndex()]?.path;
		const index = Math.max(
			0,
			sections.findIndex(section => section.firstPath === currentPath),
		);
		selectSection((index + delta + sections.length) % sections.length);
	};
	const ensurePlugins = (): PluginSettingsController => {
		const existing = pluginController();
		if (existing) return existing;
		const created = createPluginSettingsController(context.plugins, {
			onClose: callbacks.onCancel,
			onPluginsChanged: callbacks.onPluginsChanged,
		});
		setPluginController(created);
		return created;
	};
	const selectPanel = (next: SettingsPanel): void => {
		const editorWasOpen = editorMode() !== "closed";
		closeEditor(editorWasOpen);
		if (next === "plugins") ensurePlugins();
		else setTab(next);
		setPanel(next);
		setQueryValue("");
		setSelectedIndex(0);
		setSectionFocused(false);
	};
	const cyclePanel = (delta: -1 | 1): void => {
		const panels: SettingsPanel[] = [...SETTING_TABS, "plugins"];
		const index = panels.indexOf(panel());
		selectPanel(panels[(index + delta + panels.length) % panels.length]!);
	};
	const selectSearchTab = (target: SettingTab): void => {
		const resultIndex = searchResults().findIndex(result => result.tab === target);
		if (resultIndex < 0) return;
		setTab(target);
		setPanel(target);
		setSelectedIndex(resultIndex);
	};
	const cycleSearchTab = (delta: -1 | 1): void => {
		const results = searchResults();
		const available = [...new Set(results.map(result => result.tab))];
		if (available.length === 0) return;
		const active = results[selectedIndex()]?.tab ?? tab();
		const index = Math.max(0, available.indexOf(active));
		selectSearchTab(available[(index + delta + available.length) % available.length]!);
	};
	const endSearch = (jumpToSelection: boolean): void => {
		const selected = jumpToSelection ? searchResults()[selectedIndex()] : undefined;
		setQueryValue("");
		const target = selected?.tab ?? preSearchTab;
		setTab(target);
		setPanel(target);
		const targetIndex = selected ? visibleDefs(context, target).findIndex(def => def.path === selected.def.path) : 0;
		setSelectedIndex(Math.max(0, targetIndex));
		setSectionFocused(false);
	};
	const setQuery = (value: string): void => {
		if (disposed) return;
		if (!value) {
			if (query()) endSearch(false);
			return;
		}
		if (!query()) {
			const currentPanel = panel();
			preSearchTab = currentPanel === "plugins" ? tab() : currentPanel;
		}
		setQueryValue(value);
		setSelectedIndex(0);
		setSectionFocused(false);
	};
	const setDraftValue = (value: string): void => {
		setDraft(value);
		setError(undefined);
	};
	const selectPath = (path: string, activate = false): void => {
		const definitions = query() ? searchResults().map(result => result.def) : activeDefs();
		const index = definitions.findIndex(def => def.path === path);
		if (index < 0) return;
		const selected = selectedIndex();
		setSelectedIndex(index);
		if (activate && selected === index) activateCurrent();
	};
	const cancel = (): void => {
		if (editorMode() === "choice" || editorMode() === "text" || editorMode() === "multiselect") {
			closeEditor(true);
			return;
		}
		if (editorMode() === "provider-editor") {
			setEditorMode("provider-list");
			setProviderId(undefined);
			setError(undefined);
			return;
		}
		if (editorMode() === "provider-list") {
			closeEditor(false);
			return;
		}
		if (query()) {
			endSearch(true);
			return;
		}
		if (sectionFocused()) {
			setSectionFocused(false);
			return;
		}
		callbacks.onCancel();
	};
	const handleEditorInput = (data: string): boolean => {
		if (editorMode() === "closed") return false;
		if (matchesSelectCancel(data)) {
			cancel();
			return true;
		}
		if (editorMode() === "choice") {
			const next = editorOptionIndex(data, choiceIndex(), choiceOptions().length, CHOICE_ROWS);
			if (next !== undefined) {
				if (next !== choiceIndex()) moveChoice(next - choiceIndex());
			} else if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") commitChoice();
			return true;
		}
		if (editorMode() === "multiselect") {
			const options = multiOptionsForEditor();
			const next = editorOptionIndex(data, multiIndex(), options.length, LIST_ROWS);
			if (next !== undefined) setMultiIndex(next);
			else if (matchesKey(data, "left")) moveMulti(-1);
			else if (matchesKey(data, "right")) moveMulti(1);
			else if (
				(matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "space") || data === "\n") &&
				options[multiIndex()]
			)
				toggleMulti(options[multiIndex()]!.value);
			else if (data.length === 1 && data >= "1" && data <= "9") placeMulti(Number(data));
			return true;
		}
		if (editorMode() === "provider-list") {
			const choices = providerChoices();
			const next = editorOptionIndex(data, providerIndex(), choices.length, LIST_ROWS);
			if (next !== undefined) setProviderIndex(next);
			else if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				const choice = choices[providerIndex()];
				const def = currentDef();
				if (!choice || !def || def.type !== "providerLimits") return true;
				if (choice === "__clear_all") {
					apply(def, {});
					setProviderIndex(index => Math.max(0, Math.min(providerChoices().length - 1, index)));
				} else openProviderEditor(choice);
			}
			return true;
		}
		if (editorMode() === "provider-editor" || editorMode() === "text") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				if (editorMode() === "provider-editor") submitProvider();
				else submitText();
				return true;
			}
			if (matchesKey(data, "backspace")) {
				setDraftValue(Array.from(draft()).slice(0, -1).join(""));
				return true;
			}
			const typed = extractPrintableText(data);
			if (typed) setDraftValue(draft() + typed);
			return true;
		}
		return true;
	};
	const mouseSetting = (path: string, event: HostMouseEvent): void => {
		if (event.action === "move") return;
		if (event.action !== "down") return;
		event.stopPropagation();
		selectPath(path, true);
	};
	const mouseMulti = (value: string, event: HostMouseEvent): void => {
		if (editorMode() !== "multiselect") return;
		if (event.action === "down") {
			dragValue = value;
			dragTarget = value;
			const index = multiOptionsForEditor().findIndex(option => option.value === value);
			if (index >= 0) setMultiIndex(index);
			event.stopPropagation();
			return;
		}
		if (event.action === "move" && dragValue !== undefined && multiValues().includes(value)) {
			dragTarget = value;
			event.stopPropagation();
			return;
		}
		if (event.action !== "up") return;
		const def = multiDef();
		const source = dragValue;
		const target = dragTarget ?? value;
		dragValue = undefined;
		dragTarget = undefined;
		if (!def || !source) return;
		if (def.ordered && target !== source && multiValues().includes(target)) {
			const values = multiValues().filter(item => item !== source);
			const before = values.indexOf(target);
			if (before >= 0) values.splice(before, 0, source);
			applyMulti(values);
		} else {
			toggleMulti(source);
		}
		event.stopPropagation();
	};
	const mouseRoot = (event: HostMouseEvent): void => {
		if (event.action === "wheel") {
			event.preventDefault();
			const delta = event.wheel;
			if (delta === 0) return;
			if (editorMode() === "choice") {
				moveChoice(delta);
				return;
			}
			if (editorMode() === "multiselect") {
				const options = multiOptionsForEditor();
				setMultiIndex(index => Math.max(0, Math.min(Math.max(0, options.length - 1), index + delta)));
				return;
			}
			if (editorMode() === "provider-list") {
				const choices = providerChoices();
				setProviderIndex(index => Math.max(0, Math.min(Math.max(0, choices.length - 1), index + delta)));
				return;
			}
			if (editorMode() !== "closed") return;
			if (query()) {
				setSelectedIndex(index => Math.max(0, Math.min(Math.max(0, searchResults().length - 1), index + delta)));
				return;
			}
			if (panel() === "plugins") {
				ensurePlugins().handleInput(delta > 0 ? "\x1b[B" : "\x1b[A");
				return;
			}
			if (sectionFocused()) {
				moveSection(delta);
				return;
			}
			setSelectedIndex(index => Math.max(0, Math.min(Math.max(0, activeDefs().length - 1), index + delta)));
			return;
		}
	};
	return {
		tab,
		panel,
		query,
		selectedIndex,
		editing,
		draft,
		editorMode,
		choiceIndex,
		multiIndex,
		multiValues,
		providerIndex,
		providerId,
		error,
		sectionFocused,
		plugins: pluginController,
		searchResults,
		revision: version,
		focusOption(index) {
			if (editorMode() === "choice") moveChoice(index - choiceIndex());
			else if (editorMode() === "provider-list")
				setProviderIndex(Math.max(0, Math.min(providerChoices().length - 1, index)));
			else if (editorMode() === "multiselect")
				setMultiIndex(Math.max(0, Math.min(multiOptionsForEditor().length - 1, index)));
		},
		statusLinePreview() {
			return callbacks.getStatusLinePreview?.() ?? "(preview not available)";
		},
		handleInput(data) {
			if (disposed) return;
			if (handleEditorInput(data)) return;
			if (query()) {
				if (matchesSelectCancel(data)) return endSearch(true);
				if (matchesKey(data, "tab")) return cycleSearchTab(1);
				if (matchesKey(data, "shift+tab")) return cycleSearchTab(-1);
				if (matchesSelectUp(data)) return setSelectedIndex(index => Math.max(0, index - 1));
				if (matchesSelectDown(data))
					return setSelectedIndex(index => Math.min(Math.max(0, searchResults().length - 1), index + 1));
				if (matchesSelectPageUp(data)) return setSelectedIndex(index => Math.max(0, index - pageRows));
				if (matchesSelectPageDown(data))
					return setSelectedIndex(index => Math.min(Math.max(0, searchResults().length - 1), index + pageRows));
				if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") return activateCurrent();
				if (matchesKey(data, "backspace")) return setQuery(query().slice(0, -1));
				const typed = extractPrintableText(data);
				if (typed) setQuery(query() + typed);
				return;
			}
			if (panel() === "plugins") {
				if (matchesSelectCancel(data)) return callbacks.onCancel();
				if (matchesKey(data, "tab") || matchesKey(data, "right")) return cyclePanel(1);
				if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) return cyclePanel(-1);
				ensurePlugins().handleInput(data);
				return;
			}
			if (matchesSelectCancel(data)) return cancel();
			if (matchesKey(data, "left")) return cyclePanel(-1);
			if (matchesKey(data, "right")) return cyclePanel(1);
			if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
				if (activeSections().length >= 2) {
					setSectionFocused(value => !value);
					return;
				}
				return cyclePanel(matchesKey(data, "shift+tab") ? -1 : 1);
			}
			if (matchesSelectUp(data)) {
				if (sectionFocused()) moveSection(-1);
				else setSelectedIndex(index => Math.max(0, index - 1));
				return;
			}
			if (matchesSelectDown(data)) {
				if (sectionFocused()) moveSection(1);
				else setSelectedIndex(index => Math.min(Math.max(0, activeDefs().length - 1), index + 1));
				return;
			}
			if (matchesSelectPageUp(data)) {
				if (activeSections().length >= 2) moveSection(-1);
				else setSelectedIndex(index => Math.max(0, index - pageRows));
				return;
			}
			if (matchesSelectPageDown(data)) {
				if (activeSections().length >= 2) moveSection(1);
				else setSelectedIndex(index => Math.min(Math.max(0, activeDefs().length - 1), index + pageRows));
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "space") || data === "\n") {
				if (sectionFocused()) setSectionFocused(false);
				else activateCurrent();
				return;
			}
			const typed = extractPrintableText(data);
			if (typed && typed.trim()) setQuery(typed);
		},
		setQuery,
		setDraft: setDraftValue,
		selectPath,
		selectPanel,
		selectSearchTab,
		selectSection,
		activate() {
			if (editorMode() === "choice") commitChoice();
			else if (editorMode() === "text") submitText();
			else if (editorMode() === "provider-editor") submitProvider();
			else if (editorMode() === "provider-list" || editorMode() === "multiselect") handleEditorInput("\n");
			else activateCurrent();
		},
		cancel,
		mouseSetting,
		mouseMulti,
		mouseRoot,
		setPageRows(rows) {
			pageRows = Math.max(1, rows);
		},
		dispose() {
			disposed = true;
			themePreviewGeneration++;
			pluginController()?.dispose();
		},
	};
}

function settingsTabItems(theme: ThemeAccess, controller: SettingsSelectorController): readonly TabItem[] {
	if (!controller.query()) {
		return [
			...SETTING_TABS.map(id => ({
				id,
				label: `${theme.symbol(TAB_METADATA[id].icon)} ${TAB_METADATA[id].label}`,
				short: theme.symbol(TAB_METADATA[id].icon),
			})),
			{ id: "plugins", label: `${theme.symbol("icon.package")} Plugins`, short: theme.symbol("icon.package") },
		];
	}
	const results = controller.searchResults();
	const tabs = [...new Set(results.map(result => result.tab))];
	const matched = tabs.map(id => ({
		id,
		label: `${theme.symbol(TAB_METADATA[id].icon)} ${TAB_METADATA[id].label} (${results.filter(result => result.tab === id).length})`,
		short: `${theme.symbol(TAB_METADATA[id].icon)} ${results.filter(result => result.tab === id).length}`,
	}));
	const empty = SETTING_TABS.filter(id => !tabs.includes(id)).map(id => ({
		id,
		label: `${theme.symbol(TAB_METADATA[id].icon)} ${TAB_METADATA[id].label}`,
		short: theme.symbol(TAB_METADATA[id].icon),
		disabled: true,
	}));
	return [
		...matched,
		...empty,
		{
			id: "plugins",
			label: `${theme.symbol("icon.package")} Plugins`,
			short: theme.symbol("icon.package"),
			disabled: true,
		},
	];
}

function SettingsTabsView(props: { readonly controller: SettingsSelectorController }): JSX.Element {
	const theme = useTheme();
	const active = (): SettingsPanel => (props.controller.query() ? props.controller.tab() : props.controller.panel());
	const select = (item: TabItem): void => {
		if (item.disabled || props.controller.editorMode() !== "closed") return;
		if (item.id === "plugins") props.controller.selectPanel("plugins");
		else if (props.controller.query()) props.controller.selectSearchTab(item.id);
		else props.controller.selectPanel(item.id);
	};
	return (
		<row pad={false}>
			<For each={settingsTabItems(theme, props.controller)}>
				{item => (
					<box
						shrink={1}
						overflowPriority={item.id === active() ? 1 : 0}
						onMouse={event => {
							if (event.action !== "down") return;
							select(item);
							event.stopPropagation();
						}}
					>
						<text
							wrap="clip"
							overflow="ellipsis"
							color={item.disabled ? "dim" : item.id === active() ? "text" : "muted"}
							background={!item.disabled && item.id === active() ? "selectedBg" : undefined}
							bold={!item.disabled && item.id === active()}
						>
							{item.id === active() ? ` ${item.label} ` : ` ${item.short} `}
						</text>
					</box>
				)}
			</For>
		</row>
	);
}

function SettingRowsView(props: {
	readonly context: SettingsRuntimeContext;
	readonly controller: SettingsSelectorController;
	readonly defs: readonly SettingDef[];
	readonly searching?: boolean;
}): JSX.Element {
	const controller = props.controller;
	const [viewportHeight, setViewportHeight] = createSignal(1);
	const rows = (): readonly Row[] => rowsForDefs(props.defs);
	const selected = (): string | undefined => props.defs[controller.selectedIndex()]?.path;
	const help = (): SettingDef | undefined => (props.searching ? undefined : props.defs[controller.selectedIndex()]);
	const selectedRow = (): number => {
		const path = selected();
		return path === undefined
			? 0
			: Math.max(
					0,
					rows().findIndex(row => row.kind === "setting" && row.def.path === path),
				);
	};
	const pane = (
		<scroll
			grow={1}
			offset={Math.max(0, selectedRow() - Math.floor(viewportHeight() / 2))}
			followTail={false}
			shrinkToFit={false}
			onViewport={viewport => {
				setViewportHeight(viewport.height);
				controller.setPageRows(viewport.height);
			}}
		>
			<For each={rows()}>
				{row => {
					if (row.kind === "heading")
						return (
							<text color="muted" bold={true} wrap="clip">
								{row.label}
							</text>
						);
					const setting = row.def;
					const selectedRowValue = () => selected() === setting.path;
					const accent = () => {
						controller.revision();
						return selectedRowValue() || changed(props.context, setting);
					};
					const value = () => {
						controller.revision();
						return valueForDisplay(props.context, setting);
					};
					return (
						<box onMouse={event => controller.mouseSetting(setting.path, event)}>
							<row>
								<text
									grow={1}
									shrink={1}
									overflowPriority={1}
									color={accent() ? "accent" : undefined}
									wrap="clip"
									overflow="ellipsis"
								>{`${selectedRowValue() ? "› " : "  "}${setting.label}${setting.warning ? " !" : ""}`}</text>
								<text
									shrink={1}
									overflowPriority={0}
									color={accent() ? "accent" : "muted"}
									align="right"
									wrap="clip"
									overflow="ellipsis"
								>
									{value()}
								</text>
							</row>
						</box>
					);
				}}
			</For>
		</scroll>
	);
	const sections = (): readonly { readonly label: string; readonly firstPath: string }[] =>
		sectionsForDefs(props.defs);
	const activeSection = (): number =>
		Math.max(
			0,
			sections().findIndex(section => section.firstPath === selected()),
		);
	return (
		<stack height="fill">
			<row grow={1}>
				<box maxWidth={26} shrink={1} overflowPriority={0}>
					<For each={sections()}>
						{(section, index) => (
							<box
								onMouse={event => {
									if (event.action !== "down") return;
									controller.selectSection(index());
									event.stopPropagation();
								}}
							>
								<text
									color={index() === activeSection() ? "accent" : "dim"}
									wrap="clip"
									overflow="ellipsis"
								>{`${controller.sectionFocused() && index() === activeSection() ? "› " : "  "}${section.label || "General"}`}</text>
							</box>
						)}
					</For>
				</box>
				<text shrink={1} overflowPriority={0} color="border">
					│
				</text>
				<box grow={1} minWidth={32}>
					{pane}
				</box>
			</row>
			{!props.searching && help() ? (
				<scroll height={3} offset={0} followTail={false} shrinkToFit={false}>
					{help()!.warning ? <text color="warning" wrap="word">{`! ${help()!.warning}`}</text> : null}
					<text color="dim" wrap="word">
						{help()!.description}
					</text>
				</scroll>
			) : null}
		</stack>
	);
}

function SearchRowsView(props: {
	readonly context: SettingsRuntimeContext;
	readonly controller: SettingsSelectorController;
}): JSX.Element {
	const focus = useFocus();
	const [viewportHeight, setViewportHeight] = createSignal(1);
	createEffect(() => {
		if (props.controller.query()) focus.focus();
	});
	const groups = (): readonly {
		readonly tab: SettingTab;
		readonly matches: readonly { readonly result: SearchResult; readonly index: number }[];
	}[] => {
		const groups: { tab: SettingTab; matches: { result: SearchResult; index: number }[] }[] = [];
		for (const [index, result] of props.controller.searchResults().entries()) {
			const group = groups[groups.length - 1];
			if (group?.tab === result.tab) group.matches.push({ result, index });
			else groups.push({ tab: result.tab, matches: [{ result, index }] });
		}
		return groups;
	};
	const count = (): number => props.controller.searchResults().length;
	const selected = (): SettingDef | undefined =>
		props.controller.searchResults()[props.controller.selectedIndex()]?.def;
	const selectedRow = (): number =>
		searchRows(props.controller.searchResults()).findIndex(
			row => row.result === props.controller.searchResults()[props.controller.selectedIndex()],
		);
	return (
		<stack height="fill">
			<row>
				<text shrink={0} color="accent">
					{useTheme().symbol("icon.search")}
				</text>
				<input
					grow={1}
					tabIndex={focus.tabIndex}
					value={props.controller.query()}
					prompt=" "
					onChange={props.controller.setQuery}
					onSubmit={props.controller.activate}
					onEscape={props.controller.cancel}
				/>
				<text
					shrink={1}
					overflowPriority={0}
					color={count() ? "dim" : "warning"}
					align="right"
					wrap="clip"
					overflow="ellipsis"
				>{`${count()} ${count() === 1 ? "match" : "matches"}`}</text>
			</row>
			<scroll
				grow={1}
				offset={Math.max(0, selectedRow() - Math.floor(viewportHeight() / 2))}
				followTail={false}
				shrinkToFit={false}
				onViewport={viewport => {
					setViewportHeight(viewport.height);
					props.controller.setPageRows(viewport.height);
				}}
			>
				<For each={groups()}>
					{group => (
						<stack>
							<text
								color="muted"
								bold
							>{`${useTheme().symbol(TAB_METADATA[group.tab].icon)} ${TAB_METADATA[group.tab].label}`}</text>
							<For each={group.matches}>
								{match => (
									<box onMouse={event => props.controller.mouseSetting(match.result.def.path, event)}>
										<row>
											<text
												grow={1}
												shrink={1}
												overflowPriority={1}
												color={match.index === props.controller.selectedIndex() ? "accent" : undefined}
												wrap="clip"
												overflow="ellipsis"
											>{`${match.index === props.controller.selectedIndex() ? "› " : "  "}${match.result.def.label}${match.result.def.warning ? " !" : ""}`}</text>
											<text
												shrink={1}
												overflowPriority={0}
												color={match.index === props.controller.selectedIndex() ? "accent" : "muted"}
												align="right"
												wrap="clip"
												overflow="ellipsis"
											>
												{valueForDisplay(props.context, match.result.def)}
											</text>
										</row>
									</box>
								)}
							</For>
						</stack>
					)}
				</For>
				{count() === 0 ? <text color="dim">No matching settings</text> : null}
			</scroll>
			{selected() ? (
				<scroll height={3} offset={0} followTail={false} shrinkToFit={false}>
					{selected()!.warning ? <text color="warning" wrap="word">{`! ${selected()!.warning}`}</text> : null}
					<text color="dim" wrap="word">
						{selected()!.description}
					</text>
				</scroll>
			) : null}
		</stack>
	);
}

function ChoiceEditorView(props: {
	readonly context: SettingsRuntimeContext;
	readonly controller: SettingsSelectorController;
	readonly def: SubmenuSettingDef;
}): JSX.Element {
	const options = (): readonly SubmenuOption[] => optionsFor(props.context, props.def);
	const selected = (): SubmenuOption | undefined => options()[props.controller.choiceIndex()];
	const visibleRows = () => Math.min(CHOICE_ROWS, Math.max(1, options().length));
	const offset = () =>
		scrollOffsetForRow(0, props.controller.choiceIndex(), options().length, visibleRows(), "center");
	return (
		<stack>
			<text color="accent" wrap="word">
				{props.def.label}
			</text>
			<text color="muted" wrap="word">
				{props.def.description}
			</text>
			<select
				options={options()}
				selectedIndex={props.controller.choiceIndex()}
				offset={offset()}
				maxRows={visibleRows()}
				onMouse={event => {
					if (event.action !== "down" || event.button !== 0) return;
					const index = offset() + event.localRow;
					if (index < 0 || index >= options().length) return;
					if (index === props.controller.choiceIndex()) props.controller.activate();
					else props.controller.focusOption(index);
					event.stopPropagation();
				}}
			/>
			{props.def.path === "composer.shape" && selected() ? (
				<ComposerShapePreviewView shape={selected()!.value} status={props.context.composerPreviewStatus} />
			) : null}
			{props.def.path === "snapcompact.shape" ? (
				<SnapcompactShapePreviewView
					value={() => selected()?.value ?? ""}
					model={props.context.model}
					imageBudget={props.context.imageBudget}
				/>
			) : null}
			{props.def.path === "theme.dark" || props.def.path === "theme.light" ? (
				<stack>
					<text color="muted">Preview:</text>
					<box>{props.controller.statusLinePreview()}</box>
				</stack>
			) : null}
			<text color="dim">Enter select · Esc go back</text>
		</stack>
	);
}

function TextEditorView(props: {
	readonly controller: SettingsSelectorController;
	readonly label: string;
	readonly description: string;
	readonly secret: boolean;
	readonly provider?: string;
}): JSX.Element {
	const focus = useFocus();
	createEffect(() => {
		if (props.controller.editorMode() === "text" || props.controller.editorMode() === "provider-editor")
			focus.focus();
	});
	return (
		<stack>
			<text color="accent" wrap="word">
				{props.provider ? `${props.label}: ${props.provider}` : props.label}
			</text>
			<text color="muted" wrap="word">
				{props.description}
			</text>
			<input
				tabIndex={focus.tabIndex}
				value={props.controller.draft()}
				prompt="> "
				mask={props.secret}
				onChange={props.controller.setDraft}
				onSubmit={() => props.controller.handleInput("\n")}
				onEscape={props.controller.cancel}
			/>
			{props.controller.error() ? (
				<text color="error" wrap="word">
					{props.controller.error()}
				</text>
			) : null}
			<text color="dim">Enter save · Esc cancel · Clear field to unset</text>
		</stack>
	);
}

function ProviderLimitsView(props: {
	readonly context: SettingsRuntimeContext;
	readonly controller: SettingsSelectorController;
	readonly def: Extract<SettingDef, { type: "providerLimits" }>;
}): JSX.Element {
	const limits = createMemo(() => {
		props.controller.revision();
		return props.context.settings.normalizeProviderLimits(props.context.settings.get(props.def.path));
	});
	const choices = createMemo<readonly SelectOption[]>(() => {
		const values = limits();
		const providers = [...new Set([...props.context.providers, ...Object.keys(values)])].sort((left, right) =>
			left.localeCompare(right),
		);
		const options: SelectOption[] = providers.map(provider => ({
			value: provider,
			label: provider,
			description: values[provider] === undefined ? "Unlimited" : `Limit: ${values[provider]}`,
		}));
		if (Object.keys(values).length > 0)
			options.push({
				value: "__clear_all",
				label: "Clear all limits",
				description: "Make every provider unlimited",
			});
		return options;
	});
	const visibleRows = () => Math.min(LIST_ROWS, Math.max(1, choices().length));
	const offset = () =>
		scrollOffsetForRow(0, props.controller.providerIndex(), choices().length, visibleRows(), "center");
	if (props.controller.editorMode() === "provider-editor")
		return (
			<TextEditorView
				controller={props.controller}
				label={props.def.label}
				description="Enter a positive number. Decimals round down. Clear the field to make this provider unlimited."
				secret={false}
				provider={props.controller.providerId()}
			/>
		);
	return (
		<stack>
			<text color="accent">{props.def.label}</text>
			<text color="muted" wrap="word">
				Select a provider, enter a positive number to cap concurrent LLM requests, or clear it for unlimited.
			</text>
			<select
				options={choices()}
				selectedIndex={props.controller.providerIndex()}
				offset={offset()}
				maxRows={visibleRows()}
				onMouse={event => {
					if (event.action !== "down" || event.button !== 0) return;
					const index = offset() + event.localRow;
					if (index < 0 || index >= choices().length) return;
					props.controller.focusOption(index);
					props.controller.activate();
					event.stopPropagation();
				}}
			/>
			{props.controller.error() ? <text color="error">{props.controller.error()}</text> : null}
			<text color="dim">Enter edit provider · Esc go back</text>
		</stack>
	);
}

function MultiSelectEditorView(props: {
	readonly context: SettingsRuntimeContext;
	readonly controller: SettingsSelectorController;
	readonly def: MultiSelectSettingDef;
}): JSX.Element {
	const options = createMemo<readonly SelectOption[]>(() => {
		props.controller.revision();
		const selected = props.controller.multiValues();
		return multiOptions(props.context, props.def).map(option => {
			const position = selected.indexOf(option.value);
			const mark =
				position < 0
					? props.def.ordered
						? " · "
						: " ○ "
					: props.def.ordered
						? `${String(position + 1).padStart(2)}.`
						: " ● ";
			return {
				value: option.value,
				label: `${mark} ${option.label}`,
				description: option.description,
				color: position >= 0 ? "accent" : "dim",
			};
		});
	});
	const visibleRows = () => Math.min(LIST_ROWS, Math.max(1, options().length));
	const offset = () => scrollOffsetForRow(0, props.controller.multiIndex(), options().length, visibleRows(), "center");
	return (
		<stack>
			<text color="accent" wrap="word">
				{props.def.label}
			</text>
			<text color="muted" wrap="word">
				{props.def.description}
			</text>
			<select
				options={options()}
				selectedIndex={props.controller.multiIndex()}
				offset={offset()}
				maxRows={visibleRows()}
				onMouse={event => {
					const option = options()[offset() + event.localRow];
					if (option) props.controller.mouseMulti(option.value, event);
				}}
			/>
			<text color="dim">
				{props.def.ordered
					? "Click toggle · drag selected items reorder · ←/→ move · 1-9 place · Esc go back"
					: "Click/Enter/Space toggle · Esc go back"}
			</text>
		</stack>
	);
}

export interface SettingsSelectorViewProps {
	readonly context: SettingsRuntimeContext;
	readonly controller: SettingsSelectorController;
}

export function SettingsSelectorView(props: SettingsSelectorViewProps): JSX.Element {
	const panelFocus = useFocus();
	const controller = props.controller;
	createEffect(() => {
		if (controller.editorMode() === "closed" && !controller.query()) panelFocus.focus();
	});
	const currentDef = (): SettingDef | undefined => {
		const entry = controller.editing();
		return entry ? getSettingDef(props.context.settings.entries, entry.path) : undefined;
	};
	const body = (): JSX.Element => {
		const def = currentDef();
		// A global result can open any editor. Editors must win over the retained
		// query so the selection is visible and receives its own input.
		if (controller.editorMode() === "choice" && def?.type === "submenu")
			return <ChoiceEditorView context={props.context} controller={controller} def={def} />;
		if (controller.editorMode() === "text" && def?.type === "text")
			return (
				<TextEditorView
					controller={controller}
					label={def.label}
					description={def.description}
					secret={def.secret}
				/>
			);
		if (
			(controller.editorMode() === "provider-list" || controller.editorMode() === "provider-editor") &&
			def?.type === "providerLimits"
		)
			return <ProviderLimitsView context={props.context} controller={controller} def={def} />;
		if (controller.editorMode() === "multiselect" && def?.type === "multiselect")
			return <MultiSelectEditorView context={props.context} controller={controller} def={def} />;
		if (controller.query()) return <SearchRowsView context={props.context} controller={controller} />;
		if (controller.panel() === "plugins") {
			const plugins = controller.plugins();
			return plugins ? <PluginSettingsView controller={plugins} /> : <text color="dim">Loading plugins…</text>;
		}
		return (
			<SettingRowsView
				context={props.context}
				controller={controller}
				defs={visibleDefs(props.context, controller.tab())}
			/>
		);
	};
	const footer = (): string => {
		if (controller.editorMode() !== "closed") return "Esc to go back";
		if (controller.query()) return "Enter to change · Tab to jump tabs · Esc to exit search";
		if (controller.panel() === "plugins") return "Tab to switch tabs · Esc to close";
		if (controller.sectionFocused()) return "↑/↓ jump sections · Tab/Enter settings · ←/→ switch tabs · Esc close";
		const sections = sectionsForDefs(visibleDefs(props.context, controller.tab()));
		return `Enter/Space change · ${sections.length >= 2 ? "Tab jump sections · ←/→ switch tabs" : "Tab switch tabs"} · Type search · Esc close`;
	};
	const showPreview = (): boolean =>
		!controller.query() && controller.panel() === "appearance" && controller.editorMode() === "closed";
	const handleKey = (event: HostKeyEvent): void => {
		if (event.defaultPrevented) return;
		controller.handleInput(event.data);
		event.preventDefault();
	};
	return (
		<box height="fill" tabIndex={panelFocus.tabIndex} onKey={handleKey} onMouse={controller.mouseRoot}>
			<frame height="fill" title="Settings" paddingX={1} paddingY={0} borderPolicy="always" renderEmpty>
				<stack height="fill">
					<SettingsTabsView controller={controller} />
					<hr variant="frame" />
					<box grow={1}>{body()}</box>
					{showPreview() ? (
						<stack>
							<text color="muted">Preview:</text>
							<box>{controller.statusLinePreview()}</box>
						</stack>
					) : null}
					<hr variant="frame" />
					<text color="dim" wrap="clip">
						{footer()}
					</text>
				</stack>
			</frame>
		</box>
	);
}

export interface SettingsSelectorOverlayProps {
	readonly context: SettingsRuntimeContext;
	readonly callbacks: SettingsCallbacks;
}
export interface SettingsSelectorHandle extends OverlayDisposer, SettingsSelectorController {}

export function openSettingsSelectorOverlay(tui: TUI, props: SettingsSelectorOverlayProps): SettingsSelectorHandle {
	const controller = createSettingsSelectorController(props.context, props.callbacks);
	const disposer = mountOverlay(tui, () => (
		<Portal to="overlay" fullscreen anchor="top-left" width="100%" maxHeight="100%" margin={0} mouseTracking>
			<SettingsSelectorView context={props.context} controller={controller} />
		</Portal>
	));
	return bindOverlayController(disposer, controller);
}
