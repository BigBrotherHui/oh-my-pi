import { For, Show, type JSX, useClock, useTheme } from "../reactive";
import { shimmerEnabled } from "../theme/shimmer";
import type { ToolUIStatus } from "../host/elements/status";
import { replaceTabs } from "../utils";
import { registerToolView } from "./registry";
import { oneLineLabel } from "./task";
import type { ActivitySummary, DeepReadonly, ToolViewDefinition, ToolViewProps } from "./view";

/** Operation represented by a worker-session tool result. */
export type VibeOp = "spawn" | "send" | "wait" | "kill" | "list";

/** Details payload shared by every vibe tool for TUI rendering. */
export interface VibeToolDetails {
	op: VibeOp;
	/** Live TV-wall snapshot of the owner's worker sessions at (or during) the call. */
	screens: VibeScreenSnapshot[];
	spawned?: { id: string; cli: VibeCli; jobId: string };
	send?: VibeSendOutcome;
	wait?: {
		settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled" }>;
		stillRunning: string[];
		timedOut: boolean;
		/** True on interim progress emissions while the wait is still blocking. */
		waiting?: boolean;
	};
	killed?: VibeKillOutcome;
}

/** Worker session lifecycle as shown to the director. */
export type VibeSessionState = "starting" | "running" | "idle" | "dead";

/**
 * Live per-session "screen" for rich rendering: what the worker is doing right
 * now (tool trace, current tool, streamed text tail) plus roster metadata.
 * Every string is already one-line sanitized.
 */
export interface VibeScreenSnapshot {
	id: string;
	cli: VibeCli;
	state: VibeSessionState;
	model?: string;
	turns: number;
	queued: number;
	/** Start of the in-flight turn, when running. */
	turnStartedAt?: number;
	/** Gist of the message that started the in-flight turn. */
	turnMessage?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	/** Completed tool calls of the in-flight turn, oldest first (tail). */
	trace: readonly string[];
	/** Latest streamed worker text lines, oldest first. */
	outputTail: readonly string[];
	lastActivity?: string;
	lastActivityAt: number;
}

/** Worker identity and job handle returned by a spawn. */
export interface VibeSpawnOutcome {
	id: string;
	jobId: string;
}

/** Delivery mode and optional turn job for a worker message. */
export interface VibeSendOutcome {
	id: string;
	/**
	 * - `turn`: a new background turn was started (`jobId` set).
	 * - `steered`: worker was mid-turn and streaming; delivered as steering.
	 * - `queued`: worker was mid-turn but not steerable; drained into the next turn.
	 */
	mode: "turn" | "steered" | "queued";
	jobId?: string;
}

/** Worker shutdown outcome including any cancelled turn. */
export interface VibeKillOutcome {
	id: string;
	/** True when an in-flight turn job was cancelled along the way. */
	cancelledTurn: boolean;
}

/** Settled and still-running worker turns observed by a wait. */
export interface VibeWaitOutcome {
	/** Watched sessions whose snapshotted turn settled during (or before) the wait.
	 * May overlap `stillRunning` when a queued follow-up turn already started. */
	settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled"; resultText: string }>;
	/** Watched sessions with a turn in flight when the wait returned. */
	stillRunning: string[];
	timedOut: boolean;
}

/** The two worker CLI flavors the director drives. */
export type VibeCli = "fast" | "good";

export interface VibeRenderArgs {
	cli?: VibeCli;
	prompt?: string;
	name?: string;
	session?: string;
	message?: string;
	sessions?: string[];
}

const COMPOSER_LINE_MAX = 96;
const TV_LINE_MAX = 110;
const TV_TRACE_COLLAPSED = 2;
const TV_TRACE_EXPANDED = 6;
const TV_OUTPUT_COLLAPSED = 1;
const TV_OUTPUT_EXPANDED = 3;
const CURSOR_GLYPH = "▌";

interface StatusMeta {
	readonly text: string;
	readonly color: "accent" | "success" | "warning" | "dim";
}

type SettledStatus = "completed" | "failed" | "cancelled";
type VibeProps = ToolViewProps<VibeRenderArgs, VibeToolDetails>;

function stateToStatus(state: VibeSessionState): ToolUIStatus {
	switch (state) {
		case "running":
			return "running";
		case "starting":
			return "pending";
		case "idle":
			return "done";
		case "dead":
			return "aborted";
	}
}

