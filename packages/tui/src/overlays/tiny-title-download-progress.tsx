import { formatBytes } from "@oh-my-pi/pi-utils";
import { createMemo, createSignal, type JSX, useTheme } from "../reactive";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { SizeValue, TUI } from "../tui";

export interface TinyTitleDownloadProgress {
	status: "initiate" | "download" | "progress" | "progress_total" | "done" | "ready" | "error";
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
	files?: Record<string, { loaded: number; total: number }>;
}

const DEFAULT_BAR_WIDTH = 24;

function currentFile(event: TinyTitleDownloadProgress | undefined): string | undefined {
	if (!event) return undefined;
	if (event.file) return event.file.split("/").at(-1) ?? event.file;
	if (event.files) {
		let largestFile: string | undefined;
		let largestLoaded = -1;
		for (const file in event.files) {
			const state = event.files[file];
			if (!state || state.loaded <= largestLoaded || state.loaded >= state.total) continue;
			largestFile = file;
			largestLoaded = state.loaded;
		}
		return largestFile?.split("/").at(-1) ?? largestFile;
	}
	return undefined;
}

function statusLabel(event: TinyTitleDownloadProgress | undefined): string {
	if (!event) return "Preparing";
	if (event.status === "error") return "Failed";
	if (event.status === "ready") return "Ready";
	if (event.status === "done") return "Downloaded";
	if (event.status === "download" || event.status === "progress" || event.status === "progress_total") {
		return "Downloading";
	}
	return "Preparing";
}

function byteLabel(event: TinyTitleDownloadProgress | undefined): string | undefined {
	if (!event?.loaded || !event.total) return undefined;
	return `${formatBytes(event.loaded)} / ${formatBytes(event.total)}`;
}

export interface TinyTitleDownloadProgressViewProps {
	readonly modelLabel: string;
	readonly event?: TinyTitleDownloadProgress;
}

interface TinyTitleDownloadProgressRowsProps extends TinyTitleDownloadProgressViewProps {
	readonly width: number;
}

function TinyTitleDownloadProgressRows(props: TinyTitleDownloadProgressRowsProps): JSX.Element {
	const theme = useTheme();
	const presentation = createMemo(() => {
		const safeWidth = Math.max(1, Math.trunc(props.width));
		const requested = Math.max(8, safeWidth - 36);
		const barWidth = Math.max(8, Math.min(DEFAULT_BAR_WIDTH, requested));
		const event = props.event;
		const fraction = event?.progress === undefined ? undefined : Math.max(0, Math.min(1, event.progress / 100));
		const filled = fraction === undefined ? 0 : Math.round(fraction * barWidth);
		const percent = event?.progress === undefined ? "" : `${Math.floor(event.progress).toString().padStart(3, " ")}%`;
		const details = [percent, byteLabel(event), currentFile(event)].filter((part): part is string => Boolean(part));

		return {
			status: statusLabel(event),
			filled: "█".repeat(filled),
			empty: "░".repeat(barWidth - filled),
			details: details.length > 0 ? ` ${details.join(" ")}` : "",
		};
	});

	return (
		<stack>
			<hr ruleColor="border" char={theme.symbol("boxRound.horizontal")} />
			<text wrap="clip" pad>
				{" "}
				<span color="accent">Tiny model</span> <span color="muted">{presentation().status}</span> {props.modelLabel}
			</text>
			<text wrap="clip" pad>
				{" "}
				<span color="accent">{presentation().filled}</span>
				<span color="muted">{presentation().empty}</span>
				{presentation().details}
			</text>
			<hr ruleColor="border" char={theme.symbol("boxRound.horizontal")} />
		</stack>
	);
}

export function TinyTitleDownloadProgressView(props: TinyTitleDownloadProgressViewProps): JSX.Element {
	return (
		<sized
			paint={width => (
				<TinyTitleDownloadProgressRows width={width} modelLabel={props.modelLabel} event={props.event} />
			)}
		/>
	);
}

export interface TinyTitleDownloadProgressProps {
	readonly modelLabel: string;
	readonly event?: TinyTitleDownloadProgress;
	readonly width?: SizeValue;
}

/** Reactive overlay mounted at the bottom of the terminal. */
export function TinyTitleDownloadProgressOverlay(props: TinyTitleDownloadProgressProps): JSX.Element {
	return (
		<Portal to="overlay" modal={false} anchor="bottom-center" width={props.width ?? "100%"}>
			<box>
				<TinyTitleDownloadProgressView modelLabel={props.modelLabel} event={props.event} />
			</box>
		</Portal>
	);
}

export interface TinyTitleDownloadProgressHandle extends OverlayDisposer {
	update(event: TinyTitleDownloadProgress): void;
}

/** Open the tiny title download progress overlay on a TUI instance, returning a disposer handle. */
export function openTinyTitleDownloadProgress(
	tui: TUI,
	modelLabel: string,
	initialEvent?: TinyTitleDownloadProgress,
	options?: { width?: SizeValue },
): TinyTitleDownloadProgressHandle {
	const [event, setEvent] = createSignal<TinyTitleDownloadProgress | undefined>(initialEvent);
	const disposer = mountOverlay(tui, () => (
		<TinyTitleDownloadProgressOverlay modelLabel={modelLabel} event={event()} width={options?.width} />
	));
	return Object.assign(disposer, {
		update(ev: TinyTitleDownloadProgress): void {
			setEvent(ev);
		},
	});
}
