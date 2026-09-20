import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { ansi256, type Color, parseColor, rgb } from "../core/style";
import { cellWidth } from "../core/richtext";
import { createMemo, createSignal, For, Show, useClock, useTheme, type Accessor, type JSX } from "../reactive";
import { TERMINAL } from "../terminal-capabilities";
import { replaceTabs } from "../utils";
import tipsText from "./tips.txt" with { type: "text" };

const TIPS: readonly string[] = tipsText
	.split("\n")
	.map(line => line.trim())
	.filter(Boolean);

export const WELCOME_SESSION_SLOTS = 4;
export const WELCOME_LSP_SLOTS = 4;

const NEW_TIP_MARKER = /\s*\[NEW\]\s*$/;
const NEW_TAG_TEXT = "NEW!";
const NEW_GLOW_PERIOD_MS = 1500;
const NEW_TIP_WEIGHT = 4;
const INTRO_MS = 3000;
const INTRO_SWEEPS = 2.5;
const INTRO_SHINE_TRAVERSALS = 3;

/** Pick a tip with newly announced tips weighted above ordinary tips. */
export function pickWeightedTip(tips: readonly string[], r: number): string {
	if (tips.length === 0) return "";
	const weights = tips.map(tip => (NEW_TIP_MARKER.test(tip) ? NEW_TIP_WEIGHT : 1));
	let remaining = r * weights.reduce((total, weight) => total + weight, 0);
	for (let index = 0; index < tips.length; index++) {
		remaining -= weights[index] ?? 1;
		if (remaining < 0) return tips[index] ?? "";
	}
	return tips.at(-1) ?? "";
}

export interface RecentSession {
	readonly name: string;
	readonly timeAgo: string;
}

export interface LspServerInfo {
	readonly name: string;
	readonly status: string;
	readonly fileTypes?: readonly string[];
}

export interface WelcomeData {
	readonly version: string;
	readonly modelName: string;
	readonly providerName: string;
	readonly recentSessions: readonly RecentSession[];
	readonly lspServers: readonly LspServerInfo[];
}

export interface WelcomeStore {
	readonly data: Accessor<WelcomeData>;
	readonly tip: Accessor<string | undefined>;
	readonly introStartedAt: Accessor<number | undefined>;
	update(update: Partial<WelcomeData>): void;
	playIntro(): void;
	stopIntro(): void;
}

export interface WelcomeStoreOptions extends Partial<WelcomeData> {
	readonly random?: () => number;
}

/** Create reactive welcome data without coupling it to terminal ownership. */
export function createWelcomeStore(options: WelcomeStoreOptions = {}): WelcomeStore {
	const [data, setData] = createSignal<WelcomeData>({
		version: options.version ?? "",
		modelName: options.modelName ?? "Unknown",
		providerName: options.providerName ?? "Unknown",
		recentSessions: options.recentSessions ?? [],
		lspServers: options.lspServers ?? [],
	});
	const random = options.random ?? Math.random;
	const [tip] = createSignal<string | undefined>(pickWeightedTip(TIPS, random()) || undefined);
	const [introStartedAt, setIntroStartedAt] = createSignal<number | undefined>();
	let introTimer: NodeJS.Timeout | undefined;
	const stopIntro = (): void => {
		clearTimeout(introTimer);
		introTimer = undefined;
		setIntroStartedAt(undefined);
	};
	return {
		data,
		tip,
		introStartedAt,
		update: update => setData(current => ({ ...current, ...update })),
		// The reactive root clock is wall-clock based (`Date.now`), unlike
		// performance.now. Keeping this timestamp in that domain makes elapsed
		// animation time valid for every rendered clock tick.
		playIntro: () => {
			clearTimeout(introTimer);
			setIntroStartedAt(Date.now());
			// A retired header's owner clock is frozen; it cannot own this deadline.
			introTimer = setTimeout(stopIntro, INTRO_MS);
			introTimer.unref();
		},
		stopIntro,
	};
}

