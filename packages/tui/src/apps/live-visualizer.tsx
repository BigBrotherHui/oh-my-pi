import { type HostKeyEvent } from "../host/input";
import { sanitizeDisplaySingleLine } from "../overlays/extensions/display-text";
import { type KeyId, matchesKey } from "../keys";
import { cellWidth } from "../core/richtext";
import { skipCells, takeCells } from "../core/out";
import {
	createEffect,
	createSignal,
	onMount,
	useClock,
	useFocus,
	useTheme,
	type Accessor,
	type JSX,
} from "../reactive";
import type { ThemeColor } from "../theme/schema";

/** Distinct states of a realtime call connection. */
export type LivePhase = "connecting" | "listening" | "working" | "speaking" | "muted" | "error";

const PHASE_ICONS: Record<LivePhase, string> = {
	connecting: "○",
	listening: "●",
	working: "○",
	speaking: "»",
	muted: "×",
	error: "!",
};
const PHASE_COLORS: Record<LivePhase, ThemeColor> = {
	connecting: "dim",
	listening: "success",
	working: "warning",
	speaking: "accent",
	muted: "dim",
	error: "error",
};
const SPECTRUM_BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

interface VisualizerBox {
	readonly topLeft: string;
	readonly topRight: string;
	readonly bottomLeft: string;
	readonly bottomRight: string;
	readonly horizontal: string;
	readonly vertical: string;
}

const COMPACT_BOX: VisualizerBox = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
};

/** Configuration and live state supplied by the owning live-session controller. */
export interface LiveVisualizerProps {
	readonly phase: Accessor<LivePhase>;
	readonly inputLevel: Accessor<number>;
	readonly transcript: Accessor<string>;
	onStop(): void;
	onToggleMute(): void;
	/** Configured `app.live.toggle` chords that also end the call (Ctrl+L by default). */
	readonly stopKeys?: readonly KeyId[];
}

interface LiveVisualizerSnapshot {
	readonly phase: LivePhase;
	readonly displayLevel: number;
	readonly frame: number;
	readonly transcript: string;
}

function clippedFromStart(text: string, width: number): string {
	if (width <= 0) return "";
	const measured = cellWidth(text);
	if (measured <= width) return text;
	if (width === 1) return "…";
	return `…${takeCells(skipCells(text, measured - width + 1), width - 1)}`;
}

function spectrumRows(props: LiveVisualizerSnapshot, width: number): [string, string] {
	let upper = "";
	let lower = "";
	const energy = props.phase === "muted" ? 0 : Math.min(1, Math.sqrt(props.displayLevel * 5));
	const maxHeight = 2 * (SPECTRUM_BLOCKS.length - 1);
	for (let column = 0; column < width; column += 1) {
		const carrier = 0.5 + 0.5 * Math.sin(props.frame * 0.43 + column * 0.71);
		const shimmer = 0.5 + 0.5 * Math.sin(props.frame * 0.19 - column * 1.17);
		const height = Math.round(energy * (0.3 + carrier * 0.5 + shimmer * 0.2) * maxHeight);
		upper += SPECTRUM_BLOCKS[Math.max(0, Math.min(8, height - 8))]!;
		lower += SPECTRUM_BLOCKS[Math.max(0, Math.min(8, height))]!;
	}
	return [upper, lower];
}

function BodyRow({
	content,
	color,
	compact,
	vertical,
}: {
	readonly content: string;
	readonly color: ThemeColor;
	readonly compact: boolean;
	readonly vertical: string;
}): JSX.Element {
	return (
		<text wrap="none">
			<span color="border">{vertical}</span>
			{compact ? null : " "}
			<span color={color}>{content}</span>
			{compact ? null : " "}
			<span color="border">{vertical}</span>
		</text>
	);
}

function FooterRow({
	width,
	phase,
	box,
	frame,
	spinnerFrames,
}: {
	readonly width: number;
	readonly phase: LivePhase;
	readonly box: VisualizerBox;
	readonly frame: number;
	readonly spinnerFrames: readonly string[];
}): JSX.Element {
	const innerWidth = width - 2;
	const icon =
		phase === "working" ? (spinnerFrames[frame % spinnerFrames.length] ?? PHASE_ICONS.working) : PHASE_ICONS[phase];
	const status = `${icon} ${phase}`;
	const fullLabel = ` ${status} · space mute · esc end `;
	const shortLabel = ` ${status} `;
	const label =
		innerWidth >= cellWidth(fullLabel) + 1 ? fullLabel : innerWidth >= cellWidth(shortLabel) + 1 ? shortLabel : "";
	if (!label) {
		return (
			<text wrap="none" color="border">
				{box.bottomLeft}
				{box.horizontal.repeat(innerWidth)}
				{width > 1 ? box.bottomRight : ""}
			</text>
		);
	}
	const shownLabel = takeCells(label, Math.max(0, innerWidth - 1));
	return (
		<text wrap="none">
			<span color="border">
				{box.bottomLeft}
				{box.horizontal}
			</span>
			<span color={PHASE_COLORS[phase]}>{shownLabel}</span>
			<span color="border">
				{box.horizontal.repeat(Math.max(0, innerWidth - cellWidth(label) - 1))}
				{width > 1 ? box.bottomRight : ""}
			</span>
		</text>
	);
}

