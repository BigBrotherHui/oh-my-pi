import { createMemo, createSignal, type Accessor, type JSX, useTheme } from "../reactive";
import { extractPrintableText, matchesKey } from "../keys";
import { matchesSelectCancel } from "../keybinding-matchers";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import { HostKeyEvent, type HostMouseEvent } from "../host/input";
import type { SelectOption } from "../host/elements/select";
import { cellWidth } from "../core/richtext";
import { shortenPath } from "../render/render-utils";
import type { TUI } from "../tui";
import { createSelectController } from "./select-overlay";

export type PluginSettingSchema = { description?: string; secret?: boolean } & (
	| { type: "string"; default?: string }
	| { type: "number"; default?: number; min?: number; max?: number }
	| { type: "boolean"; default?: boolean }
	| { type: "enum"; default?: string; values: string[] }
);

export interface InstalledPlugin {
	name: string;
	version: string;
	enabled: boolean;
	enabledFeatures: string[] | null;
	manifest: {
		description?: string;
		features?: Record<string, { description?: string; default?: boolean }>;
		settings?: Record<string, PluginSettingSchema>;
	};
}

export interface InstalledPluginSummary {
	id: string;
	scope: "user" | "project";
	shadowedBy?: "project";
	entries: {
		installPath: string;
		version: string;
		installedAt: string;
		lastUpdated: string;
		gitCommitSha?: string;
		enabled?: boolean;
	}[];
}

export interface PluginSettingsManager {
	list(): Promise<InstalledPlugin[]>;
	getPlugin(name: string, options?: { path?: string }): Promise<InstalledPlugin | undefined>;
	getPluginSettings(name: string): Promise<Record<string, unknown>>;
	setEnabled(name: string, enabled: boolean): Promise<void>;
	getEnabledFeatures(name: string): Promise<string[] | null>;
	setEnabledFeatures(name: string, features: string[] | null): Promise<void>;
	setPluginSetting(name: string, key: string, value: unknown): Promise<void>;
}

export interface PluginSettingsMarketplaceManager {
	listInstalledPlugins(): Promise<InstalledPluginSummary[]>;
	setPluginEnabled(pluginId: string, enabled: boolean, scope?: "user" | "project"): Promise<void>;
}

export interface PluginSettingsHost {
	manager: PluginSettingsManager;
	createMarketplaceManager(): Promise<PluginSettingsMarketplaceManager>;
	parsePluginId(id: string): { name: string } | null;
}

export function handleInputOrEscape(
	data: string,
	input: { handleInput(data: string): void },
	onCancel: () => void,
): void {
	if (data === "\x1b" || data === "\x1b\x1b" || matchesKey(data, "escape")) {
		onCancel();
		return;
	}
	input.handleInput(data);
}

export type PluginListEntry =
	| { kind: "npm"; plugin: InstalledPlugin }
	| { kind: "marketplace"; plugin: InstalledPluginSummary };

export interface PluginListCallbacks {
	onNpmSelect: (plugin: InstalledPlugin) => void;
	onMarketplaceSelect: (plugin: InstalledPluginSummary) => void;
	onCancel: () => void;
}

function entryValue(entry: PluginListEntry): string {
	return entry.kind === "npm" ? `npm:${entry.plugin.name}` : `mkt:${entry.plugin.scope}:${entry.plugin.id}`;
}

function entryEnabled(entry: PluginListEntry): boolean {
	return entry.kind === "npm" ? entry.plugin.enabled : entry.plugin.entries[0]?.enabled !== false;
}

function entryLabel(entry: PluginListEntry): string {
	return entry.kind === "npm" ? entry.plugin.name : entry.plugin.id;
}

function entryOptions(entries: readonly PluginListEntry[]): readonly SelectOption[] {
	return entries.map(entry => {
		if (entry.kind === "npm") {
			const plugin = entry.plugin;
			let featureCount = 0;
			const features = plugin.manifest.features;
			if (features) {
				for (const _name in features) featureCount++;
			}
			const enabledCount = plugin.enabledFeatures?.length ?? featureCount;
			const details = [`[npm]`, `v${plugin.version}`];
			if (featureCount > 0) details.push(`${enabledCount}/${featureCount} features`);
			return {
				value: entryValue(entry),
				label: entryLabel(entry),
				description: details.join(" · "),
			};
		}
		const plugin = entry.plugin;
		const details = [`[marketplace]`, `[${plugin.scope}]`, `v${plugin.entries[0]?.version ?? "?"}`];
		if (plugin.shadowedBy) details.push(`shadowed by ${plugin.shadowedBy}`);
		return {
			value: entryValue(entry),
			label: entryLabel(entry),
			description: details.join(" · "),
		};
	});
}

function viewportOffset(selectedIndex: number, itemCount: number, maxRows: number): number {
	if (itemCount <= maxRows) return 0;
	return Math.max(0, Math.min(itemCount - maxRows, selectedIndex - maxRows + 1));
}