function wrapPlain(text: string, width: number): string[] {
	if (!text || width <= 0) return [];
	const rows: string[] = [];
	for (const logical of text.split("\n")) {
		let remaining = logical;
		while (cellWidth(remaining) > width) {
			let end = 0;
			let lastSpace = -1;
			for (const character of remaining) {
				if (cellWidth(remaining.slice(0, end + character.length)) > width) break;
				end += character.length;
				if (/\s/u.test(character)) lastSpace = end;
			}
			const atWordBoundary = end >= remaining.length || /\s/u.test(remaining[end]!);
			const split =
				atWordBoundary && cellWidth(remaining.slice(0, end)) === width
					? end
					: lastSpace > 0
						? lastSpace
						: Math.max(1, end);
			rows.push(remaining.slice(0, split).trimEnd());
			remaining = remaining.slice(split).trimStart();
		}
		rows.push(remaining);
	}
	return rows;
}

function NewTag(props: { readonly phase: number }): JSX.Element {
	const phase = ((props.phase % 1) + 1) % 1;
	return (
		<>
			<For each={[...NEW_TAG_TEXT]}>
				{(character, index) => (
					<span
						bold
						color={parseColor(
							`hsl(${Math.round(((index() / NEW_TAG_TEXT.length + phase) % 1) * 360)}, 95%, 60%)`,
						)}
					>
						{character}
					</span>
				)}
			</For>
		</>
	);
}

export interface WelcomeTipViewProps {
	readonly tip: string;
	readonly boxWidth: number;
	readonly phase?: number;
}

/** Wrapped welcome-tip rows, including the animated rainbow new-tip tag. */
export function WelcomeTipView(props: WelcomeTipViewProps): JSX.Element | null {
	const label = "Tip: ";
	const labelWidth = cellWidth(label);
	const bodyBudget = props.boxWidth - 1 - labelWidth;
	if (bodyBudget < 8) return null;
	const isNew = NEW_TIP_MARKER.test(props.tip);
	const body = replaceTabs(isNew ? props.tip.replace(NEW_TIP_MARKER, "") : props.tip);
	const rows = wrapPlain(body, bodyBudget);
	if (rows.length === 0) return null;
	const last = rows.length - 1;
	const appendTag = isNew && 1 + labelWidth + cellWidth(rows[last]!) + 1 + cellWidth(NEW_TAG_TEXT) <= props.boxWidth;
	return (
		<stack>
			<For each={rows}>
				{(row, index) => (
					<text wrap="none" italic>
						{" "}
						<Show when={index() === 0} fallback={" ".repeat(labelWidth)}>
							<span color="customMessageLabel">{label}</span>
						</Show>
						<span color="muted">{row}</span>
						<Show when={index() === last && appendTag}>
							{" "}
							<NewTag phase={props.phase ?? 0} />
						</Show>
					</text>
				)}
			</For>
			<Show when={isNew && !appendTag}>
				<text wrap="none" italic>
					{" ".repeat(1 + labelWidth)}
					<NewTag phase={props.phase ?? 0} />
				</text>
			</Show>
		</stack>
	);
}

export interface GradientLogoViewProps {
	readonly lines: readonly string[];
	readonly phase?: number;
	readonly shine?: ShineConfig;
}

function GradientLogoLine(props: {
	readonly line: string;
	readonly row: number;
	readonly rows: number;
	readonly phase?: number;
	readonly shine?: ShineConfig;
}): JSX.Element {
	const columns = Math.max(...PI_LOGO.map(line => line.length));
	const xSpan = Math.max(1, columns - 1);
	const ySpan = Math.max(1, props.rows - 1);
	const phase = (((props.phase ?? 0) % 1) + 1) % 1;
	return (
		<For each={[...props.line]}>
			{(character, column) => {
				if (character === " ") return character;
				const base = (column() / xSpan + props.row / ySpan) / 2;
				const position = phase === 0 ? base : (base + phase) % 1;
				return <span color={gradientColor(position, props.shine)}>{character}</span>;
			}}
		</For>
	);
}

/** Multi-line diagonal-gradient logo with an optional sliding shine band. */
export function GradientLogoView(props: GradientLogoViewProps): JSX.Element {
	return (
		<stack>
			<For each={props.lines}>
				{(line, row) => (
					<text wrap="none" align="center">
						<GradientLogoLine
							line={line}
							row={row()}
							rows={props.lines.length}
							phase={props.phase}
							shine={props.shine}
						/>
					</text>
				)}
			</For>
		</stack>
	);
}

