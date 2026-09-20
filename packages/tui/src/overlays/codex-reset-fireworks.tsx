import { createMemo, useClock, type JSX } from "../reactive";
import { matchesKey } from "../keys";
import { Portal, createOverlayDisposer, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { ThemeColor } from "../theme/schema";
import type { TUI } from "../tui";
import { getSegmenter } from "../utils";
import { cellWidth } from "../core/richtext";

const FRAME_INTERVAL_MS = 85;
const FRAME_COUNT = 34;

const FIREWORK_THEME_COLORS = {
	cyan: "mdLink",
	dim: "dim",
	gold: "warning",
	green: "success",
	pink: "accent",
	violet: "thinkingXhigh",
	white: "text",
} as const satisfies Record<string, ThemeColor>;

type FireworkColor = keyof typeof FIREWORK_THEME_COLORS;

export interface CodexResetUsageSnapshot {
	observedAt?: number;
	sevenDay?: { percent: number; resetsAt?: number; tier?: string; plan?: string };
	savedResets?: number;
}

export type CodexResetFireworksEvent =
	| { kind: "unscheduled-weekly-reset" }
	| { kind: "saved-reset-banked"; added: number; available: number };

interface CanvasCell {
	glyph: string;
	color: FireworkColor;
	priority: number;
}

interface FireworkBurst {
	x: number;
	y: number;
	start: number;
	color: FireworkColor;
}

const BURSTS: readonly FireworkBurst[] = [
	{ x: 0.17, y: 0.46, start: 5, color: "pink" },
	{ x: 0.48, y: 0.2, start: 9, color: "cyan" },
	{ x: 0.78, y: 0.42, start: 13, color: "gold" },
	{ x: 0.31, y: 0.24, start: 17, color: "violet" },
	{ x: 0.65, y: 0.28, start: 21, color: "green" },
	{ x: 0.88, y: 0.18, start: 25, color: "pink" },
];

/** Detects a quota event worth presenting to the user. */
export function detectCodexResetFireworks(
	previous: CodexResetUsageSnapshot,
	current: CodexResetUsageSnapshot,
): CodexResetFireworksEvent | undefined {
	if (previous.savedResets !== undefined) {
		if (current.savedResets === undefined) {
			if (previous.savedResets > 0) return undefined;
		} else if (current.savedResets > previous.savedResets) {
			return {
				kind: "saved-reset-banked",
				added: current.savedResets - previous.savedResets,
				available: current.savedResets,
			};
		} else if (current.savedResets < previous.savedResets) return undefined;
	}
	if (!previous.sevenDay || !current.sevenDay) return undefined;
	if (previous.sevenDay.tier !== current.sevenDay.tier || previous.sevenDay.plan !== current.sevenDay.plan)
		return undefined;
	const before = Math.round(Math.max(0, Math.min(100, previous.sevenDay.percent)));
	const after = Math.round(Math.max(0, Math.min(100, current.sevenDay.percent)));
	if (before === 0 || after >= before) return undefined;
	const scheduled = previous.sevenDay.resetsAt;
	const next = current.sevenDay.resetsAt;
	if (
		scheduled === undefined ||
		!Number.isFinite(scheduled) ||
		next === undefined ||
		!Number.isFinite(next) ||
		next <= scheduled ||
		current.observedAt === undefined ||
		!Number.isFinite(current.observedAt) ||
		current.observedAt >= scheduled
	)
		return undefined;
	return { kind: "unscheduled-weekly-reset" };
}

function setCell(
	canvas: Array<Array<CanvasCell | undefined>>,
	x: number,
	y: number,
	glyph: string,
	color: FireworkColor,
	priority: number,
): void {
	const row = canvas[y];
	if (!row || x < 0 || x >= row.length) return;
	const current = row[x];
	if (!current || priority >= current.priority) row[x] = { glyph, color, priority };
}

function drawText(
	canvas: Array<Array<CanvasCell | undefined>>,
	x: number,
	y: number,
	text: string,
	color: FireworkColor,
	priority: number,
): void {
	let column = x;
	for (const { segment } of getSegmenter().segment(text)) {
		const width = cellWidth(segment);
		if (width <= 0) continue;
		setCell(canvas, column, y, segment, color, priority);
		for (let continuation = 1; continuation < width; continuation++) {
			setCell(canvas, column + continuation, y, "", color, priority);
		}
		column += width;
	}
}

function drawBanner(
	canvas: Array<Array<CanvasCell | undefined>>,
	left: number,
	artWidth: number,
	height: number,
	event: CodexResetFireworksEvent,
): void {
	if (height < 3 || artWidth < 8) return;
	const panelWidth = Math.min(62, artWidth);
	const panelLeft = left + Math.floor((artWidth - panelWidth) / 2);
	const top = height - 3;
	const innerWidth = panelWidth - 2;
	const titleText =
		event.kind === "unscheduled-weekly-reset" ? " O P E N A I   R E S E T " : " S A V E D   R E S E T ";
	const subtitleText =
		event.kind === "unscheduled-weekly-reset"
			? "Weekly usage cleared early · ESC to return"
			: event.added === 1
				? `New reset banked · ${event.available} available · ESC to return`
				: `${event.added} resets banked · ${event.available} available · ESC to return`;
	const title = titleText;
	const subtitle = subtitleText;
	const titleOffset = Math.floor((innerWidth - cellWidth(title)) / 2);
	const subtitleOffset = Math.floor((innerWidth - cellWidth(subtitle)) / 2);

	drawText(canvas, panelLeft, top, `╭${"─".repeat(innerWidth)}╮`, "violet", 20);
	drawText(canvas, panelLeft + 1 + titleOffset, top, title, "gold", 21);
	drawText(canvas, panelLeft, top + 1, `│${" ".repeat(innerWidth)}│`, "violet", 20);
	drawText(canvas, panelLeft + 1 + subtitleOffset, top + 1, subtitle, "cyan", 21);
	drawText(canvas, panelLeft, top + 2, `╰${"─".repeat(innerWidth)}╯`, "violet", 20);
}

function drawStars(
	canvas: Array<Array<CanvasCell | undefined>>,
	left: number,
	width: number,
	height: number,
	frame: number,
): void {
	if (height <= 0) return;
	for (let index = 0; index < Math.min(26, Math.max(5, Math.floor(width / 3))); index++) {
		const bright = (index + Math.floor(frame / 3)) % 5 === 0;
		setCell(
			canvas,
			left + ((index * 37 + 11) % width),
			(index * 7 + 2) % height,
			bright ? "+" : ".",
			bright ? "white" : "dim",
			bright ? 2 : 1,
		);
	}
}

function drawBurst(
	canvas: Array<Array<CanvasCell | undefined>>,
	burst: FireworkBurst,
	left: number,
	artWidth: number,
	skyHeight: number,
	frame: number,
): void {
	if (skyHeight <= 1) return;
	const centerX = left + Math.round((artWidth - 1) * burst.x);
	const centerY = Math.max(0, Math.min(skyHeight - 2, Math.round((skyHeight - 1) * burst.y)));
	const age = frame - burst.start;

	if (age >= -6 && age < 0) {
		const progress = (age + 6) / 6;
		const y = skyHeight - 1 - Math.round(progress * (skyHeight - 1 - centerY));
		setCell(canvas, centerX, y, "^", "white", 8);
		setCell(canvas, centerX, y + 1, "|", burst.color, 7);
		setCell(canvas, centerX, y + 2, ".", "gold", 6);
		return;
	}
	if (age < 0 || age > 8) return;

	const radius = age === 0 ? 0 : 0.8 + age * 0.92;
	const gravity = Math.floor((age * age) / 22);
	const glyphs = ["@", "*", "*", "+", "o", "o", ".", ".", "."] as const;
	const particleColor: FireworkColor = age <= 5 ? burst.color : age <= 7 ? "gold" : "dim";

	for (let particle = 0; particle < 20; particle++) {
		const angle = (particle / 20) * Math.PI * 2 + burst.start * 0.17;
		const x = centerX + Math.round(Math.cos(angle) * radius * 1.75);
		const y = centerY + Math.round(Math.sin(angle) * radius * 0.58 + gravity);
		setCell(canvas, x, y, glyphs[age], particleColor, 10);
		if (age >= 2 && age <= 6) {
			const trailRadius = Math.max(0, radius - 1.4);
			const trailX = centerX + Math.round(Math.cos(angle) * trailRadius * 1.75);
			const trailY = centerY + Math.round(Math.sin(angle) * trailRadius * 0.58 + gravity);
			setCell(canvas, trailX, trailY, ".", "dim", 5);
		}
	}
	if (age <= 2) setCell(canvas, centerX, centerY, age === 0 ? "@" : "+", "white", 12);
}

function canvasRow(row: readonly (CanvasCell | undefined)[]): JSX.Element {
	const children: Array<JSX.Element | string> = [];
	let text = "";
	let color: FireworkColor | undefined;
	for (const cell of row) {
		const nextColor = cell?.color;
		if (nextColor !== color) {
			if (text) children.push(color === undefined ? text : <span color={FIREWORK_THEME_COLORS[color]}>{text}</span>);
			text = "";
			color = nextColor;
		}
		text += cell?.glyph ?? " ";
	}
	if (text) children.push(color === undefined ? text : <span color={FIREWORK_THEME_COLORS[color]}>{text}</span>);
	return <text wrap="none">{children}</text>;
}

function canvasRows(width: number, height: number, frame: number, event: CodexResetFireworksEvent): JSX.Element {
	const safeWidth = Math.max(1, Math.floor(width));
	const safeHeight = Math.max(1, Math.floor(height));
	const artWidth = Math.min(96, safeWidth);
	const left = Math.floor((safeWidth - artWidth) / 2);
	const skyHeight = Math.max(0, safeHeight - 3);
	const canvas = Array.from({ length: safeHeight }, () => new Array<CanvasCell | undefined>(safeWidth));

	drawStars(canvas, left, artWidth, skyHeight, frame);
	for (const burst of BURSTS) drawBurst(canvas, burst, left, artWidth, skyHeight, frame);
	drawBanner(canvas, left, artWidth, safeHeight, event);
	return <stack>{canvas.map(canvasRow)}</stack>;
}

export interface CodexResetFireworksViewProps {
	readonly event: CodexResetFireworksEvent;
	/** Fixed height, or a current-height reader for terminals that resize while visible. */
	readonly height?: number | (() => number);
	readonly onDone?: () => void;
}

/** Animated reactive celebration view. The shared frame clock stops with the overlay. */
export function CodexResetFireworksView(props: CodexResetFireworksViewProps): JSX.Element {
	const clock = useClock("frame");
	const startedAt = clock();
	const frame = createMemo(() => Math.floor((clock() - startedAt) / FRAME_INTERVAL_MS) % FRAME_COUNT);
	const paint = createMemo(() => {
		const currentFrame = frame();
		return (width: number) => {
			const height = typeof props.height === "function" ? props.height() : props.height;
			return canvasRows(width, Math.max(1, Math.floor(height ?? 12)), currentFrame, props.event);
		};
	});
	return <sized paint={paint()} />;
}

export function CodexResetFireworksOverlay(props: CodexResetFireworksViewProps): JSX.Element {
	return (
		<Portal to="overlay" anchor="top-center" width="100%" maxHeight="33%" margin={0}>
			<box
				tabIndex={0}
				onKey={event => {
					if (matchesKey(event.data, "escape") || matchesKey(event.data, "esc")) {
						event.preventDefault();
						props.onDone?.();
					}
				}}
			>
				<CodexResetFireworksView {...props} />
			</box>
		</Portal>
	);
}

export interface CodexResetFireworksHandle extends OverlayDisposer {}

export function openCodexResetFireworksOverlay(
	tui: TUI,
	event: CodexResetFireworksEvent,
	onDone?: () => void,
): CodexResetFireworksHandle {
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		overlay?.dispose();
		onDone?.();
	};
	const overlay = mountOverlay(tui, () => (
		<CodexResetFireworksOverlay event={event} height={() => Math.floor(tui.terminal.rows * 0.33)} onDone={dispose} />
	));
	return createOverlayDisposer(dispose);
}

/** Owns the at-most-one modal celebration lifecycle for an interactive session. */
export class CodexResetFireworksController {
	#active: CodexResetFireworksHandle | undefined;

	constructor(private readonly tui: TUI) {}

	/** Present a celebration unless another one already owns the modal overlay. */
	show(event: CodexResetFireworksEvent): boolean {
		if (this.#active) return false;
		const finish = (): void => {
			if (this.#active === handle) this.#active = undefined;
		};
		const handle = openCodexResetFireworksOverlay(this.tui, event, finish);
		this.#active = handle;
		return true;
	}

	/** Stop the active celebration and release its overlay, if present. */
	dispose(): void {
		const active = this.#active;
		if (!active) return;
		this.#active = undefined;
		active.dispose();
	}
}
