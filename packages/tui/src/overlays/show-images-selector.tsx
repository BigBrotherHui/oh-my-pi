import { type JSX } from "../reactive";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { SelectOption } from "../host/elements/select";
import type { SizeValue, TUI } from "../tui";
import { SelectOverlay } from "./select-overlay";

const SHOW_IMAGES_OPTIONS: readonly SelectOption[] = [
	{ value: "yes", label: "Yes", description: "Show images inline in terminal" },
	{ value: "no", label: "No", description: "Show text placeholder instead" },
];

export interface ShowImagesSelectorProps {
	readonly currentValue: boolean;
	readonly onSelect: (show: boolean) => void;
	readonly onCancel: () => void;
	readonly width?: SizeValue;
}

export function ShowImagesSelector(props: ShowImagesSelectorProps): JSX.Element {
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<SelectOverlay
				title="Show Images"
				options={SHOW_IMAGES_OPTIONS}
				selectedIndex={props.currentValue ? 0 : 1}
				onSelect={value => props.onSelect(value === "yes")}
				onCancel={props.onCancel}
			/>
		</Portal>
	);
}

export function openShowImagesSelector(
	tui: TUI,
	currentValue: boolean,
	onSelect: (show: boolean) => void,
	onCancel: () => void,
	options?: { width?: SizeValue },
): OverlayDisposer {
	return mountOverlay(tui, () => (
		<ShowImagesSelector currentValue={currentValue} onSelect={onSelect} onCancel={onCancel} width={options?.width} />
	));
}