interface LogoFrame {
	readonly phase: number;
	readonly shine?: ShineConfig;
}

function logoFrame(startedAt: number | undefined, now: number): LogoFrame {
	if (startedAt === undefined) return { phase: 0 };
	const progress = Math.max(0, Math.min(1, (now - startedAt) / INTRO_MS));
	if (progress >= 1) return { phase: 0 };
	const eased = 1 - (1 - progress) ** 3;
	return {
		phase: ((((1 - eased) * INTRO_SWEEPS) % 1) + 1) % 1,
		shine: {
			pos: (((progress * INTRO_SHINE_TRAVERSALS) % 1) + 1) % 1,
			strength: (1 - eased) ** 1.5,
		},
	};
}

function clippedPlain(text: string, width: number): string {
	if (width <= 0) return "";
	if (cellWidth(text) <= width) return text;
	if (width === 1) return "…";
	let shown = "";
	for (const character of text) {
		if (cellWidth(shown + character) > width - 1) break;
		shown += character;
	}
	return `${shown}…`;
}

function LeftRow(props: {
	readonly row: number;
	readonly modelName: string;
	readonly providerName: string;
	readonly logo: LogoFrame;
}): JSX.Element {
	if (props.row === 1)
		return (
			<text wrap="clip" align="center" bold>
				Welcome back!
			</text>
		);
	if (props.row >= 3 && props.row < 3 + PI_LOGO.length) {
		return (
			<text wrap="clip" align="center">
				<GradientLogoLine
					line={PI_LOGO[props.row - 3]!}
					row={props.row - 3}
					rows={PI_LOGO.length}
					phase={props.logo.phase}
					shine={props.logo.shine}
				/>
			</text>
		);
	}
	if (props.row === 9)
		return (
			<text wrap="clip" align="center" color="muted">
				{props.modelName}
			</text>
		);
	if (props.row === 10)
		return (
			<text wrap="clip" align="center" color="borderMuted">
				{props.providerName}
			</text>
		);
	return <text wrap="none" />;
}

function RightRow(props: {
	readonly row: number;
	readonly width: number;
	readonly lspServers: readonly LspServerInfo[];
	readonly recentSessions: readonly RecentSession[];
	readonly horizontal: string;
	readonly bullet: string;
	readonly symbol: (key: "status.enabled" | "status.pending" | "status.error") => string;
}): JSX.Element {
	const { row, width } = props;
	if (row === 0)
		return (
			<text wrap="clip">
				{" "}
				<span color="accent" bold>
					Tips
				</span>
			</text>
		);
	const hint =
		row === 1
			? ["#", " for prompt actions"]
			: row === 2
				? ["/", " for commands"]
				: row === 3
					? ["!", " to run bash"]
					: row === 4
						? ["$", " to run python"]
						: undefined;
	if (hint)
		return (
			<text wrap="clip">
				{" "}
				<span color="dim">{hint[0]}</span>
				<span color="muted">{hint[1]}</span>
			</text>
		);
	if (row === 5 || row === 11)
		return (
			<text wrap="none">
				{" "}
				<span color="dim">{props.horizontal.repeat(Math.max(0, width - 2))}</span>
			</text>
		);
	if (row === 6)
		return (
			<text wrap="clip">
				{" "}
				<span color="accent" bold>
					LSP Servers
				</span>
			</text>
		);
	if (row >= 7 && row < 7 + WELCOME_LSP_SLOTS) {
		const server = props.lspServers[row - 7];
		if (!server)
			return (
				<text wrap="clip" color="dim">
					{row === 7 && props.lspServers.length === 0 ? " No LSP servers" : ""}
				</text>
			);
		const indicator =
			server.status === "ready"
				? (["status.enabled", "success"] as const)
				: server.status === "available"
					? (["status.enabled", "dim"] as const)
					: server.status === "connecting"
						? (["status.pending", "muted"] as const)
						: (["status.error", "error"] as const);
		return (
			<text wrap="clip">
				{" "}
				<span color={indicator[1]}>{props.symbol(indicator[0])}</span> <span color="muted">{server.name}</span>{" "}
				<span color="dim">{server.fileTypes?.slice(0, 3).join(" ") ?? ""}</span>
			</text>
		);
	}
	if (row === 12)
		return (
			<text wrap="clip">
				{" "}
				<span color="accent" bold>
					Recent sessions
				</span>
			</text>
		);
	if (row >= 13 && row < 13 + WELCOME_SESSION_SLOTS) {
		const session = props.recentSessions[row - 13];
		if (!session)
			return (
				<text wrap="clip" color="dim">
					{row === 13 && props.recentSessions.length === 0 ? " No recent sessions" : ""}
				</text>
			);
		const prefix = ` ${props.bullet} `;
		const suffix = ` (${session.timeAgo})`;
		const nameBudget = Math.max(1, width - cellWidth(prefix) - cellWidth(suffix));
		return (
			<text wrap="clip">
				<span color="dim">{prefix}</span>
				<span color="muted">{clippedPlain(session.name, nameBudget)}</span>
				<span color="dim">{suffix}</span>
			</text>
		);
	}
	return <text wrap="none" />;
}

