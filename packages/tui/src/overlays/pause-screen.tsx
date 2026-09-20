import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { For, type JSX } from "../reactive";
import { useClock } from "../reactive/clock";
import { matchesAppInterrupt } from "../keybinding-matchers";
import type { ThemeColor } from "../theme/schema";
import { matchesKey } from "../keys";
import { spaces } from "../core/out";
import { formatCoarseDuration } from "../chrome/format";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent } from "../host/input";
import type { TUI } from "../tui";

export interface PauseScreenHost {
	readonly ui: TUI;
	showStatus(message: string, options?: { readonly dim?: boolean }): void;
	readonly sessionName?: string;
}

const BAR_ROWS = 7;
const BAR_WIDTH = 5;
const BAR_GAP = 4;
const MIN_FULL_WIDTH = 64;
const MIN_FULL_HEIGHT = 18;
const TITLE = "P A U S E D";
const BODY_LINES = [
	"Main agent, subagents, and advisor hold at their next step.",
	"In-flight calls finish; nothing new starts until you resume.",
] as const;
const RESUME_HINT = "esc · enter · space — resume";

function formatClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

interface PauseLine {
	readonly text: string;
	readonly tone?: ThemeColor;
	readonly bold?: boolean;
}

export interface PauseScreenViewProps {
	readonly width: number;
	readonly height: number;
	readonly elapsedMs: number;
	readonly sessionName?: string;
}

export function PauseScreenView(props: PauseScreenViewProps): JSX.Element {
	const safeWidth = () => Math.max(1, Math.floor(props.width));
	const safeHeight = () => Math.max(1, Math.floor(props.height));
	const compact = () => safeWidth() < MIN_FULL_WIDTH || safeHeight() < MIN_FULL_HEIGHT;

	const lines = () => {
		const result: PauseLine[] = [];
		const blank = (): void => {
			result.push({ text: "" });
		};

		if (compact()) {
			if (props.sessionName) {
				result.push({ text: props.sessionName, bold: true });
				blank();
			}
			result.push({ text: `▌▌ ${TITLE}`, tone: "accent", bold: true });
			blank();
			result.push({ text: `paused for ${formatClock(props.elapsedMs)}`, tone: "dim" });
			result.push({ text: "esc to resume", tone: "dim" });
		} else {
			if (props.sessionName) {
				result.push({ text: props.sessionName, bold: true });
				blank();
				blank();
			}
			const bar = "█".repeat(BAR_WIDTH);
			const glyphRow = `${bar}${spaces(BAR_GAP)}${bar}`;
			for (let index = 0; index < BAR_ROWS; index++) result.push({ text: glyphRow, tone: "accent" });
			blank();
			result.push({ text: TITLE, tone: "accent", bold: true });
			blank();
			for (const text of BODY_LINES) result.push({ text, tone: "muted" });
			blank();
			result.push({ text: `paused for ${formatClock(props.elapsedMs)}`, tone: "dim" });
			blank();
			result.push({ text: RESUME_HINT, tone: "dim" });
		}
		return result;
	};

	const topPad = () => Math.max(0, Math.floor((safeHeight() - lines().length) / 2));
	const visibleRows = () => Math.min(lines().length, safeHeight() - topPad());
	const bottomPad = () => Math.max(0, safeHeight() - topPad() - visibleRows());

	return (
		<stack>
			<For each={Array.from({ length: topPad() })}>{() => <br />}</For>
			<For each={lines().slice(0, visibleRows())}>
				{line => (
					<text align="center" wrap="clip" overflow="ellipsis">
						<span color={line.tone} bold={line.bold}>
							{line.text}
						</span>
					</text>
				)}
			</For>
			<For each={Array.from({ length: bottomPad() })}>{() => <br />}</For>
		</stack>
	);
}

export interface PauseScreenProps {
	readonly host: PauseScreenHost;
	readonly onResume?: () => void;
}

/** Fullscreen reactive pause scene. Every dismissal key resumes the held gate. */
export function PauseScreen(props: PauseScreenProps): JSX.Element {
	const clock = useClock("second");
	const startedAt = agentPauseGate.pausedAt ?? clock();
	let resumed = false;

	const handleKey = (event: HostKeyEvent): void => {
		if (
			!matchesAppInterrupt(event.data) &&
			!matchesKey(event.data, "enter") &&
			!matchesKey(event.data, "return") &&
			!matchesKey(event.data, "space") &&
			!matchesKey(event.data, "ctrl+c")
		) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (resumed) return;
		resumed = true;
		props.onResume?.();
	};

	return (
		<Portal to="overlay" fullscreen>
			<box onKey={handleKey} tabIndex={0}>
				<sized
					paint={width => (
						<PauseScreenView
							width={width}
							height={props.host.ui.terminal.rows}
							elapsedMs={Math.max(0, clock() - startedAt)}
							sessionName={props.host.sessionName}
						/>
					)}
				/>
			</box>
		</Portal>
	);
}

export const PauseScreenComponent = PauseScreen;

/** Open the pause screen overlay on a TUI instance, returning a disposer handle. */
export function openPauseScreen(tui: TUI, host: PauseScreenHost, onResume?: () => void): OverlayDisposer {
	return mountOverlay(tui, () => <PauseScreen host={host} onResume={onResume} />);
}

export const showPauseScreen = openPauseScreen;

export async function runPauseScreen(host: PauseScreenHost): Promise<void> {
	if (!agentPauseGate.pause()) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	let handle: OverlayDisposer | undefined;

	try {
		handle = openPauseScreen(host.ui, host, () => {
			handle?.hide();
			resolve();
		});
		await promise;
	} finally {
		handle?.hide();
		const heldMs = agentPauseGate.resume();
		if (heldMs !== undefined) {
			host.showStatus(`Resumed after ${formatCoarseDuration(heldMs)} — agents are running again.`);
		}
	}
}