function PluginListRows(props: {
	readonly entries: readonly PluginListEntry[];
	readonly options: readonly SelectOption[];
	readonly selectedIndex: number;
	readonly hoveredIndex?: number | null;
	readonly offset: number;
	readonly maxRows: number;
	readonly emptyText: string;
	readonly onMouse?: (event: HostMouseEvent) => void;
}): JSX.Element {
	const theme = useTheme();
	return (
		<sized
			paint={width => {
				const visible = props.options.slice(props.offset, props.offset + props.maxRows);
				if (visible.length === 0) return <text color="dim">{props.emptyText}</text>;

				const statusWidth =
					Math.max(cellWidth(theme.symbol("status.enabled")), cellWidth(theme.symbol("status.disabled"))) + 1;
				let longestLabel = 0;
				for (const option of props.options) longestLabel = Math.max(longestLabel, cellWidth(option.label));
				const primaryColumnWidth =
					width > 40
						? Math.max(1, Math.min(64, Math.max(24, statusWidth + longestLabel + 2), width - 14))
						: Math.max(1, width - 2);
				const labelWidth = Math.max(1, primaryColumnWidth - statusWidth);

				return (
					<stack onMouse={props.onMouse}>
						{visible.map((option, index) => {
							let entry: PluginListEntry | undefined;
							for (const candidate of props.entries) {
								if (entryValue(candidate) === option.value) {
									entry = candidate;
									break;
								}
							}
							if (!entry) return null;
							const selected = props.offset + index === props.selectedIndex;
							const hovered = props.offset + index === props.hoveredIndex;
							const enabled = entryEnabled(entry);
							const shadowed = entry.kind === "marketplace" && entry.plugin.shadowedBy !== undefined;
							return (
								<row>
									<text color={selected || hovered ? "accent" : undefined}>
										{selected ? `${theme.symbol("nav.cursor")} ` : "  "}
									</text>
									<text color={enabled ? "success" : "muted"}>
										{theme.symbol(enabled ? "status.enabled" : "status.disabled")}
									</text>
									<text> </text>
									<box width={labelWidth} shrink={0}>
										<row>
											<text color={selected || hovered ? "accent" : undefined} wrap="clip">
												{entryLabel(entry)}
											</text>
											{shadowed ? <text color="warning"> {theme.symbol("status.shadowed")}</text> : null}
										</row>
									</box>
									{width > 40 && option.description ? (
										<text color={selected || hovered ? "accent" : "dim"} wrap="clip">
											{option.description}
										</text>
									) : null}
								</row>
							);
						})}
					</stack>
				);
			}}
		/>
	);
}

export function PluginListView(props: {
	readonly entries: readonly PluginListEntry[];
	readonly options?: readonly SelectOption[];
	readonly selectedIndex?: number;
	readonly hoveredIndex?: number | null;
	readonly offset?: number;
	readonly searchQuery?: string;
	readonly searchEnabled?: boolean;
	readonly title?: string;
	readonly error?: string;
	readonly onMouse?: (event: HostMouseEvent) => void;
}): JSX.Element {
	const options = props.options ?? entryOptions(props.entries);
	const selectedIndex = Math.max(0, Math.min(Math.max(0, options.length - 1), props.selectedIndex ?? 0));
	const maxRows = Math.min(props.entries.length, 8);
	const offset = props.offset ?? viewportOffset(selectedIndex, props.entries.length, maxRows);
	const noMatches = props.entries.length > 0 && options.length === 0 && Boolean(props.searchQuery);
	return (
		<frame title={props.title ?? "Plugins"} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<stack>
				{props.entries.length === 0 ? (
					<>
						<br />
						<text color="muted">No plugins installed</text>
						<br />
						<text color="dim" wrap="clip">
							Install npm plugins: omp plugin install &lt;package&gt;
						</text>
						<text color="dim" wrap="clip">
							Install marketplace plugins: omp plugin install &lt;name&gt;@&lt;marketplace&gt;
						</text>
						<br />
					</>
				) : (
					<>
						<br />
						{noMatches && props.searchEnabled ? <text color="dim"> Search: {props.searchQuery}</text> : null}
						<PluginListRows
							entries={props.entries}
							options={options}
							selectedIndex={selectedIndex}
							hoveredIndex={props.hoveredIndex}
							offset={offset}
							maxRows={maxRows}
							emptyText={props.searchQuery ? "No matching plugins" : "No plugins installed"}
							onMouse={props.onMouse}
						/>
						{!noMatches && props.searchEnabled ? (
							<text color="dim">
								{props.searchQuery ? `  Search: ${props.searchQuery}` : "  Type to search"}
							</text>
						) : null}
						<br />
					</>
				)}
				{props.error ? (
					<text color="error" wrap="word">
						{props.error}
					</text>
				) : null}
				{props.entries.length ? <text color="dim">Enter to configure · Esc to go back</text> : null}
			</stack>
		</frame>
	);
}

export interface PluginDetailCallbacks {
	onEnabledChange: (enabled: boolean) => void;
	onFeatureChange?: (feature: string, enabled: boolean) => void;
	onConfigChange?: (key: string, value: unknown) => void | Promise<void>;
	onBack: () => void;
}

export interface MarketplacePluginDetailCallbacks {
	parsePluginId: PluginSettingsHost["parsePluginId"];
	onEnabledChange: (enabled: boolean) => void;
	onConfigChange?: (pluginName: string, key: string, value: unknown) => void | Promise<void>;
	onBack: () => void;
}

export interface PluginDetailItem {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly description?: string;
}

function fallbackDetailItems(
	enabled: boolean,
	settings: Record<string, unknown> | undefined,
): readonly PluginDetailItem[] {
	return [
		{
			id: "__enabled__",
			label: "Enabled",
			value: enabled ? "true" : "false",
			description: "Enable or disable this plugin",
		},
		...Object.entries(settings ?? {}).map(([key, value]) => ({
			id: `config:${key}`,
			label: `  ${key}`,
			value: String(value),
		})),
	];
}

