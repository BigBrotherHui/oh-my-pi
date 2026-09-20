import { createMemo, createSignal, For, useTheme, type JSX } from "../reactive";
import { matchesKey } from "../keys";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent } from "../host/input";
import type { SizeValue, TUI } from "../tui";

export interface MoveOverlayResult {
	directory: string;
}

export interface MoveDirectoryEntry {
	value: string;
	label: string;
}

export interface MoveDirectorySource {
	search(prefix: string, cwd: string, max: number): MoveDirectoryEntry[];
}

const MAX_RESULTS = 15;

export interface MoveOverlayViewProps {
	readonly query: string;
	readonly results: readonly MoveDirectoryEntry[];
	readonly selectedIndex: number;
	readonly onInputKey: (event: HostKeyEvent) => void;
	readonly onQueryChange: (value: string) => void;
	readonly onSubmit: (value: string) => void;
	readonly onCancel: () => void;
}

export function MoveOverlayView(props: MoveOverlayViewProps): JSX.Element {
	const theme = useTheme();

	return (
		<frame title="Move to directory" paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<stack>
				<input
					tabIndex={0}
					value={props.query}
					prompt="Path: "
					promptStyle={theme.theme().style("dim")}
					onKey={props.onInputKey}
					onChange={props.onQueryChange}
					onSubmit={props.onSubmit}
					onEscape={props.onCancel}
				/>
				<br />
				{props.results.length === 0 && props.query.length > 0 ? (
					<text color="dim">No matching directories</text>
				) : (
					<stack>
						<For each={props.results.slice(0, MAX_RESULTS)}>
							{(item, index) => {
								const selected = () => index() === props.selectedIndex;
								return (
									<text wrap="none">
										<span color={selected() ? "accent" : undefined}>{selected() ? "▶ " : "  "}</span>
										<span color={selected() ? "accent" : "text"}>{item.label}</span>
									</text>
								);
							}}
						</For>
					</stack>
				)}
				<br />
				<text color="dim" overflow="clip">
					Type to filter · ↑↓ navigate · Tab accept · Enter confirm · Esc cancel
				</text>
			</stack>
		</frame>
	);
}

export interface MoveOverlayProps {
	readonly cwd: string;
	readonly source: MoveDirectorySource;
	readonly onDone?: (result: MoveOverlayResult | undefined) => void;
	readonly onClose?: () => void;
	readonly width?: SizeValue;
}

/** Reactive `/move` overlay with the native single-line input lifecycle. */
export function MoveOverlay(props: MoveOverlayProps): JSX.Element {
	const [query, setQuery] = createSignal("");
	const [selectedIndex, setSelectedIndex] = createSignal(0);
	const results = createMemo(() => props.source.search(query(), props.cwd, MAX_RESULTS + 5));

	const finish = (result: MoveOverlayResult | undefined): void => {
		props.onDone?.(result);
		props.onClose?.();
	};
	const submit = (value: string): void => {
		const selected = results()[selectedIndex()];
		finish(selected ? { directory: selected.value } : value.trim() ? { directory: value.trim() } : undefined);
	};
	const updateQuery = (value: string): void => {
		setQuery(value);
		setSelectedIndex(0);
	};
	const handleInputKey = (event: HostKeyEvent): void => {
		if (
			matchesSelectCancel(event.data) ||
			matchesKey(event.data, "escape") ||
			matchesKey(event.data, "esc") ||
			matchesKey(event.data, "ctrl+c")
		) {
			finish(undefined);
		} else if (matchesSelectUp(event.data) || matchesKey(event.data, "up")) {
			const count = results().length;
			if (count > 0) setSelectedIndex(index => Math.max(0, index - 1));
		} else if (matchesSelectDown(event.data) || matchesKey(event.data, "down")) {
			const count = results().length;
			if (count > 0) setSelectedIndex(index => Math.min(count - 1, index + 1));
		} else if (matchesKey(event.data, "tab")) {
			const selected = results()[selectedIndex()];
			if (selected) {
				setQuery(selected.value);
				setSelectedIndex(0);
			}
		} else {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<box tabIndex={0}>
				<MoveOverlayView
					query={query()}
					results={results()}
					selectedIndex={selectedIndex()}
					onInputKey={handleInputKey}
					onQueryChange={updateQuery}
					onSubmit={submit}
					onCancel={() => finish(undefined)}
				/>
			</box>
		</Portal>
	);
}

/** Open the move overlay on a TUI instance, returning a disposer handle. */
export function openMoveOverlay(
	tui: TUI,
	cwd: string,
	done: (result: MoveOverlayResult | undefined) => void,
	source: MoveDirectorySource,
	options?: { width?: SizeValue },
): OverlayDisposer {
	return mountOverlay(tui, () => <MoveOverlay cwd={cwd} source={source} width={options?.width} onDone={done} />);
}

export const showMoveOverlay = openMoveOverlay;
