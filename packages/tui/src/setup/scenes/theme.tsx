import {
	enableAutoTheme,
	getAvailableThemes,
	getCurrentThemeName,
	isLightTheme,
	previewTheme,
	setColorBlindMode,
	setSymbolPreset,
	type SymbolPreset,
} from "../../theme/theme";
import { createSignal, onCleanup, onMount, Show, useFocus, useTheme, type Accessor, type JSX } from "../../reactive";
import { createSelectController } from "../../overlays/select-overlay";
import { WizardStepView } from "../../components/wizard-step";
import { cellWidth } from "../../core/richtext";
import type { SelectOption } from "../../host/elements/select";
import type { SetupScene, SetupSceneResult } from "./types";

type ThemeMode = "curated" | "all";
type ThemeChoice = SelectOption;

const CURATED_CHOICES: readonly ThemeChoice[] = [
	{ value: "auto", label: "Match terminal", description: "Titanium in dark terminals, Light in light terminals" },
	{ value: "theme:titanium", label: "Titanium", description: "Default dark theme" },
	{ value: "theme:light", label: "Light", description: "Default light theme" },
	{ value: "colorblind", label: "Colorblind colors", description: "Adjust red/green contrast" },
	{ value: "ansi", label: "ANSI-safe", description: "ASCII glyphs with the dark terminal theme" },
	{ value: "browse", label: "Browse all…", description: "Show every built-in and custom theme" },
];

const PREVIEW_ROWS = 10;
const SELECT_STATUS_ROWS = 1;
const MIN_CONTENT_ROWS = CURATED_CHOICES.length + SELECT_STATUS_ROWS;
/** Historical step needs 2 intro rows, 2 gaps, the full preview, and 7 useful list rows. */
const MIN_ROWS_WITH_PREVIEW = 2 + 2 + PREVIEW_ROWS + MIN_CONTENT_ROWS;

