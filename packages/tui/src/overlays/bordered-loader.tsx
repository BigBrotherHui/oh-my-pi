import { useClock, useTheme, type JSX } from "../reactive";
import type { Color } from "../core/style";
import { matchesKey } from "../keys";
import { matchesSelectCancel } from "../keybinding-matchers";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent } from "../host/input";
import type { SizeValue, TUI } from "../tui";

const LOADER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_ADVANCE_MS = 80;

/** Message and cancellation action for a root-owned loading indicator. */
export interface BorderedLoaderViewProps {
	readonly message: string;
	readonly onAbort?: () => void;
}

function isCancelKey(data: string): boolean {
	return matchesSelectCancel(data) || matchesKey(data, "escape") || matchesKey(data, "esc");
}

function LoaderSpinner(props: { readonly color: Color }): JSX.Element {
	const now = useClock("spinner");
	const startedAt = now();
	const frame = () => {
		const elapsed = Math.max(0, now() - startedAt);
		return LOADER_FRAMES[Math.floor(elapsed / SPINNER_ADVANCE_MS) % LOADER_FRAMES.length] ?? "⠋";
	};
	return <span color={props.color}>{frame()}</span>;
}

/** Root-owned loading view with the historical bordered layout and Escape action. */
export function BorderedLoaderView(props: BorderedLoaderViewProps): JSX.Element {
	const { theme } = useTheme();
	const handleKey = (event: HostKeyEvent): void => {
		if (!isCancelKey(event.data)) return;
		event.preventDefault();
		event.stopPropagation();
		props.onAbort?.();
	};
	return (
		<box onKey={handleKey} tabIndex={0}>
			<stack>
				<hr char={theme().boxRound.horizontal} ruleColor={theme().fgColor("border")} />
				<br />
				<box padding={{ left: 1, right: 1 }}>
					<text wrap="word">
						<LoaderSpinner color={theme().fgColor("accent")} />{" "}
						<span color={theme().fgColor("muted")}>{props.message}</span>
					</text>
				</box>
				<br />
				<box padding={{ left: 1, right: 1 }}>
					<text color={theme().fgColor("muted")} wrap="word">
						esc cancel
					</text>
				</box>
				<hr char={theme().boxRound.horizontal} ruleColor={theme().fgColor("border")} />
			</stack>
		</box>
	);
}

/** Placement options for the cancellable loader portal. */
export interface BorderedLoaderProps extends BorderedLoaderViewProps {
	readonly width?: SizeValue;
}

/** Mount the cancellable loading view as a bottom-aligned overlay. */
export function BorderedLoader(props: BorderedLoaderProps): JSX.Element {
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<BorderedLoaderView message={props.message} onAbort={props.onAbort} />
		</Portal>
	);
}

/** Open the bordered loader overlay on a TUI instance, returning its lifetime handle. */
export function openBorderedLoader(
	tui: TUI,
	message: string,
	onAbort?: () => void,
	options?: { width?: SizeValue },
): OverlayDisposer {
	return mountOverlay(tui, () => <BorderedLoader message={message} width={options?.width} onAbort={onAbort} />);
}