function stateToColor(state: VibeSessionState): "accent" | "success" | "muted" {
	switch (state) {
		case "running":
		case "starting":
			return "accent";
		case "idle":
			return "success";
		case "dead":
			return "muted";
	}
}

function frameText(text: string, max: number): string {
	return oneLineLabel(replaceTabs(text), max);
}

function opFrom(toolName: string, args: VibeProps["args"], details: VibeOp | undefined): VibeOp {
	if (details !== undefined) return details;
	switch (toolName) {
		case "vibe_spawn":
			return "spawn";
		case "vibe_send":
			return "send";
		case "vibe_wait":
			return "wait";
		case "vibe_kill":
			return "kill";
		case "vibe_list":
			return "list";
		default:
			return args.session ? "send" : "list";
	}
}

function describeCall(op: VibeOp, args: VibeProps["args"]): string {
	switch (op) {
		case "spawn":
			return `spawn ${args.cli ?? "?"}${args.name ? ` · ${frameText(args.name, 40)}` : ""}`;
		case "send":
			return `send → ${args.session ? frameText(args.session, 40) : "?"}`;
		case "wait":
			return args.sessions?.length
				? `wait on ${frameText(args.sessions.join(", "), 60)}`
				: "wait on running sessions";
		case "kill":
			return `kill ${args.session ? frameText(args.session, 40) : "?"}`;
		case "list":
			return "sessions";
	}
}

/** Historical compact mini-terminal frame without a full-width outer card. */
function MiniFrame(props: {
	readonly header: () => JSX.Element;
	readonly footer?: () => JSX.Element | undefined;
	readonly children?: JSX.Element;
}): JSX.Element {
	const theme = useTheme();
	return (
		<stack>
			<text wrap="none" overflow="ellipsis">
				<span color="dim">
					{theme.symbol("boxRound.topLeft")}
					{theme.symbol("boxRound.horizontal")}{" "}
				</span>
				{props.header()}
			</text>
			{props.children}
			<Show
				when={props.footer?.()}
				fallback={
					<text wrap="none" overflow="ellipsis">
						<span color="dim">
							{theme.symbol("boxRound.bottomLeft")}
							{theme.symbol("boxRound.horizontal")}
						</span>
					</text>
				}
			>
				{(footer: () => JSX.Element) => (
					<text wrap="none" overflow="ellipsis">
						<span color="dim">
							{theme.symbol("boxRound.bottomLeft")}
							{theme.symbol("boxRound.horizontal")}{" "}
						</span>
						{footer()}
					</text>
				)}
			</Show>
		</stack>
	);
}

/** One indented line within a historical vibe mini-terminal. */
function VibeRail(props: { readonly children?: JSX.Element }): JSX.Element {
	const theme = useTheme();
	return (
		<text wrap="none" overflow="ellipsis">
			<span color="dim">{theme.symbol("boxRound.vertical")}</span> {props.children}
		</text>
	);
}

/** Status-header equivalent used by pre-frame wait/list/kill states. */
function VibeStatusLine(props: {
	readonly status: () => ToolUIStatus;
	readonly title: () => string;
	readonly meta?: () => readonly StatusMeta[];
}): JSX.Element {
	const theme = useTheme();
	const meta = () => props.meta?.() ?? [];
	return (
		<text wrap="none" overflow="ellipsis">
			<status value={props.status()} /> <span color="accent">{props.title()}</span>
			<For each={meta()}>
				{(entry, index) => (
					<>
						<span color="dim">{index() === 0 ? " " : theme.symbol("sep.dot")}</span>
						<span color={entry.color}>{entry.text}</span>
					</>
				)}
			</For>
		</text>
	);
}