function LiveVisualizerPanel({
	width: availableWidth,
	phase,
	displayLevel,
	frame,
	transcript,
}: LiveVisualizerSnapshot & { readonly width: number }): JSX.Element {
	const palette = useTheme();
	const width = Math.max(2, Math.trunc(availableWidth));
	const compact = width < 4;
	const box = compact ? COMPACT_BOX : palette.theme().boxRound;
	const contentWidth = compact ? width - 2 : width - 4;
	const spectrumColor: ThemeColor = phase === "muted" ? "dim" : phase === "error" ? "error" : "success";
	const spectrum = spectrumRows({ phase, displayLevel, frame, transcript }, contentWidth);
	const clippedTranscript = clippedFromStart(transcript, contentWidth);
	const transcriptPadding = " ".repeat(Math.max(0, contentWidth - cellWidth(clippedTranscript)));
	return (
		<stack>
			<text wrap="none" color="border">
				{box.topLeft}
				{box.horizontal.repeat(Math.max(0, width - 2))}
				{box.topRight}
			</text>
			<BodyRow content={spectrum[0]} color={spectrumColor} compact={compact} vertical={box.vertical} />
			<BodyRow content={spectrum[1]} color={spectrumColor} compact={compact} vertical={box.vertical} />
			<text wrap="none">
				<span color="border">{box.vertical}</span>
				{compact ? null : " "}
				<span color="accent">{clippedTranscript}</span>
				{transcriptPadding}
				{compact ? null : " "}
				<span color="border">{box.vertical}</span>
			</text>
			<FooterRow width={width} phase={phase} box={box} frame={frame} spinnerFrames={palette.theme().spinnerFrames} />
		</stack>
	);
}

/** Reactive, fixed-height microphone spectrum and transcript panel for `/live`. */
export function LiveVisualizerView(props: LiveVisualizerProps): JSX.Element {
	const focus = useFocus();
	const spinnerTime = useClock("spinner");
	const startedAt = spinnerTime();
	const frame = (): number => Math.max(0, Math.floor((spinnerTime() - startedAt) / 80));
	const initialLevel = props.inputLevel();
	const initialInput = Number.isFinite(initialLevel) ? Math.min(1, Math.max(0, initialLevel)) : 0;
	const [displayLevel, setDisplayLevel] = createSignal(initialInput);
	let inputLevel = initialInput;
	let previousFrame = frame();

	createEffect(() => {
		const rawInput = props.inputLevel();
		const nextInput = Number.isFinite(rawInput) ? Math.min(1, Math.max(0, rawInput)) : 0;
		const nextFrame = frame();
		if (nextInput !== inputLevel) {
			inputLevel = nextInput;
			setDisplayLevel(previous => (nextInput > previous ? nextInput : previous));
		}
		if (nextFrame === previousFrame) return;
		previousFrame = nextFrame;
		setDisplayLevel(previous => Math.max(inputLevel, previous * 0.84));
	});

	const handleKey = (event: HostKeyEvent): void => {
		if (
			matchesKey(event.data, "escape") ||
			matchesKey(event.data, "ctrl+c") ||
			props.stopKeys?.some(key => matchesKey(event.data, key))
		) {
			event.preventDefault();
			event.stopPropagation();
			props.onStop();
			return;
		}
		if (matchesKey(event.data, "space")) {
			event.preventDefault();
			event.stopPropagation();
			props.onToggleMute();
		}
	};

	onMount(() => focus.focus());
	return (
		<box tabIndex={focus.tabIndex} onKey={handleKey}>
			<sized
				paint={width => (
					<LiveVisualizerPanel
						width={width}
						phase={props.phase()}
						displayLevel={displayLevel()}
						frame={frame()}
						transcript={sanitizeDisplaySingleLine(props.transcript()).replace(/\s+/g, " ").trim()}
					/>
				)}
			/>
		</box>
	);
}
