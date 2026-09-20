import { createSignal, type JSX } from "../reactive";
import { matchesKey } from "../keys";
import { matchesSelectCancel } from "../keybinding-matchers";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent } from "../host/input";
import type { ScrollViewportState } from "../host/elements/scroll";
import { clampScrollOffset, maxScrollOffset } from "../components/scroll-viewport";
import type { SizeValue, TUI } from "../tui";

const FOOTER_HINT = "↑/↓ scroll · Esc close";
const PANEL_CHROME_ROWS = 4;

export interface SessionInfoOverlayHost {
	readonly terminal: {
		readonly rows: number;
	};
}

export interface SessionInfoOverlayProps {
	readonly info: string;
	readonly host?: SessionInfoOverlayHost;
	readonly onClose?: () => void;
	readonly maxHeight?: number;
	readonly width?: SizeValue;
}

export interface SessionInfoOverlayViewProps {
	readonly info: string;
	readonly offset?: number;
	readonly maxHeight?: number;
	readonly onViewport?: (viewport: ScrollViewportState) => void;
}

export function SessionInfoOverlayView(props: SessionInfoOverlayViewProps): JSX.Element {
	const bodyHeight = () =>
		props.maxHeight === undefined
			? Number.MAX_SAFE_INTEGER
			: Math.max(1, Math.trunc(props.maxHeight) - PANEL_CHROME_ROWS);

	return (
		<frame title="Session Info" paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<scroll
				height={bodyHeight()}
				offset={props.offset ?? 0}
				followTail={false}
				scrollbar="auto"
				shrinkToFit
				trackColor="dim"
				thumbColor="accent"
				onViewport={props.onViewport}
			>
				<text wrap="word">{props.info}</text>
			</scroll>
			<hr variant="frame" />
			<text color="dim" wrap="clip">
				{FOOTER_HINT}
			</text>
		</frame>
	);
}

/** Reactive session-info overlay mounted through a portal. */
export function SessionInfoOverlay(props: SessionInfoOverlayProps): JSX.Element {
	const [offset, setOffset] = createSignal(0);
	const [viewport, setViewport] = createSignal<ScrollViewportState>();
	const maxHeight = () =>
		props.maxHeight ??
		(props.host?.terminal?.rows ? Math.max(PANEL_CHROME_ROWS, props.host.terminal.rows) : undefined);
	const onViewport = (next: ScrollViewportState): void => {
		setViewport(next);
		setOffset(next.offset);
	};
	const move = (rows: number): void => {
		const current = viewport();
		if (current) setOffset(previous => clampScrollOffset(previous + rows, current.totalRows, current.height));
	};
	const handleKey = (event: HostKeyEvent): boolean => {
		if (matchesSelectCancel(event.data) || matchesKey(event.data, "escape") || matchesKey(event.data, "esc")) {
			props.onClose?.();
			return true;
		}
		if (matchesKey(event.data, "shift+up")) {
			move(-5);
			return true;
		}
		if (matchesKey(event.data, "shift+down")) {
			move(5);
			return true;
		}
		if (matchesKey(event.data, "up")) {
			move(-1);
			return true;
		}
		if (matchesKey(event.data, "down")) {
			move(1);
			return true;
		}
		if (matchesKey(event.data, "pageUp")) {
			move(-(Math.max(1, viewport()?.height ?? 1) - 1));
			return true;
		}
		if (matchesKey(event.data, "pageDown")) {
			move(Math.max(1, viewport()?.height ?? 1) - 1);
			return true;
		}
		if (matchesKey(event.data, "home")) {
			setOffset(0);
			return true;
		}
		if (matchesKey(event.data, "end")) {
			const current = viewport();
			if (current) setOffset(maxScrollOffset(current.totalRows, current.height));
			return true;
		}
		return false;
	};
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"} maxHeight={maxHeight()}>
			<box onKey={handleKey} tabIndex={0}>
				<SessionInfoOverlayView
					info={props.info}
					offset={offset()}
					maxHeight={maxHeight()}
					onViewport={onViewport}
				/>
			</box>
		</Portal>
	);
}

/** Open the session info overlay on a TUI instance, returning a disposer handle. */
export function openSessionInfoOverlay(
	tui: TUI,
	info: string,
	onClose?: () => void,
	options?: { host?: SessionInfoOverlayHost; maxHeight?: number; width?: SizeValue },
): OverlayDisposer {
	return mountOverlay(tui, () => (
		<SessionInfoOverlay
			info={info}
			host={options?.host ?? { terminal: { rows: tui.terminal.rows } }}
			maxHeight={options?.maxHeight}
			width={options?.width}
			onClose={onClose}
		/>
	));
}

export const showSessionInfoOverlay = openSessionInfoOverlay;