function ComposerRows(props: {
	readonly message: () => string;
	readonly expanded: boolean;
	readonly cursor: boolean;
}): JSX.Element {
	const spinner = useClock("spinner");
	const rows = () => {
		const raw = props
			.message()
			.split(/\r?\n/u)
			.filter(line => line.trim().length > 0);
		const maxRows = props.expanded ? 6 : 2;
		const visible = raw.slice(0, maxRows).map(line => frameText(line, COMPOSER_LINE_MAX));
		if (visible.length === 0) visible.push("");
		const truncated = raw.length > maxRows;
		if (truncated) visible[visible.length - 1] = `${visible[visible.length - 1]} …`;
		return { lines: visible, truncated };
	};
	const cursorOn = () => (Math.floor(spinner() / 80) & 1) === 0;
	return (
		<For each={rows().lines}>
			{(line, index) => (
				<VibeRail>
					<span color="accent">{index() === 0 ? "> " : "  "}</span>
					<span color="toolOutput">{line}</span>
					<Show when={props.cursor && !rows().truncated && index() === rows().lines.length - 1 && cursorOn()}>
						<span color="accent">{CURSOR_GLYPH}</span>
					</Show>
				</VibeRail>
			)}
		</For>
	);
}

function VibeCall(props: {
	readonly op: VibeOp;
	readonly args: VibeProps["args"];
	readonly expanded: boolean;
}): JSX.Element {
	const composer = props.op === "spawn" || props.op === "send";
	const message = () => (props.op === "spawn" ? props.args.prompt : props.args.message) ?? "";
	return (
		<Show
			when={composer}
			fallback={
				<VibeStatusLine status={() => "pending"} title={() => `vibe ${describeCall(props.op, props.args)}`} />
			}
		>
			<MiniFrame
				header={() => <span color="muted">vibe {describeCall(props.op, props.args)}</span>}
				footer={() => <span color="dim">{props.op === "spawn" ? "booting CLI…" : "delivering…"}</span>}
			>
				<ComposerRows message={message} expanded={props.expanded} cursor />
			</MiniFrame>
		</Show>
	);
}

function settledStatusFor(status: SettledStatus | undefined, state: VibeSessionState): ToolUIStatus {
	if (status === "failed") return "error";
	if (status === "cancelled") return "aborted";
	return stateToStatus(state);
}

/** Render one live worker "TV": status line, live tools, streamed tail, and completion footer. */
function VibeScreen(props: {
	readonly screen: DeepReadonly<VibeScreenSnapshot>;
	readonly expanded: boolean;
	readonly settledStatus?: SettledStatus;
}): JSX.Element {
	const theme = useTheme();
	const now = useClock("spinner");
	const screen = () => props.screen;
	const live = () => screen().state === "running" || screen().state === "starting";
	const trace = () => screen().trace.slice(-(props.expanded ? TV_TRACE_EXPANDED : TV_TRACE_COLLAPSED));
	const output = () => screen().outputTail.slice(-(props.expanded ? TV_OUTPUT_EXPANDED : TV_OUTPUT_COLLAPSED));
	const currentToolLabel = () => {
		const current = screen().currentTool;
		if (!current) return "";
		const detail = screen().lastIntent ?? screen().currentToolArgs;
		return frameText(`${current}${detail ? `: ${detail}` : ""}`, TV_LINE_MAX);
	};
	const elapsed = () => Math.max(0, now() - (screen().turnStartedAt ?? now()));
	const footer = () => {
		switch (props.settledStatus) {
			case "completed":
				return <span color="success">turn completed — result delivered</span>;
			case "failed":
				return <span color="error">turn failed — result delivered</span>;
			case "cancelled":
				return <span color="warning">turn cancelled — result delivered</span>;
			default:
				return undefined;
		}
	};
	return (
		<MiniFrame
			header={() => (
				<>
					<status value={settledStatusFor(props.settledStatus, screen().state)} />{" "}
					<badge color={stateToColor(screen().state)}>{screen().cli}</badge>{" "}
					<Show
						when={live() && shimmerEnabled()}
						fallback={<span color={live() ? "accent" : "toolOutput"}>{screen().id}</span>}
					>
						<shimmer>{screen().id}</shimmer>
					</Show>{" "}
					<span color="dim">{props.settledStatus ?? screen().state}</span>{" "}
					<span color="muted">
						{screen().turns}t{screen().queued > 0 ? `+${screen().queued}q` : ""}
					</span>
					<Show when={screen().turnStartedAt !== undefined}>
						{" "}
						<duration ms={elapsed()} />
					</Show>
					<Show when={screen().model}>
						{" "}
						<span color="muted">{frameText(screen().model!, 40)}</span>
					</Show>
				</>
			)}
			footer={footer}
		>
			<Show when={live() && screen().turnMessage}>
				<VibeRail>
					<span color="accent">&gt; </span>
					<span color="dim">{frameText(screen().turnMessage!, TV_LINE_MAX)}</span>
				</VibeRail>
			</Show>
			<Show when={live()}>
				<For each={trace()}>
					{line => (
						<VibeRail>
							<span color="dim">
								{theme.symbol("tree.hook")} {frameText(line, TV_LINE_MAX)}
							</span>
						</VibeRail>
					)}
				</For>
				<Show
					when={screen().currentTool}
					fallback={
						<Show when={screen().lastIntent}>
							<VibeRail>
								<span color="accent">{theme.symbol("tree.hook")}</span>{" "}
								<span color="muted">{frameText(screen().lastIntent!, TV_LINE_MAX)}</span>
							</VibeRail>
						</Show>
					}
				>
					<VibeRail>
						<span color="accent">{theme.symbol("tree.hook")}</span>{" "}
						<Show when={shimmerEnabled()} fallback={<span color="muted">{currentToolLabel()}</span>}>
							<shimmer>{currentToolLabel()}</shimmer>
						</Show>
					</VibeRail>
				</Show>
				<For each={output()}>
					{line => (
						<Show when={line.trim().length > 0}>
							<VibeRail>
								<span color="muted"> {frameText(line, TV_LINE_MAX)}</span>
							</VibeRail>
						</Show>
					)}
				</For>
			</Show>
			<Show when={!live() && screen().lastActivity}>
				<VibeRail>
					<span color="dim">{theme.symbol("tree.hook")}</span>{" "}
					<span color="muted">{frameText(screen().lastActivity!, TV_LINE_MAX)}</span>
				</VibeRail>
			</Show>
		</MiniFrame>
	);
}