function WelcomeLayout(props: {
	readonly width: number;
	readonly data: WelcomeData;
	readonly tip: string | undefined;
	readonly logo: LogoFrame;
	readonly newTipPhase: number;
	readonly horizontal: string;
	readonly vertical: string;
	readonly topLeft: string;
	readonly topRight: string;
	readonly bottomLeft: string;
	readonly bottomRight: string;
	readonly teeUp: string;
	readonly bullet: string;
	readonly symbol: (key: "status.enabled" | "status.pending" | "status.error") => string;
}): JSX.Element | null {
	const boxWidth = Math.min(100, Math.max(0, props.width - 2));
	if (boxWidth < 4) return null;
	const dualContentWidth = boxWidth - 3;
	const minLeftColumn = 12;
	const minRightColumn = 20;
	const leftMinContentWidth = Math.max(minLeftColumn, cellWidth("Welcome back!"));
	const desiredLeftColumn = Math.max(
		Math.min(26, Math.max(minLeftColumn, Math.floor(dualContentWidth * 0.35))),
		leftMinContentWidth,
	);
	const dualLeftColumn =
		dualContentWidth >= minRightColumn + 1
			? Math.min(desiredLeftColumn, dualContentWidth - minRightColumn)
			: Math.max(1, dualContentWidth - 1);
	const dualRightColumn = Math.max(1, dualContentWidth - dualLeftColumn);
	const showRightColumn = dualLeftColumn >= leftMinContentWidth && dualRightColumn >= minRightColumn;
	const leftColumn = showRightColumn ? dualLeftColumn : boxWidth - 2;
	const rightColumn = showRightColumn ? dualRightColumn : 0;
	const title = ` ${APP_NAME} v${props.data.version} `;
	const titleSpace = boxWidth - 2;
	const titlePrefix = props.horizontal.repeat(3);
	const titleFits = cellWidth(titlePrefix) + cellWidth(title) < titleSpace;
	const rowCount = showRightColumn ? 18 : 11;
	return (
		<stack>
			<text width={boxWidth} wrap="none" color="dim">
				{props.topLeft}
				<Show
					when={titleFits}
					fallback={<span color="muted">{clippedPlain(`${titlePrefix}${title}`, titleSpace)}</span>}
				>
					{titlePrefix}
					<span color="muted">{title}</span>
					{props.horizontal.repeat(Math.max(0, titleSpace - cellWidth(titlePrefix) - cellWidth(title)))}
				</Show>
				{props.topRight}
			</text>
			<For each={Array.from({ length: rowCount }, (_, row) => row)}>
				{row => (
					<row width={boxWidth}>
						<text width={1} wrap="none" color="dim">
							{props.vertical}
						</text>
						<box width={leftColumn} shrink={0}>
							<LeftRow
								row={row}
								modelName={props.data.modelName}
								providerName={props.data.providerName}
								logo={props.logo}
							/>
						</box>
						<Show when={showRightColumn}>
							<text width={1} wrap="none" color="dim">
								{props.vertical}
							</text>
							<box width={rightColumn} shrink={0}>
								<RightRow
									row={row}
									width={rightColumn}
									lspServers={props.data.lspServers.slice(0, WELCOME_LSP_SLOTS)}
									recentSessions={props.data.recentSessions.slice(0, WELCOME_SESSION_SLOTS)}
									horizontal={props.horizontal}
									bullet={props.bullet}
									symbol={props.symbol}
								/>
							</box>
						</Show>
						<text width={1} wrap="none" color="dim">
							{props.vertical}
						</text>
					</row>
				)}
			</For>
			<text width={boxWidth} wrap="none" color="dim">
				{props.bottomLeft}
				{props.horizontal.repeat(leftColumn)}
				{showRightColumn ? props.teeUp + props.horizontal.repeat(rightColumn) : ""}
				{props.bottomRight}
			</text>
			<Show when={props.tip}>
				{(tip: () => string) => <WelcomeTipView tip={tip()} boxWidth={boxWidth} phase={props.newTipPhase} />}
			</Show>
		</stack>
	);
}

