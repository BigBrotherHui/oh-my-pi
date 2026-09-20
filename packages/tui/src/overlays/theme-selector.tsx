import { type JSX } from "../reactive";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { SelectOption } from "../host/elements/select";
import type { SizeValue, TUI } from "../tui";
import { SelectOverlay } from "./select-overlay";

export interface ThemeSelectorProps {
	readonly currentTheme: string;
	readonly themes: readonly string[];
	readonly onSelect: (themeName: string) => void;
	readonly onCancel: () => void;
	readonly onPreview: (themeName: string) => void;
	readonly width?: SizeValue;
}

/** Theme-specific projection of the shared selectable overlay. */
export function ThemeSelectorView(props: ThemeSelectorProps): JSX.Element {
	const options: readonly SelectOption[] = props.themes.map(name => ({
		value: name,
		label: name,
		description: name === props.currentTheme ? "(current)" : undefined,
	}));
	return (
		<SelectOverlay
			title="Theme"
			options={options}
			selectedIndex={Math.max(0, props.themes.indexOf(props.currentTheme))}
			maxRows={10}
			onSelect={props.onSelect}
			onCancel={props.onCancel}
			onChange={props.onPreview}
		/>
	);
}

export function ThemeSelector(props: ThemeSelectorProps): JSX.Element {
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"} mouseTracking>
			<ThemeSelectorView {...props} />
		</Portal>
	);
}

export function openThemeSelector(
	tui: TUI,
	currentTheme: string,
	themes: readonly string[],
	onSelect: (themeName: string) => void,
	onCancel: () => void,
	onPreview: (themeName: string) => void,
	options?: { width?: SizeValue },
): OverlayDisposer {
	return mountOverlay(tui, () => (
		<ThemeSelector
			currentTheme={currentTheme}
			themes={themes}
			onSelect={onSelect}
			onCancel={onCancel}
			onPreview={onPreview}
			width={options?.width}
		/>
	));
}