export function PluginDetailView(props: {
	readonly title: string;
	readonly enabled: boolean;
	readonly description?: string;
	readonly settings?: Record<string, unknown>;
	readonly items?: readonly PluginDetailItem[];
	readonly options?: readonly SelectOption[];
	readonly selectedIndex?: number;
	readonly offset?: number;
	readonly searchQuery?: string;
	readonly searchEnabled?: boolean;
	readonly summary?: readonly string[];
	readonly loading?: boolean;
	readonly onMouse?: (event: HostMouseEvent) => void;
	readonly busy?: boolean;
	readonly error?: string;
}): JSX.Element {
	const items = props.items ?? fallbackDetailItems(props.enabled, props.settings);
	const options =
		props.options ??
		items.map(item => ({
			value: item.id,
			label: item.label,
			description: [item.value, item.description].filter((part): part is string => Boolean(part)).join(" · "),
		}));
	const selectedIndex = Math.max(0, Math.min(Math.max(0, options.length - 1), props.selectedIndex ?? 0));
	const maxRows = Math.min(items.length, 10);
	return (
		<frame title={props.title} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<stack>
				{props.description ? (
					<text color="muted" wrap="word">
						{props.description}
					</text>
				) : null}
				{props.summary?.map(line => (
					<text color="dim" wrap="clip">
						{line}
					</text>
				))}
				{props.summary?.length ? <br /> : null}
				{items.length ? (
					<select
						options={options}
						selectedIndex={selectedIndex}
						offset={props.offset ?? viewportOffset(selectedIndex, items.length, maxRows)}
						maxRows={maxRows}
						onMouse={props.onMouse}
					/>
				) : null}
				{props.searchEnabled ? (
					<text color="dim">{props.searchQuery ? `  Search: ${props.searchQuery}` : "  Type to search"}</text>
				) : null}
				{props.loading ? <text color="dim">Loading settings…</text> : null}
				{props.busy ? <text color="dim">Saving…</text> : null}
				{props.error ? (
					<text color="error" wrap="word">
						{props.error}
					</text>
				) : null}
				<text color="dim">Enter to edit · Esc to go back</text>
			</stack>
		</frame>
	);
}

export function MarketplacePluginDetailView(props: {
	readonly title: string;
	readonly enabled: boolean;
	readonly scope: "user" | "project";
	readonly version?: string;
	readonly description?: string;
	readonly settings?: Record<string, unknown>;
	readonly items?: readonly PluginDetailItem[];
	readonly options?: readonly SelectOption[];
	readonly selectedIndex?: number;
	readonly offset?: number;
	readonly searchQuery?: string;
	readonly searchEnabled?: boolean;
	readonly summary?: readonly string[];
	readonly loading?: boolean;
	readonly onMouse?: (event: HostMouseEvent) => void;
	readonly busy?: boolean;
	readonly error?: string;
}): JSX.Element {
	return (
		<PluginDetailView
			title={props.title}
			enabled={props.enabled}
			description={props.description ?? `[${props.scope}]`}
			settings={props.settings}
			items={props.items}
			options={props.options}
			selectedIndex={props.selectedIndex}
			offset={props.offset}
			searchQuery={props.searchQuery}
			searchEnabled={props.searchEnabled}
			summary={props.summary ?? [`version       ${props.version ?? "(unknown)"}`, `scope         ${props.scope}`]}
			loading={props.loading}
			onMouse={props.onMouse}
			busy={props.busy}
			error={props.error}
		/>
	);
}

export interface PluginSettingsCallbacks {
	onClose: () => void;
	onPluginsChanged?: () => void | Promise<void>;
	onConfigChange?: (plugin: string, key: string, value: unknown) => void | Promise<void>;
}

export type PluginSettingsScreen = "list" | "npm-detail" | "marketplace-detail" | "config-input" | "config-enum";

type NpmDetailState = {
	readonly kind: "npm";
	readonly plugin: InstalledPlugin;
	readonly settings: Record<string, unknown>;
	readonly loading: boolean;
	readonly settingsLoaded: boolean;
};

type MarketplaceDetailState = {
	readonly kind: "marketplace";
	readonly plugin: InstalledPluginSummary;
	readonly runtimePlugin?: InstalledPlugin;
	readonly settings: Record<string, unknown>;
	readonly loading: boolean;
	readonly settingsLoaded: boolean;
};

export type PluginDetailState = NpmDetailState | MarketplaceDetailState;

type EditablePluginSettingSchema = { description?: string; secret?: boolean } & (
	| { type: "string"; default?: string }
	| { type: "number"; default?: number; min?: number; max?: number }
	| { type: "enum"; default?: string; values: string[] }
);

type ConfigEditorItem = {
	readonly kind: "config-editor";
	readonly id: string;
	readonly key: string;
	readonly schema: EditablePluginSettingSchema;
	readonly label: string;
	readonly value: string;
	readonly description: string;
};

type DetailItem =
	| {
			readonly kind: "enabled";
			readonly id: "__enabled__";
			readonly label: string;
			readonly value: string;
			readonly description: string;
	  }
	| {
			readonly kind: "feature";
			readonly id: string;
			readonly feature: string;
			readonly label: string;
			readonly value: string;
			readonly description: string;
	  }
	| {
			readonly kind: "config-toggle";
			readonly id: string;
			readonly key: string;
			readonly schema: PluginSettingSchema;
			readonly label: string;
			readonly value: string;
			readonly description: string;
	  }
	| ConfigEditorItem;

export type ConfigEditorState = {
	readonly pluginName: string;
	readonly key: string;
	readonly schema: EditablePluginSettingSchema;
	readonly draft: string;
};