export interface WelcomeViewProps {
	readonly store: WelcomeStore;
}

/** Compact two-column startup welcome panel, driven by the root reactive clock. */
export function WelcomeView(props: WelcomeViewProps): JSX.Element {
	const now = useClock("frame");
	const theme = useTheme();
	const paint = createMemo(() => {
		const activeTheme = theme.theme();
		const symbols = activeTheme.boxRound;
		const startedAt = props.store.introStartedAt();
		const current = startedAt === undefined ? 0 : now();
		const data = props.store.data();
		const tip = props.store.tip();
		const logo = logoFrame(startedAt, current);
		const newTipPhase = startedAt !== undefined && NEW_TIP_MARKER.test(tip ?? "") ? current / NEW_GLOW_PERIOD_MS : 0;
		return (width: number) => (
			<WelcomeLayout
				width={width}
				data={data}
				tip={tip}
				logo={logo}
				newTipPhase={newTipPhase}
				horizontal={symbols.horizontal}
				vertical={symbols.vertical}
				topLeft={symbols.topLeft}
				topRight={symbols.topRight}
				bottomLeft={symbols.bottomLeft}
				bottomRight={symbols.bottomRight}
				teeUp={symbols.teeUp ?? "┴"}
				bullet={activeTheme.md.bullet}
				symbol={key => theme.symbol(key)}
			/>
		);
	});
	return <sized paint={paint()} />;
}

/** Block-grid brand mark shared by welcome and setup surfaces. */
export const PI_LOGO = ["████████████", "   ██  ██   ", "   ██  ██   ", "   ▒▒  ██   ", "       ██   "];

const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[248, 79, 204],
	[147, 98, 244],
	[0, 219, 228],
];
const GRADIENT_RAMP_256 = [206, 170, 134, 99, 69, 74, 44];
const SHINE_HALF_WIDTH = 0.18;

export interface ShineConfig {
	readonly strength: number;
	readonly pos: number;
}

/** Gradient foreground for a normalized diagonal position. */
export function gradientColor(t: number, shine?: ShineConfig): Color {
	const position = Math.max(0, Math.min(1, t));
	const strength = Math.max(0, shine?.strength ?? 0);
	const shineAmount = Math.max(0, 1 - Math.abs(position - (shine?.pos ?? 0)) / SHINE_HALF_WIDTH) * strength;
	if (TERMINAL.trueColor) {
		const segment = position * (GRADIENT_STOPS.length - 1);
		const index = Math.min(GRADIENT_STOPS.length - 2, Math.floor(segment));
		const fraction = segment - index;
		const from = GRADIENT_STOPS[index]!;
		const to = GRADIENT_STOPS[index + 1]!;
		return rgb(
			Math.round(
				from[0] + (to[0] - from[0]) * fraction + (255 - (from[0] + (to[0] - from[0]) * fraction)) * shineAmount,
			),
			Math.round(
				from[1] + (to[1] - from[1]) * fraction + (255 - (from[1] + (to[1] - from[1]) * fraction)) * shineAmount,
			),
			Math.round(
				from[2] + (to[2] - from[2]) * fraction + (255 - (from[2] + (to[2] - from[2]) * fraction)) * shineAmount,
			),
		);
	}
	let index = Math.min(GRADIENT_RAMP_256.length - 1, Math.round(position * (GRADIENT_RAMP_256.length - 1)));
	if (shineAmount > 0.5) index = GRADIENT_RAMP_256.length - 1;
	return ansi256(GRADIENT_RAMP_256[index]!);
}