function VibeWall(props: {
	readonly op: VibeOp;
	readonly details: DeepReadonly<VibeToolDetails>;
	readonly expanded: boolean;
}): JSX.Element {
	const details = () => props.details;
	const running = () =>
		details().screens.filter(screen => screen.state === "running" || screen.state === "starting").length;
	const settledById = () => {
		const statuses = new Map<string, SettledStatus>();
		for (const entry of details().wait?.settled ?? []) statuses.set(entry.id, entry.status);
		return statuses;
	};
	const meta = (): readonly StatusMeta[] => {
		const values: StatusMeta[] = [];
		if (running() > 0) values.push({ text: `${running()} on air`, color: "accent" });
		if (settledById().size > 0) values.push({ text: `${settledById().size} settled`, color: "success" });
		if (details().wait?.timedOut) values.push({ text: "timed out", color: "warning" });
		return values;
	};
	const title = () =>
		props.op === "wait"
			? details().wait?.waiting
				? "vibe wait — watching the wall"
				: "vibe wait"
			: `vibe sessions (${details().screens.length})`;
	return (
		<stack>
			<VibeStatusLine
				status={() => (details().wait?.timedOut ? "warning" : running() > 0 ? "info" : "done")}
				title={title}
				meta={meta}
			/>
			<For each={details().screens}>
				{screen => (
					<VibeScreen screen={screen} expanded={props.expanded} settledStatus={settledById().get(screen.id)} />
				)}
			</For>
		</stack>
	);
}

function VibeFallback(props: {
	readonly op: VibeOp;
	readonly args: VibeProps["args"];
	readonly source: VibeProps;
}): JSX.Element {
	const output = () => props.source.output.text();
	return (
		<stack>
			<VibeStatusLine
				status={() =>
					props.source.outcome === "failed"
						? "error"
						: props.source.outcome === "cancelled"
							? "aborted"
							: props.source.outcome === "timed_out"
								? "warning"
								: "done"
				}
				title={() => `vibe ${describeCall(props.op, props.args)}`}
			/>
			<Show when={output()}>
				<text color={props.source.outcome === "failed" ? "error" : "dim"} wrap="none" overflow="ellipsis">
					{"  "}
					{frameText(output(), TV_LINE_MAX)}
				</text>
			</Show>
		</stack>
	);
}