export interface PluginSettingsController {
	readonly entries: Accessor<readonly PluginListEntry[]>;
	readonly selectedIndex: Accessor<number>;
	readonly selected: Accessor<PluginListEntry | undefined>;
	readonly visibleListOptions: Accessor<readonly SelectOption[]>;
	readonly listHoveredIndex: Accessor<number | null | undefined>;
	readonly listOffset: Accessor<number>;
	readonly listQuery: Accessor<string>;
	readonly listSearchEnabled: Accessor<boolean>;
	readonly detail: Accessor<boolean>;
	readonly screen: Accessor<PluginSettingsScreen>;
	readonly currentDetail: Accessor<PluginDetailState | undefined>;
	readonly detailIndex: Accessor<number>;
	readonly visibleDetailOptions: Accessor<readonly SelectOption[]>;
	readonly detailOffset: Accessor<number>;
	readonly detailQuery: Accessor<string>;
	readonly detailSearchEnabled: Accessor<boolean>;
	readonly detailItems: Accessor<readonly PluginDetailItem[]>;
	readonly editor: Accessor<ConfigEditorState | undefined>;
	readonly editorIndex: Accessor<number>;
	readonly visibleEditorOptions: Accessor<readonly SelectOption[]>;
	readonly editorOffset: Accessor<number>;
	readonly editorQuery: Accessor<string>;
	readonly editorSearchEnabled: Accessor<boolean>;
	readonly busy: Accessor<boolean>;
	readonly error: Accessor<string | undefined>;
	handleInput(data: string): void;
	handleKey(event: HostKeyEvent): void;
	handleListMouse(event: HostMouseEvent): void;
	handleDetailMouse(event: HostMouseEvent): void;
	handleEditorMouse(event: HostMouseEvent): void;
	refresh(): Promise<void>;
	close(): void;
	dispose(): void;
}

