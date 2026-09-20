import type { Model } from "@oh-my-pi/pi-ai";
import { addKeyAliases, canonicalKeyId } from "../keybindings";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent } from "../host/input";
import { parseKey, type KeyId } from "../keys";
import { createEffect, createMemo, createSignal, onCleanup, useViewport, type JSX } from "../reactive";
import type { ConfiguredThinkingLevel } from "../thinking";
import { useTheme } from "../theme/reactive";
import type { ThemeColor } from "../theme/schema";
import type { TUI } from "../tui";
import {
	buildSessionModelScope,
	ModelBrowserView,
	type ModelBrowserItem,
	type ModelBrowserRegistry,
	type ModelBrowserSource,
} from "./model-browser";
import type { ScopedModelItem } from "./model-hub";

export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}
export interface ModelPickerRegistry extends ModelBrowserRegistry {
	refresh(strategy: "offline"): Promise<void>;
}
export interface ModelPickerCallbacks {
	onPick(model: Model, selector: string, meta: { overContext: boolean }): void;
	onPickRole?(entry: ResolvedRoleModel): void;
	onPickTask?(model: Model, selector: string): void;
	onCancel(): void;
}
export interface ModelPickerOptions {
	currentContextTokens?: number;
	currentSelector?: string;
	quickRoles?: ReadonlyArray<ResolvedRoleModel>;
	quickRoleOrder?: ReadonlyArray<string>;
	currentQuickRole?: string;
	taskModeKeys?: readonly KeyId[];
	taskModeKeyLabel?: string;
	taskSelector?: string;
}
/** Fixed chrome rows: top border, status row, footer, bottom border. */
const CHROME_ROWS = 4;
/** Rows the browser renders around its list window (search + blank, blank + two detail rows). */
export const BROWSER_FRAME_ROWS = 5;
/** Minimum rows for the browser list window on short terminals. */
const MIN_VISIBLE = 5;
/** Fraction of the terminal height the floating overlay occupies. */
const HEIGHT_FRACTION = 0.4;
const QUICK_ROLE_COLOR_CANDIDATES: readonly ThemeColor[] = [
	"accent",
	"success",
	"warning",
	"error",
	"mdCode",
	"mdLink",
	"syntaxString",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxNumber",
	"syntaxOperator",
	"syntaxVariable",
];

function maxVisibleForTerminal(rows: number): number {
	return Math.max(MIN_VISIBLE, Math.floor(Math.max(16, rows) * HEIGHT_FRACTION) - CHROME_ROWS - BROWSER_FRAME_ROWS);
}

export interface ModelPickerViewProps {
	readonly settings: ModelBrowserSource;
	readonly registry: ModelPickerRegistry;
	readonly scopedModels: ReadonlyArray<ScopedModelItem>;
	readonly callbacks: ModelPickerCallbacks;
	readonly options?: ModelPickerOptions;
}

