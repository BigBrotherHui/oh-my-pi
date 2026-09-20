import { type JSX } from "../reactive";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { SelectOption } from "../host/elements/select";
import type { SizeValue, TUI } from "../tui";
import { SelectOverlay } from "./select-overlay";

const QUEUE_MODE_OPTIONS: readonly SelectOption[] = [
	{
		value: "one-at-a-time",
		label: "one-at-a-time",
		description: "Process queued messages one by one (recommended)",
	},
	{ value: "all", label: "all", description: "Process all queued messages at once" },
];

export interface QueueModeSelectorProps {
	readonly currentMode: "all" | "one-at-a-time";
	readonly onSelect: (mode: "all" | "one-at-a-time") => void;
	readonly onCancel: () => void;
	readonly width?: SizeValue;
}

export function QueueModeSelector(props: QueueModeSelectorProps): JSX.Element {
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<SelectOverlay
				title="Queue Mode"
				options={QUEUE_MODE_OPTIONS}
				selectedIndex={props.currentMode === "one-at-a-time" ? 0 : 1}
				maxRows={2}
				onSelect={value => props.onSelect(value as "all" | "one-at-a-time")}
				onCancel={props.onCancel}
			/>
		</Portal>
	);
}

export function openQueueModeSelector(
	tui: TUI,
	currentMode: "all" | "one-at-a-time",
	onSelect: (mode: "all" | "one-at-a-time") => void,
	onCancel: () => void,
	options?: { width?: SizeValue },
): OverlayDisposer {
	return mountOverlay(tui, () => (
		<QueueModeSelector currentMode={currentMode} onSelect={onSelect} onCancel={onCancel} width={options?.width} />
	));
}