function messageFor(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

function effectiveFeatures(plugin: InstalledPlugin): Set<string> {
	if (plugin.enabledFeatures !== null) return new Set(plugin.enabledFeatures);
	const enabled = new Set<string>();
	const features = plugin.manifest.features;
	if (!features) return enabled;
	for (const name in features) {
		if (features[name].default) enabled.add(name);
	}
	return enabled;
}

function hasManifestSettings(plugin: InstalledPlugin): boolean {
	const settings = plugin.manifest.settings;
	if (!settings) return false;
	for (const _key in settings) return true;
	return false;
}

function pluginDetailItems(detail: PluginDetailState): readonly DetailItem[] {
	const plugin = detail.kind === "npm" ? detail.plugin : detail.runtimePlugin;
	const items: DetailItem[] = [
		{
			kind: "enabled",
			id: "__enabled__",
			label: "Enabled",
			value:
				detail.kind === "npm"
					? detail.plugin.enabled
						? "true"
						: "false"
					: entryEnabled({ kind: "marketplace", plugin: detail.plugin })
						? "true"
						: "false",
			description:
				detail.kind === "npm" ? "Enable or disable this plugin" : "Enable or disable this marketplace plugin",
		},
	];
	if (!plugin) return items;

	if (detail.kind === "npm") {
		const enabled = effectiveFeatures(plugin);
		const features = plugin.manifest.features;
		if (features) {
			for (const name in features) {
				const feature = features[name];
				items.push({
					kind: "feature",
					id: `feature:${name}`,
					feature: name,
					label: `  ${name}`,
					value: enabled.has(name) ? "true" : "false",
					description: feature.description || `Enable ${name} feature`,
				});
			}
		}
	}

	if (!detail.settingsLoaded) return items;
	const settings = plugin.manifest.settings;
	if (!settings) return items;
	for (const key in settings) {
		const schema = settings[key];
		const value = detail.settings[key] ?? schema.default;
		const base = {
			id: `config:${key}`,
			key,
			schema,
			label: `  ${key}`,
			value:
				schema.type === "boolean"
					? value
						? "true"
						: "false"
					: schema.secret && value
						? "••••••••"
						: String(value ?? "(not set)"),
			description: schema.description || `Configure ${key}`,
		};
		if (schema.type === "boolean") {
			items.push({ kind: "config-toggle", ...base });
		} else {
			const editorSchema: EditablePluginSettingSchema = schema;
			items.push({ kind: "config-editor", ...base, schema: editorSchema });
		}
	}
	return items;
}

function marketplaceSummary(plugin: InstalledPluginSummary): readonly string[] {
	const entry = plugin.entries[0];
	const summary = [
		`version       ${entry?.version ?? "(unknown)"}`,
		`scope         ${plugin.scope}`,
		`install path  ${entry?.installPath ? shortenPath(entry.installPath) : "(unknown)"}`,
		`installed at  ${entry?.installedAt ?? "(unknown)"}`,
		`last updated  ${entry?.lastUpdated ?? "(unknown)"}`,
	];
	if (entry?.gitCommitSha) summary.push(`git sha       ${entry.gitCommitSha}`);
	return summary;
}

function editorTypeHint(schema: PluginSettingSchema): string {
	if (schema.type !== "number" || (schema.min === undefined && schema.max === undefined))
		return `Type: ${schema.type}`;
	return `Type: number (${schema.min ?? ""}..${schema.max ?? ""})`;
}

export function createPluginSettingsController(
	host: PluginSettingsHost,
	callbacks: PluginSettingsCallbacks,
): PluginSettingsController {
	const [entries, setEntries] = createSignal<PluginListEntry[]>([]);
	const [screen, setScreen] = createSignal<PluginSettingsScreen>("list");
	const [currentDetail, setCurrentDetail] = createSignal<PluginDetailState>();
	const [editor, setEditor] = createSignal<ConfigEditorState>();
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string>();
	const listOptions = createMemo(() => entryOptions(entries()));
	const detailControls = createMemo<readonly DetailItem[]>(() => {
		const current = currentDetail();
		return current ? pluginDetailItems(current) : [];
	});
	const detailItems = createMemo<readonly PluginDetailItem[]>(() =>
		detailControls().map(item => ({
			id: item.id,
			label: item.label,
			value: item.value,
			description: item.description,
		})),
	);
	const detailOptions = createMemo<readonly SelectOption[]>(() =>
		detailItems().map(item => ({
			value: item.id,
			label: item.label,
			description: [item.value, item.description].filter((part): part is string => Boolean(part)).join(" · "),
		})),
	);
	const enumOptions = createMemo<readonly SelectOption[]>(() => {
		const activeEditor = editor();
		if (!activeEditor || activeEditor.schema.type !== "enum") return [];
		return activeEditor.schema.values.map(value => ({ value, label: value }));
	});
	const listSelector = createSelectController({
		options: listOptions,
		maxRows: () => Math.min(listOptions().length, 8),
		search: "overflow",
		onSelect(value) {
			for (const entry of entries()) {
				if (entryValue(entry) === value) {
					openDetail(entry);
					return;
				}
			}
		},
		onCancel: callbacks.onClose,
	});
	const detailSelector = createSelectController({
		options: detailOptions,
		maxRows: () => Math.min(detailOptions().length, 10),
		search: "overflow",
		onSelect(value) {
			activateDetail(value);
		},
		onCancel() {
			returnToList();
		},
	});
	const enumSelector = createSelectController({
		options: enumOptions,
		maxRows: () => Math.min(enumOptions().length, 8),
		search: "overflow",
		onSelect(value) {
			saveEditor(value);
		},
		onCancel() {
			closeEditor();
		},
	});
	const selected = createMemo<PluginListEntry | undefined>(() => {
		const value = listSelector.options()[listSelector.selectedIndex()]?.value;
		if (value === undefined) return undefined;
		for (const entry of entries()) {
			if (entryValue(entry) === value) return entry;
		}
		return undefined;
	});
	const detail = createMemo(() => screen() !== "list");
	let disposed = false;
	let refreshGeneration = 0;
	let detailGeneration = 0;

	const refresh = async (): Promise<void> => {
		const generation = ++refreshGeneration;
		const [npm, marketplace] = await Promise.allSettled([
			host.manager.list(),
			host.createMarketplaceManager().then(manager => manager.listInstalledPlugins()),
		]);
		if (disposed || generation !== refreshGeneration) return;
		const problems: string[] = [];
		const loaded: PluginListEntry[] = [];
		if (npm.status === "fulfilled") {
			for (const plugin of npm.value) loaded.push({ kind: "npm", plugin });
		} else {
			problems.push(`Failed to list npm plugins: ${messageFor(npm.reason)}`);
		}
		if (marketplace.status === "fulfilled") {
			for (const plugin of marketplace.value) loaded.push({ kind: "marketplace", plugin });
		} else {
			problems.push(`Failed to list marketplace plugins: ${messageFor(marketplace.reason)}`);
		}
		setEntries(loaded);
		listSelector.setQuery("");
		listSelector.selectIndex(0);
		setError(problems.length > 0 ? problems.join(" · ") : undefined);
	};

	const replaceNpm = (name: string, update: (plugin: InstalledPlugin) => InstalledPlugin): void => {
		if (disposed) return;
		setEntries(current =>
			current.map(entry => {
				if (entry.kind !== "npm" || entry.plugin.name !== name) return entry;
				return { kind: "npm", plugin: update(entry.plugin) };
			}),
		);
		setCurrentDetail(current =>
			current?.kind === "npm" && current.plugin.name === name
				? { ...current, plugin: update(current.plugin) }
				: current,
		);
	};

	const replaceMarketplace = (
		id: string,
		scope: "user" | "project",
		update: (plugin: InstalledPluginSummary) => InstalledPluginSummary,
	): void => {
		if (disposed) return;
		setEntries(current =>
			current.map(entry => {
				if (entry.kind !== "marketplace" || entry.plugin.id !== id || entry.plugin.scope !== scope) return entry;
				return { kind: "marketplace", plugin: update(entry.plugin) };
			}),
		);
		setCurrentDetail(current =>
			current?.kind === "marketplace" && current.plugin.id === id && current.plugin.scope === scope
				? { ...current, plugin: update(current.plugin) }
				: current,
		);
	};

	const updateDetailSettings = (pluginName: string, key: string, value: unknown): void => {
		if (disposed) return;
		setCurrentDetail(current => {
			if (current?.kind === "npm" && current.plugin.name === pluginName)
				return { ...current, settings: { ...current.settings, [key]: value } };
			if (current?.kind === "marketplace" && current.runtimePlugin?.name === pluginName)
				return { ...current, settings: { ...current.settings, [key]: value } };
			return current;
		});
	};

	const notifyPluginChange = async (plugin?: string, key?: string, value?: unknown): Promise<void> => {
		if (plugin !== undefined && key !== undefined) await callbacks.onConfigChange?.(plugin, key, value);
		await callbacks.onPluginsChanged?.();
	};

	const write = async (operation: () => Promise<void>): Promise<void> => {
		if (disposed || busy()) return;
		setBusy(true);
		setError(undefined);
		try {
			await operation();
		} catch (reason) {
			if (!disposed) setError(messageFor(reason));
		} finally {
			if (!disposed) setBusy(false);
		}
	};

	const loadNpmSettings = async (plugin: InstalledPlugin, generation: number): Promise<void> => {
		if (!hasManifestSettings(plugin)) return;
		try {
			const settings = await host.manager.getPluginSettings(plugin.name);
			if (disposed || generation !== detailGeneration) return;
			setCurrentDetail(current =>
				current?.kind === "npm" && current.plugin.name === plugin.name
					? { ...current, settings, loading: false, settingsLoaded: true }
					: current,
			);
		} catch (reason) {
			if (disposed || generation !== detailGeneration) return;
			setCurrentDetail(current =>
				current?.kind === "npm" && current.plugin.name === plugin.name ? { ...current, loading: false } : current,
			);
			setError(`Failed to load plugin settings: ${messageFor(reason)}`);
		}
	};

	const loadMarketplaceSettings = async (plugin: InstalledPluginSummary, generation: number): Promise<void> => {
		const entry = plugin.entries[0];
		if (!entry) return;
		const name = host.parsePluginId(plugin.id)?.name ?? plugin.id;
		try {
			const runtimePlugin = await host.manager.getPlugin(name, { path: entry.installPath });
			if (!runtimePlugin) {
				if (!disposed && generation === detailGeneration) {
					setCurrentDetail(current =>
						current?.kind === "marketplace" &&
						current.plugin.id === plugin.id &&
						current.plugin.scope === plugin.scope
							? { ...current, loading: false }
							: current,
					);
				}
				return;
			}
			const settings = hasManifestSettings(runtimePlugin)
				? await host.manager.getPluginSettings(runtimePlugin.name)
				: {};
			if (disposed || generation !== detailGeneration) return;
			setCurrentDetail(current =>
				current?.kind === "marketplace" && current.plugin.id === plugin.id && current.plugin.scope === plugin.scope
					? { ...current, runtimePlugin, settings, loading: false, settingsLoaded: true }
					: current,
			);
		} catch (reason) {
			if (disposed || generation !== detailGeneration) return;
			setCurrentDetail(current =>
				current?.kind === "marketplace" && current.plugin.id === plugin.id && current.plugin.scope === plugin.scope
					? { ...current, loading: false }
					: current,
			);
			setError(`Failed to load marketplace plugin settings: ${messageFor(reason)}`);
		}
	};

	const openDetail = (entry: PluginListEntry): void => {
		const generation = ++detailGeneration;
		setError(undefined);
		setEditor(undefined);
		detailSelector.setQuery("");
		detailSelector.selectIndex(0);
		if (entry.kind === "npm") {
			const hasSettings = hasManifestSettings(entry.plugin);
			setScreen("npm-detail");
			setCurrentDetail({
				kind: "npm",
				plugin: entry.plugin,
				settings: {},
				loading: hasSettings,
				settingsLoaded: !hasSettings,
			});
			if (hasSettings) void loadNpmSettings(entry.plugin, generation);
			return;
		}
		setScreen("marketplace-detail");
		setCurrentDetail({
			kind: "marketplace",
			plugin: entry.plugin,
			settings: {},
			loading: entry.plugin.entries.length > 0,
			settingsLoaded: false,
		});
		if (entry.plugin.entries.length > 0) void loadMarketplaceSettings(entry.plugin, generation);
	};

	const closeEditor = (): void => {
		enumSelector.setQuery("");
		setEditor(undefined);
		setError(undefined);
		const current = currentDetail();
		setScreen(current?.kind === "marketplace" ? "marketplace-detail" : "npm-detail");
	};

	const returnToList = (): void => {
		detailGeneration++;
		setEditor(undefined);
		setCurrentDetail(undefined);
		detailSelector.setQuery("");
		detailSelector.selectIndex(0);
		setScreen("list");
		void refresh();
	};

	const toggleEnabled = (current: PluginDetailState): void => {
		if (current.kind === "npm") {
			const enabled = !current.plugin.enabled;
			void write(async () => {
				await host.manager.setEnabled(current.plugin.name, enabled);
				await notifyPluginChange();
				replaceNpm(current.plugin.name, plugin => ({ ...plugin, enabled }));
			});
			return;
		}
		const enabled = !entryEnabled({ kind: "marketplace", plugin: current.plugin });
		void write(async () => {
			const marketplace = await host.createMarketplaceManager();
			await marketplace.setPluginEnabled(current.plugin.id, enabled, current.plugin.scope);
			await notifyPluginChange();
			replaceMarketplace(current.plugin.id, current.plugin.scope, plugin => ({
				...plugin,
				entries: plugin.entries.map(entry => ({ ...entry, enabled })),
			}));
		});
	};

	const toggleFeature = (current: NpmDetailState, feature: string): void => {
		void write(async () => {
			const stored = await host.manager.getEnabledFeatures(current.plugin.name);
			const features = stored === null ? effectiveFeatures(current.plugin) : new Set(stored);
			if (features.has(feature)) features.delete(feature);
			else features.add(feature);
			const next = [...features];
			await host.manager.setEnabledFeatures(current.plugin.name, next);
			await notifyPluginChange();
			replaceNpm(current.plugin.name, plugin => ({ ...plugin, enabledFeatures: next }));
		});
	};

	const saveSetting = (detailState: PluginDetailState, key: string, value: unknown): void => {
		const pluginName = detailState.kind === "npm" ? detailState.plugin.name : detailState.runtimePlugin?.name;
		if (!pluginName) return;
		void write(async () => {
			await host.manager.setPluginSetting(pluginName, key, value);
			await notifyPluginChange(pluginName, key, value);
			updateDetailSettings(pluginName, key, value);
			setEditor(undefined);
			setScreen(detailState.kind === "marketplace" ? "marketplace-detail" : "npm-detail");
		});
	};

	const beginEditor = (detailState: PluginDetailState, item: ConfigEditorItem): void => {
		const pluginName = detailState.kind === "npm" ? detailState.plugin.name : detailState.runtimePlugin?.name;
		if (!pluginName) return;
		const current = detailState.settings[item.key] ?? item.schema.default;
		const values = item.schema.type === "enum" ? item.schema.values : [];
		const selected =
			item.schema.type === "enum" ? Math.max(0, values.indexOf(String(current ?? item.schema.default ?? ""))) : 0;
		setError(undefined);
		setEditor({
			pluginName,
			key: item.key,
			schema: item.schema,
			draft: item.schema.secret ? "" : current === undefined || current === null ? "" : String(current),
		});
		if (item.schema.type === "enum") {
			enumSelector.setQuery("");
			enumSelector.selectIndex(selected);
		}
		setScreen(item.schema.type === "enum" ? "config-enum" : "config-input");
	};

	const activateDetail = (value?: string): void => {
		const current = currentDetail();
		if (!current) return;
		const selectedValue = value ?? detailSelector.options()[detailSelector.selectedIndex()]?.value;
		if (selectedValue === undefined) return;
		let item: DetailItem | undefined;
		for (const candidate of detailControls()) {
			if (candidate.id === selectedValue) {
				item = candidate;
				break;
			}
		}
		if (!item) return;
		if (item.kind === "enabled") return toggleEnabled(current);
		if (item.kind === "feature" && current.kind === "npm") return toggleFeature(current, item.feature);
		if (item.kind === "config-toggle") return saveSetting(current, item.key, item.value !== "true");
		if (item.kind === "config-editor") beginEditor(current, item);
	};

	const saveEditor = (selectedValue?: string): void => {
		const activeEditor = editor();
		const current = currentDetail();
		if (!activeEditor || !current) return;
		if (activeEditor.schema.type === "enum") {
			const value = selectedValue ?? enumSelector.options()[enumSelector.selectedIndex()]?.value;
			if (value === undefined) return;
			saveSetting(current, activeEditor.key, value);
			return;
		}
		if (activeEditor.draft.length === 0) {
			closeEditor();
			return;
		}
		saveSetting(
			current,
			activeEditor.key,
			activeEditor.schema.type === "number" ? Number(activeEditor.draft) : activeEditor.draft,
		);
	};

	const handleKey = (event: HostKeyEvent): void => {
		if (disposed) return;
		if (screen() === "config-input") {
			if (matchesSelectCancel(event.data)) closeEditor();
			else if (matchesKey(event.data, "enter") || matchesKey(event.data, "return") || event.data === "\n")
				saveEditor();
			else if (matchesKey(event.data, "backspace")) {
				setEditor(current =>
					current ? { ...current, draft: Array.from(current.draft).slice(0, -1).join("") } : current,
				);
			} else {
				const text = extractPrintableText(event.data);
				if (text) setEditor(current => (current ? { ...current, draft: current.draft + text } : current));
			}
			event.preventDefault();
			return;
		}
		if (screen() === "config-enum") {
			enumSelector.handleKey(event);
			return;
		}
		if (screen() === "list") {
			listSelector.handleKey(event);
			return;
		}
		if (matchesKey(event.data, "space")) {
			activateDetail();
			event.preventDefault();
			return;
		}
		detailSelector.handleKey(event);
	};

	void refresh();

	return {
		entries,
		selectedIndex: listSelector.selectedIndex,
		selected,
		visibleListOptions: listSelector.options,
		listHoveredIndex: listSelector.hoveredIndex,
		listOffset: listSelector.offset,
		listQuery: listSelector.query,
		listSearchEnabled: listSelector.searchEnabled,
		detail,
		screen,
		currentDetail,
		detailIndex: detailSelector.selectedIndex,
		visibleDetailOptions: detailSelector.options,
		detailOffset: detailSelector.offset,
		detailQuery: detailSelector.query,
		detailSearchEnabled: detailSelector.searchEnabled,
		detailItems,
		editor,
		editorIndex: enumSelector.selectedIndex,
		visibleEditorOptions: enumSelector.options,
		editorOffset: enumSelector.offset,
		editorQuery: enumSelector.query,
		editorSearchEnabled: enumSelector.searchEnabled,
		busy,
		error,
		handleInput(data) {
			handleKey(new HostKeyEvent(data));
		},
		handleKey,
		handleListMouse(event) {
			listSelector.handleMouse(event, event.localRow);
		},
		handleDetailMouse(event) {
			detailSelector.handleMouse(event, event.localRow);
		},
		handleEditorMouse(event) {
			enumSelector.handleMouse(event, event.localRow);
		},
		refresh,
		close: callbacks.onClose,
		dispose(): void {
			disposed = true;
			detailGeneration++;
			refreshGeneration++;
		},
	};
}

export interface PluginSettingsViewProps {
	readonly controller: PluginSettingsController;
}

function ConfigEditorView(props: {
	readonly editor: ConfigEditorState;
	readonly options: readonly SelectOption[];
	readonly selectedIndex: number;
	readonly offset: number;
	readonly searchQuery: string;
	readonly searchEnabled: boolean;
	readonly onMouse: (event: HostMouseEvent) => void;
	readonly busy: boolean;
	readonly error?: string;
}): JSX.Element {
	const schema = props.editor.schema;
	if (schema.type === "enum") {
		const selectedIndex = Math.max(0, Math.min(Math.max(0, schema.values.length - 1), props.selectedIndex));
		const maxRows = Math.min(schema.values.length, 8);
		return (
			<frame title={props.editor.key} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
				<stack>
					{schema.description ? (
						<text color="muted" wrap="word">
							{schema.description}
						</text>
					) : null}
					<select
						options={props.options}
						selectedIndex={selectedIndex}
						offset={props.offset}
						maxRows={maxRows}
						emptyText="No values available"
						onMouse={props.onMouse}
					/>
					{props.searchEnabled ? (
						<text color="dim">{props.searchQuery ? `  Search: ${props.searchQuery}` : "  Type to search"}</text>
					) : null}
					{props.busy ? <text color="dim">Saving…</text> : null}
					{props.error ? (
						<text color="error" wrap="word">
							{props.error}
						</text>
					) : null}
					<text color="dim">Enter to select · Esc to cancel</text>
				</stack>
			</frame>
		);
	}
	return (
		<frame title={props.editor.key} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<stack>
				{schema.description ? (
					<>
						<text color="muted" wrap="word">
							{schema.description}
						</text>
						<br />
					</>
				) : null}
				<text color="dim">{editorTypeHint(schema)}</text>
				<input value={props.editor.draft} prompt="  " mask={schema.secret} onChange={() => {}} />
				{props.busy ? <text color="dim">Saving…</text> : null}
				{props.error ? (
					<text color="error" wrap="word">
						{props.error}
					</text>
				) : null}
				<text color="dim">Enter to save · Esc to cancel</text>
			</stack>
		</frame>
	);
}

export function PluginSettingsView(props: PluginSettingsViewProps): JSX.Element {
	const controller = props.controller;
	const handleKey = (event: HostKeyEvent): void => {
		controller.handleKey(event);
	};
	const body = (): JSX.Element => {
		const activeEditor = controller.editor();
		if (activeEditor) {
			return (
				<ConfigEditorView
					editor={activeEditor}
					options={controller.visibleEditorOptions()}
					selectedIndex={controller.editorIndex()}
					offset={controller.editorOffset()}
					searchQuery={controller.editorQuery()}
					searchEnabled={controller.editorSearchEnabled()}
					onMouse={controller.handleEditorMouse}
					busy={controller.busy()}
					error={controller.error()}
				/>
			);
		}
		if (controller.screen() === "list") {
			return (
				<PluginListView
					entries={controller.entries()}
					options={controller.visibleListOptions()}
					selectedIndex={controller.selectedIndex()}
					hoveredIndex={controller.listHoveredIndex()}
					offset={controller.listOffset()}
					searchQuery={controller.listQuery()}
					searchEnabled={controller.listSearchEnabled()}
					error={controller.error()}
					onMouse={controller.handleListMouse}
				/>
			);
		}
		const current = controller.currentDetail();
		if (!current) {
			return (
				<PluginListView
					entries={controller.entries()}
					options={controller.visibleListOptions()}
					selectedIndex={controller.selectedIndex()}
					hoveredIndex={controller.listHoveredIndex()}
					offset={controller.listOffset()}
					searchQuery={controller.listQuery()}
					searchEnabled={controller.listSearchEnabled()}
					error={controller.error()}
					onMouse={controller.handleListMouse}
				/>
			);
		}
		const items = controller.detailItems();
		if (current.kind === "npm") {
			return (
				<PluginDetailView
					title={current.plugin.name}
					enabled={current.plugin.enabled}
					description={current.plugin.manifest.description}
					items={items}
					options={controller.visibleDetailOptions()}
					selectedIndex={controller.detailIndex()}
					offset={controller.detailOffset()}
					searchQuery={controller.detailQuery()}
					searchEnabled={controller.detailSearchEnabled()}
					loading={current.loading}
					onMouse={controller.handleDetailMouse}
					busy={controller.busy()}
					error={controller.error()}
				/>
			);
		}
		return (
			<MarketplacePluginDetailView
				title={current.plugin.id}
				enabled={entryEnabled({ kind: "marketplace", plugin: current.plugin })}
				scope={current.plugin.scope}
				version={current.plugin.entries[0]?.version}
				description={[
					`[${current.plugin.scope}]`,
					current.plugin.shadowedBy ? `○ shadowed by ${current.plugin.shadowedBy}` : "",
				]
					.filter(Boolean)
					.join(" ")}
				items={items}
				options={controller.visibleDetailOptions()}
				selectedIndex={controller.detailIndex()}
				offset={controller.detailOffset()}
				searchQuery={controller.detailQuery()}
				searchEnabled={controller.detailSearchEnabled()}
				summary={marketplaceSummary(current.plugin)}
				loading={current.loading}
				onMouse={controller.handleDetailMouse}
				busy={controller.busy()}
				error={controller.error()}
			/>
		);
	};
	return (
		<box tabIndex={0} onKey={handleKey}>
			{body()}
		</box>
	);
}

export interface PluginSettingsOverlayProps {
	readonly host: PluginSettingsHost;
	readonly callbacks: PluginSettingsCallbacks;
}

export interface PluginSettingsHandle extends OverlayDisposer, PluginSettingsController {}

export function openPluginSettingsOverlay(tui: TUI, props: PluginSettingsOverlayProps): PluginSettingsHandle {
	const controller = createPluginSettingsController(props.host, props.callbacks);
	const disposer = mountOverlay(tui, () => (
		<Portal to="overlay" fullscreen anchor="bottom-center" mouseTracking>
			<PluginSettingsView controller={controller} />
		</Portal>
	));
	const dispose = (): void => {
		controller.dispose();
		disposer.dispose();
	};
	return Object.assign(dispose, controller, { hide: dispose, dispose });
}
