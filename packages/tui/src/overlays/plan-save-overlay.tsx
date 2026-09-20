import { createSignal, type JSX } from "../reactive";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import { theme } from "../theme/theme";
import type { SizeValue, TUI } from "../tui";

export interface PlanSaveOverlayResult {
	path: string;
}

export interface PlanSaveOverlayViewProps {
	readonly value: string;
	readonly suggestedPath: string;
	readonly onChange: (value: string) => void;
	readonly onDone: (result: PlanSaveOverlayResult | undefined) => void;
}

export function PlanSaveOverlayView(props: PlanSaveOverlayViewProps): JSX.Element {
	return (
		<frame title="Save and quit" paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<stack>
				<row>
					<text width={6} color="dim" wrap="none" overflow="clip">
						Path:{" "}
					</text>
					<input
						grow={1}
						prompt=""
						value={props.value}
						placeholder={props.suggestedPath}
						placeholderStyle={theme.style("dim")}
						useTerminalCursor={false}
						tabIndex={0}
						onChange={props.onChange}
						onSubmit={value => props.onDone({ path: value.trim() || props.suggestedPath })}
						onEscape={() => props.onDone(undefined)}
					/>
				</row>
				<text color="dim" wrap="none" overflow="clip">
					Enter save and quit · Esc cancel
				</text>
			</stack>
		</frame>
	);
}

export interface PlanSaveOverlayProps {
	readonly suggestedPath: string;
	readonly onDone: (result: PlanSaveOverlayResult | undefined) => void;
	readonly width?: SizeValue;
}

export interface PlanSaveOverlayHandle extends OverlayDisposer {
	setSuggestedPath(path: string): void;
}

/** Solid overlay component mounted with Portal to overlay. */
export function PlanSaveOverlay(props: PlanSaveOverlayProps): JSX.Element {
	const [value, setValue] = createSignal("");

	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<PlanSaveOverlayView
				value={value()}
				suggestedPath={props.suggestedPath}
				onChange={setValue}
				onDone={props.onDone}
			/>
		</Portal>
	);
}

/** Open the plan save overlay on a TUI instance, returning a disposer handle. */
export function openPlanSaveOverlay(
	tui: TUI,
	suggestedPath: string,
	done: (result: PlanSaveOverlayResult | undefined) => void,
	options?: { width?: SizeValue },
): PlanSaveOverlayHandle {
	const [currentSuggestedPath, setCurrentSuggestedPath] = createSignal(suggestedPath);
	const overlay = mountOverlay(tui, () => (
		<PlanSaveOverlay suggestedPath={currentSuggestedPath()} width={options?.width} onDone={done} />
	));
	return Object.assign(overlay, {
		setSuggestedPath(path: string): void {
			setCurrentSuggestedPath(path);
		},
	});
}