/** Bottom-anchored Alt+P picker: model browser, @ quick roles, and task-model target. */
export function ModelPickerView(props: ModelPickerViewProps): JSX.Element {
	const { theme } = useTheme();
	const viewport = useViewport();
	const [query, setQuery] = createSignal("");
	const [taskMode, setTaskMode] = createSignal(false);
	const [catalogVersion, setCatalogVersion] = createSignal(0);
	const [refreshError, setRefreshError] = createSignal<string>();
	const taskMatchKeys = new Set<string>();
	if (props.callbacks.onPickTask) {
		for (const key of props.options?.taskModeKeys ?? []) addKeyAliases(taskMatchKeys, key);
	}

	createEffect(() => {
		if (props.scopedModels.length !== 0) return;
		let disposed = false;
		void props.registry
			.refresh("offline")
			.catch(cause => {
				if (!disposed) setRefreshError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!disposed) setCatalogVersion(version => version + 1);
			});
		onCleanup(() => {
			disposed = true;
		});
	});

	const scope = createMemo(() => {
		catalogVersion();
		return buildSessionModelScope(
			props.settings,
			props.registry,
			props.scopedModels.map(entry => entry.model),
		);
	});
	const error = () => refreshError() ?? scope().error;
	const maxVisible = createMemo(() => maxVisibleForTerminal(viewport().rows));
	const browserWidth = createMemo(() => Math.max(1, viewport().columns - 4));
	const roleMode = () => query().startsWith("@") && !taskMode();
	const roles = () => props.options?.quickRoles ?? [];
	const quickRolePalette = createMemo<readonly ThemeColor[]>(() => {
		const palette: ThemeColor[] = [];
		const seen = new Set<string>();
		for (const color of QUICK_ROLE_COLOR_CANDIDATES) {
			const ansi = theme().getFgAnsi(color);
			if (seen.has(ansi)) continue;
			seen.add(ansi);
			palette.push(color);
		}
		return palette;
	});
	const roleItems = createMemo<ModelBrowserItem[]>(() => {
		const order = props.options?.quickRoleOrder ?? roles().map(entry => entry.role);
		const palette = quickRolePalette();
		return roles().map((entry, index) => {
			const orderIndex = order.indexOf(entry.role);
			const colorIndex = orderIndex >= 0 ? orderIndex : index;
			const selector = `@${entry.role}`;
			return {
				provider: "",
				id: selector,
				model: entry.model,
				selector,
				labelColor: palette[colorIndex % palette.length] ?? "accent",
			};
		});
	});
	const items = () => (roleMode() ? roleItems() : scope().items);
	const selector = () =>
		roleMode()
			? props.options?.currentQuickRole
				? `@${props.options.currentQuickRole}`
				: undefined
			: taskMode()
				? props.options?.taskSelector
				: props.options?.currentSelector;
	const choose = (item: ModelBrowserItem) => {
		if (roleMode()) {
			const role = roles().find(entry => `@${entry.role}` === item.selector);
			if (role) props.callbacks.onPickRole?.(role);
			return;
		}
		if (taskMode()) {
			props.callbacks.onPickTask?.(item.model, item.selector);
			return;
		}
		props.callbacks.onPick(item.model, item.selector, {
			overContext: (props.options?.currentContextTokens ?? 0) > (item.model.contextWindow ?? Infinity),
		});
	};
	const handleReservedKey = (event: HostKeyEvent): boolean => {
		const parsed = parseKey(event.data);
		if (parsed === undefined || !taskMatchKeys.has(canonicalKeyId(parsed))) return false;
		setTaskMode(previous => !previous);
		// Preserve the current retained input behavior: task models search the
		// normal catalog instead of retaining a role-only @ query.
		if (query().startsWith("@")) setQuery("");
		return true;
	};
	const title = () => (taskMode() ? "Switch Task Model" : "Switch Model");
	const status = () =>
		error() ??
		(taskMode()
			? "Task subagent switch — spawned task agents use this model (session-only)"
			: roleMode()
				? "Quick role switch — applies its model and thinking for this session"
				: "Session-only switch — role models stay unchanged");
	const footer = () => {
		const hint = taskMode()
			? "↑/↓ models · Enter use for Task subagents · type to search · Esc close"
			: roleMode()
				? "↑/↓ roles · Enter apply role model · type to search · Esc close"
				: "↑/↓ models · Enter use for this session · type to search · @ quick roles · Esc close";
		return !roleMode() && taskMatchKeys.size > 0
			? `${hint} · ${props.options?.taskModeKeyLabel ?? "alt+p"} ${taskMode() ? "session model" : "task model"}`
			: hint;
	};
	return (
		<box tabIndex={0}>
			<frame
				title={title()}
				paddingX={1}
				paddingY={0}
				borderPolicy="always"
				borderColor={taskMode() ? "error" : undefined}
				fitContent
				renderEmpty
			>
				<text color={error() ? "error" : taskMode() ? "error" : "muted"} wrap="clip">
					{" "}
					{status()}
				</text>
				<ModelBrowserView
					items={items()}
					roles={scope().roles}
					mruOrder={scope().mruOrder}
					providerOrder={props.settings.modelProviderOrder}
					perf={props.settings.modelPerf}
					roleInfo={props.settings.getRoleInfo}
					preserveQueryOrder={roleMode()}
					query={query()}
					onQueryChange={setQuery}
					selectedSelector={selector()}
					showProvider={!roleMode()}
					currentContextTokens={props.options?.currentContextTokens}
					markOverContext={!taskMode() && !roleMode()}
					maxVisible={maxVisible()}
					width={browserWidth()}
					emptyText={roleMode() ? "No quick roles in the Ctrl+P cycle" : error()}
					onKey={handleReservedKey}
					onSelect={choose}
					onCancel={props.callbacks.onCancel}
				/>
				<text color="dim" wrap="clip">
					{footer()}
				</text>
			</frame>
		</box>
	);
}

export function openModelPickerOverlay(
	tui: TUI,
	settings: ModelBrowserSource,
	registry: ModelPickerRegistry,
	scopedModels: ReadonlyArray<ScopedModelItem>,
	callbacks: ModelPickerCallbacks,
	options?: ModelPickerOptions,
): OverlayDisposer {
	return mountOverlay(tui, () => (
		<Portal to="overlay" anchor="bottom-center" width="100%" maxHeight="100%" margin={0}>
			<ModelPickerView
				settings={settings}
				registry={registry}
				scopedModels={scopedModels}
				callbacks={callbacks}
				options={options}
			/>
		</Portal>
	));
}