function VibeResult(props: {
	readonly op: VibeOp;
	readonly args: VibeProps["args"];
	readonly details: DeepReadonly<VibeToolDetails>;
	readonly expanded: boolean;
	readonly source: VibeProps;
}): JSX.Element {
	const details = () => props.details;
	if (props.op === "spawn" || props.op === "send") {
		const message = () => (props.op === "spawn" ? props.args.prompt : props.args.message) ?? "";
		const header = () =>
			props.op === "spawn" ? (
				<>
					<span color="muted">vibe spawn</span>{" "}
					<badge color="accent">{details().spawned?.cli ?? props.args.cli ?? "?"}</badge>{" "}
					<span color="accent">{frameText(details().spawned?.id ?? props.args.name ?? "", 40)}</span>
				</>
			) : (
				<>
					<span color="muted">vibe send →</span>{" "}
					<span color="accent">{frameText(props.args.session ?? "?", 40)}</span>
				</>
			);
		const acknowledgement = () => {
			if (props.op === "spawn") {
				const jobId = details().spawned?.jobId;
				return <span color="success">turn started{jobId ? ` (job ${jobId})` : ""}</span>;
			}
			switch (details().send?.mode) {
				case "steered":
					return <span color="success">steered into the running turn</span>;
				case "queued":
					return <span color="warning">mid-turn — queued as the next turn</span>;
				default: {
					const jobId = details().send?.jobId;
					return <span color="success">turn started{jobId ? ` (job ${jobId})` : ""}</span>;
				}
			}
		};
		return (
			<MiniFrame header={header} footer={acknowledgement}>
				<ComposerRows message={message} expanded={props.expanded} cursor={false} />
			</MiniFrame>
		);
	}

	if (props.op === "kill") {
		const id = () => details().killed?.id ?? props.args.session ?? "?";
		const cancelled = () => details().killed?.cancelledTurn === true;
		return (
			<VibeStatusLine
				status={() => "done"}
				title={() => `vibe kill ${frameText(id(), 40)}${cancelled() ? " (in-flight turn cancelled)" : ""}`}
			/>
		);
	}

	const fallback = () => props.source.output.text() || "no sessions";
	return (
		<Show
			when={details().screens.length === 0}
			fallback={<VibeWall op={props.op} details={props.details} expanded={props.expanded} />}
		>
			<VibeStatusLine
				status={() => "warning"}
				title={() => `vibe ${props.op}`}
				meta={() => [{ text: frameText(fallback(), 60), color: "dim" }]}
			/>
		</Show>
	);
}

/** Reactive presentation for all worker-session tools. */
export function VibeView(props: VibeProps): JSX.Element {
	const op = () => opFrom(props.toolName, props.args, props.details?.op);
	const isTerminalFallback = () => props.phase === "settled";
	return (
		<Show
			when={props.details}
			fallback={
				<Show
					when={isTerminalFallback()}
					fallback={<VibeCall op={op()} args={props.args} expanded={props.ui.expanded} />}
				>
					<VibeFallback op={op()} args={props.args} source={props} />
				</Show>
			}
		>
			{(details: () => DeepReadonly<VibeToolDetails>) => (
				<Show
					when={props.outcome !== "failed"}
					fallback={<VibeFallback op={op()} args={props.args} source={props} />}
				>
					<VibeResult
						op={op()}
						args={props.args}
						details={details()}
						expanded={props.ui.expanded}
						source={props}
					/>
				</Show>
			)}
		</Show>
	);
}

function vibeSummary(props: VibeProps): ActivitySummary {
	const op = opFrom(props.toolName, props.args, props.details?.op);
	return {
		label: props.label || "vibe",
		detail: op,
		status:
			props.outcome === "failed"
				? "error"
				: props.outcome === "cancelled"
					? "aborted"
					: props.outcome === "timed_out"
						? "warning"
						: props.phase === "settled"
							? "done"
							: props.phase === "receiving" || props.phase === "queued"
								? "pending"
								: "running",
	};
}

export const vibeToolView: ToolViewDefinition<VibeRenderArgs, VibeToolDetails> = {
	view: props => <VibeView {...props} />,
	summary: vibeSummary,
	framed: true,
};

registerToolView("vibe", vibeToolView);
registerToolView("vibe_spawn", vibeToolView);
registerToolView("vibe_send", vibeToolView);
registerToolView("vibe_wait", vibeToolView);
registerToolView("vibe_kill", vibeToolView);
registerToolView("vibe_list", vibeToolView);