function spaces(count: number): string {
	return " ".repeat(Math.max(0, count));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ThemeStatusLinePreview(props: { readonly width: number }): JSX.Element {
	const theme = useTheme();
	const active = () => theme.theme();
	const previewWidth = () => Math.max(24, Math.min(props.width, 88));
	const left = () => {
		const palette = active();
		return `${palette.icon.model} sonnet ${palette.sep.pipe} ~/project ${palette.sep.pipe} ${palette.icon.git} main +2`;
	};
	const right = () => {
		const palette = active();
		return `${palette.icon.context} 42% ${palette.sep.pipe} ${palette.icon.cost} 0.18`;
	};
	const gap = () => Math.max(1, previewWidth() - 2 - cellWidth(left()) - cellWidth(right()) - 2);
	return (
		<text width={previewWidth()} pad wrap="clip" overflow="clip" background="statusLineBg">
			{" "}
			<span color="statusLineModel">{active().icon.model} sonnet</span>
			<span color="statusLineSep">{` ${active().sep.pipe} `}</span>
			<span color="statusLinePath">~/project</span>
			<span color="statusLineSep">{` ${active().sep.pipe} `}</span>
			<span color="statusLineGitDirty">{active().icon.git} main +2</span>
			{spaces(gap())}
			<span color="statusLineContext">{active().icon.context} 42%</span>
			<span color="statusLineSep">{` ${active().sep.pipe} `}</span>
			<span color="statusLineCost">{active().icon.cost} 0.18</span>{" "}
		</text>
	);
}

function ThemeEditorPreview(props: { readonly width: number }): JSX.Element {
	const theme = useTheme();
	const width = Math.max(24, Math.min(props.width, 88));
	const box = () => theme.theme().boxRound;
	const innerWidth = Math.max(1, width - 2);
	const prompt = "Ask anything, edit files, run tools";
	const hint = "enter send · shift+enter newline · / commands";
	const promptPadding = Math.max(0, innerWidth - cellWidth(prompt) - 3);
	const hintPadding = Math.max(0, innerWidth - cellWidth(hint));
	return (
		<stack>
			<text width={width} wrap="clip" overflow="clip" color="borderAccent">
				{box().topLeft}
				{box().horizontal.repeat(innerWidth)}
				{box().topRight}
			</text>
			<text width={width} wrap="clip" overflow="clip">
				<span color="borderAccent">{box().vertical}</span>
				<span color="accent">&gt;</span> <span color="text">{prompt}</span>
				<span inverse> </span>
				{spaces(promptPadding)}
				<span color="borderAccent">{box().vertical}</span>
			</text>
			<text width={width} wrap="clip" overflow="clip">
				<span color="borderMuted">{box().vertical}</span>
				<span color="dim">{hint}</span>
				{spaces(hintPadding)}
				<span color="borderMuted">{box().vertical}</span>
			</text>
			<text width={width} wrap="clip" overflow="clip" color="borderMuted">
				{box().bottomLeft}
				{box().horizontal.repeat(innerWidth)}
				{box().bottomRight}
			</text>
		</stack>
	);
}

function ThemePreviewView(): JSX.Element {
	const theme = useTheme();
	return (
		<sized
			paint={width => (
				<stack>
					<text bold>Preview</text>
					<text wrap="clip" overflow="clip">
						<span color="success">{theme.theme().status.success} success</span>
						{"  "}
						<span color="warning">{theme.theme().status.warning} warning</span>
						{"  "}
						<span color="error">{theme.theme().status.error} error</span>
						{"  "}
						<span color="accent">accent</span>
					</text>
					<text> </text>
					<text color="muted">Status line</text>
					<ThemeStatusLinePreview width={width} />
					<text color="muted">Editor</text>
					<ThemeEditorPreview width={width} />
				</stack>
			)}
		/>
	);
}

interface ThemeChoiceListProps {
	readonly mode: ThemeMode;
	readonly choices: Accessor<readonly ThemeChoice[]>;
	readonly initialIndex: number;
	readonly loading: Accessor<boolean>;
	readonly message: Accessor<string | undefined>;
	readonly availableRows?: Accessor<number>;
	preview(value: string): void;
	select(value: string): void;
	cancel(): void;
}

function ThemeChoiceList(props: ThemeChoiceListProps): JSX.Element {
	const focus = useFocus();
	const [maxRows, setMaxRows] = createSignal(10);
	const previewFits = (): boolean =>
		props.availableRows === undefined || props.availableRows() >= MIN_ROWS_WITH_PREVIEW;
	let directSelection = false;
	const controller = createSelectController({
		options: props.choices,
		maxRows,
		selectedIndex: props.initialIndex,
		scrollPolicy: "center",
		onChange(value): void {
			if (props.mode === "curated" || !directSelection) props.preview(value);
		},
		onSelect: props.select,
		onCancel: props.cancel,
		onInput(event): void {
			const index = event.data >= "1" && event.data <= "9" ? Number(event.data) - 1 : -1;
			if (index < 0) return;
			directSelection = true;
			controller.selectIndex(index);
			directSelection = false;
			event.preventDefault();
			event.stopPropagation();
		},
	});
	onMount(() => focus.focus());
	const fitContent = (budget: number | undefined): void => {
		const visibleRows = budget === undefined ? 10 : Math.min(10, Math.max(1, budget - SELECT_STATUS_ROWS));
		if (maxRows() !== visibleRows) setMaxRows(visibleRows);
	};
	return (
		<WizardStepView
			intro={
				<stack>
					<text color="muted">Theme changes preview live. Nothing is saved until you press Enter.</text>
					<text color="dim">
						{props.mode === "all"
							? "Browsing all themes · Esc returns to curated choices"
							: "Esc skips this step"}
					</text>
				</stack>
			}
			preview={previewFits() ? { children: <ThemePreviewView />, optional: true } : undefined}
			content={
				<Show when={!props.loading()} fallback={<text color="dim">Loading themes…</text>}>
					<select
						options={controller.options()}
						selectedIndex={controller.selectedIndex()}
						hoveredIndex={controller.hoveredIndex()}
						offset={controller.offset()}
						maxRows={controller.maxRows()}
						emptyText={controller.query().trim() ? "No matching items" : "No items"}
						trackColor="dim"
						thumbColor="accent"
						hoverBackground="selectedBg"
						hoverFill={false}
					/>
					<Show when={controller.searchEnabled()}>
						<text color="dim" wrap="clip" overflow="clip">
							{controller.query() ? `  Search: ${controller.query()}` : "  Type to search"}
						</text>
					</Show>
				</Show>
			}
			status={
				<Show when={props.message()}>
					<text color="error" wrap="word">
						{props.message()}
					</text>
				</Show>
			}
			minContentLines={MIN_CONTENT_ROWS}
			availableRows={props.availableRows}
			fitContent={fitContent}
			onKey={controller.handleKey}
			onMouse={controller.handleMouse}
			tabIndex={focus.tabIndex}
		/>
	);
}

/** Narrow scene contract: all other onboarding dependencies remain shell-owned. */
export interface ThemeSceneContext {
	readonly host: {
		readonly symbolPreset: SymbolPreset;
		readonly colorBlindMode: boolean;
		saveSymbolPreset(preset: SymbolPreset): void;
		saveColorBlindMode(enabled: boolean): void;
		saveTheme(mode: "dark" | "light", name: string): void;
	};
	/** Exact historical body budget, excluding the wizard's footer. */
	availableRows?(): number;
	complete(result: SetupSceneResult): void;
}

export function ThemeSceneView(context: ThemeSceneContext): JSX.Element {
	const [mode, setMode] = createSignal<ThemeMode>("curated");
	const [allChoices, setAllChoices] = createSignal<readonly ThemeChoice[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [message, setMessage] = createSignal<string>();
	const originalTheme = getCurrentThemeName();
	const originalPreset: SymbolPreset = context.host.symbolPreset;
	const originalColorBlind = context.host.colorBlindMode;
	let previewRequest = 0;
	let saving = false;
	let completed = false;
	let disposed = false;

	onCleanup(() => {
		disposed = true;
	});
	const finish = (result: SetupSceneResult): void => {
		if (completed) return;
		completed = true;
		context.complete(result);
	};
	const applyPresentation = async (preset: SymbolPreset, colorBlind: boolean): Promise<void> => {
		await setSymbolPreset(preset);
		await setColorBlindMode(colorBlind);
	};
	const preview = async (value: string): Promise<void> => {
		const request = ++previewRequest;
		setMessage(undefined);
		if (value === "browse") return;
		try {
			let result: { readonly success: boolean; readonly error?: string } = { success: true };
			if (value === "auto") {
				await applyPresentation(originalPreset, originalColorBlind);
				enableAutoTheme({ ephemeral: true });
			} else if (value === "colorblind") {
				await applyPresentation(originalPreset, true);
			} else if (value === "ansi") {
				await applyPresentation("ascii", originalColorBlind);
				result = await previewTheme("dark-terminal");
			} else {
				const name = value.startsWith("theme:") ? value.slice("theme:".length) : undefined;
				if (name) {
					await applyPresentation(originalPreset, originalColorBlind);
					result = await previewTheme(name);
				}
			}
			if (request !== previewRequest || disposed || result.success) return;
			setMessage(result.error ?? "Theme preview failed");
		} catch (error) {
			if (request !== previewRequest || disposed) return;
			setMessage(messageOf(error));
		}
	};
	const browse = async (): Promise<void> => {
		if (loading()) return;
		setLoading(true);
		setMessage(undefined);
		try {
			const names = await getAvailableThemes();
			if (disposed) return;
			setAllChoices(
				names.map(name =>
					name === originalTheme
						? { value: `theme:${name}`, label: name, description: "current" }
						: { value: `theme:${name}`, label: name },
				),
			);
			setMode("all");
		} catch (error) {
			if (!disposed) setMessage(`Failed to load themes: ${messageOf(error)}`);
		} finally {
			if (!disposed) setLoading(false);
		}
	};
	const commit = async (value: string): Promise<void> => {
		if (value === "auto") {
			context.host.saveTheme("dark", "titanium");
			context.host.saveTheme("light", "light");
			await applyPresentation(originalPreset, originalColorBlind);
			enableAutoTheme();
			return;
		}
		if (value === "colorblind") {
			context.host.saveColorBlindMode(true);
			await applyPresentation(originalPreset, true);
			return;
		}
		if (value === "ansi") {
			context.host.saveSymbolPreset("ascii");
			context.host.saveTheme("dark", "dark-terminal");
			await applyPresentation("ascii", originalColorBlind);
			enableAutoTheme();
			return;
		}
		const name = value.startsWith("theme:") ? value.slice("theme:".length) : undefined;
		if (!name) return;
		await applyPresentation(originalPreset, originalColorBlind);
		if (isLightTheme(name)) context.host.saveTheme("light", name);
		else context.host.saveTheme("dark", name);
		const result = await previewTheme(name, { ephemeral: false });
		if (!result.success) throw new Error(result.error ?? "Theme preview failed");
	};
	const select = (value: string): void => {
		if (saving || completed) return;
		if (value === "browse") {
			void browse();
			return;
		}
		saving = true;
		void commit(value).then(
			() => finish("done"),
			error => {
				saving = false;
				if (!disposed) setMessage(messageOf(error));
			},
		);
	};
	const restorePreview = (): void => {
		void (async () => {
			await applyPresentation(originalPreset, originalColorBlind);
			if (originalTheme) await previewTheme(originalTheme);
		})();
	};
	const cancel = (): void => {
		if (mode() === "all") {
			setMode("curated");
			setMessage(undefined);
			return;
		}
		restorePreview();
		finish("skipped");
	};
	return (
		<Show when={mode()} keyed>
			{(activeMode: ThemeMode) => (
				<ThemeChoiceList
					mode={activeMode}
					choices={activeMode === "curated" ? () => CURATED_CHOICES : allChoices}
					initialIndex={
						activeMode === "curated"
							? originalTheme === "titanium"
								? 1
								: originalTheme === "light"
									? 2
									: 0
							: Math.max(
									0,
									allChoices().findIndex(choice => choice.value === `theme:${originalTheme ?? ""}`),
								)
					}
					loading={loading}
					message={message}
					availableRows={context.availableRows}
					preview={preview}
					select={select}
					cancel={cancel}
				/>
			)}
		</Show>
	);
}

/** Preview and persist the terminal color theme. */
export const themeSetupScene: SetupScene = {
	id: "theme",
	title: "Pick a theme",
	minVersion: 1,
	View: ThemeSceneView,
};
