import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { batch, createSignal, For, type JSX, useClock } from "../reactive";
import type { TUI } from "../tui";
import { replaceTabs } from "../render/render-utils";
import type { ThemeColor } from "../theme/schema";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { SizeValue } from "../tui";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import {
	CleanseBoardModel,
	cleanseErrorPreview,
	compactCleanseAssignmentFiles,
	type CleanseAgentTotals,
	type CleanseAgentOutcome,
	type CleanseAssignment,
	type CleanseBoardSnapshot,
	type CleanseCheckerDescriptor,
	type CleanseCheckResult,
	type CleanseRunningAgent,
	type CleanseRunningChecker,
} from "../apps/cleanse-board";
import type { AgentProgress } from "../tools/task";

const MAX_LOG_LINES = 14;

export type CleansePanelRunStatus = "clean" | "unresolved" | "unsupported" | "cancelled";
export type CleansePanelOutcome = CleansePanelRunStatus | "error";

export interface CleansePanelOptions {
	readonly request?: string;
}

interface CleansePanelState {
	readonly logLines: readonly CleanseLogLine[];
	readonly outcome?: CleansePanelOutcome;
	readonly errorMessage?: string;
	readonly liveClosed: boolean;
}

export type CleanseLogLine =
	| {
			readonly text: string;
			readonly tone?: ThemeColor;
	  }
	| { readonly view: JSX.Element }
	| {
			readonly check: CleanseCheckResult;
			readonly durationMs: number;
	  }
	| {
			readonly outcome: CleanseAgentOutcome;
			readonly assignment: CleanseAssignment;
			readonly agent?: CleanseRunningAgent;
			readonly total?: CleanseAgentTotals;
			readonly durationMs?: number;
	  };

export interface CleanseFooter {
	readonly text: string;
	readonly tone: ThemeColor;
	readonly icon?: "status.success" | "status.warning" | "status.error";
}

export interface CleansePanelViewProps {
	readonly title: string;
	readonly logLines: readonly CleanseLogLine[];
	readonly liveView?: JSX.Element;
	readonly errorMessage?: string;
	readonly footer: CleanseFooter;
}

function formatCost(cost: number): string {
	return `$${cost >= 0.095 ? cost.toFixed(2) : cost.toFixed(3)}`;
}

function agentActivity(progress: AgentProgress | undefined): JSX.Element {
	if (!progress) return <span color="dim">starting</span>;
	if (progress.retryState) {
		return (
			<span color="warning">
				rate-limited · retry {progress.retryState.attempt}/{progress.retryState.maxAttempts}
			</span>
		);
	}
	const intent = sanitizeDisplaySingleLine(progress.lastIntent ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (progress.currentTool) {
		const args = sanitizeDisplaySingleLine(progress.currentToolArgs ?? "")
			.replace(/\s+/g, " ")
			.trim();
		return (
			<>
				{intent ? `${intent} ` : ""}
				<span color="dim">{args ? `${progress.currentTool} ${args}` : progress.currentTool}</span>
			</>
		);
	}
	return intent ? <>{intent}</> : <span color="dim">thinking</span>;
}

function CleanseCheckerVerdictView(props: {
	readonly check: CleanseCheckResult;
	readonly durationMs: number;
}): JSX.Element {
	const count = props.check.diagnostics.length;
	const tone: ThemeColor = count === 0 ? "success" : "warning";
	return (
		<text wrap="word">
			<span color={tone}>{count === 0 ? "✓" : "●"}</span>
			{` ${props.check.label} `}
			<span color={tone}>{count === 0 ? "clean" : `${count} issue${count === 1 ? "" : "s"}`}</span>
			<span color="dim"> · {formatDuration(props.durationMs)}</span>
		</text>
	);
}

function CleanseAgentOutcomeView(props: {
	readonly outcome: CleanseAgentOutcome;
	readonly assignment: CleanseAssignment;
	readonly agent?: CleanseRunningAgent;
	readonly total?: CleanseAgentTotals;
	readonly durationMs?: number;
}): JSX.Element {
	const files = compactCleanseAssignmentFiles(props.assignment);
	if (!props.outcome.success) {
		const message = cleanseErrorPreview(props.outcome.error);
		return (
			<text wrap="word">
				<span color="error">✗</span>
				{` ${props.outcome.name} ${files} `}
				<span color="error">{message}</span>
			</text>
		);
	}
	const meta: string[] = [];
	const toolCount = props.agent?.progress?.toolCount ?? 0;
	if (toolCount > 0) meta.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
	if (props.total && props.total.tokens > 0) meta.push(`${formatNumber(props.total.tokens)} tok`);
	if (props.durationMs !== undefined) meta.push(formatDuration(props.durationMs));
	return (
		<text wrap="word">
			<span color="success">✓</span>
			{` ${props.outcome.name} ${files}`}
			{meta.length > 0 ? <span color="dim"> · {meta.join(" · ")}</span> : null}
		</text>
	);
}

function CleanseLogLineView(props: { readonly line: CleanseLogLine }): JSX.Element {
	const line = props.line;
	if ("view" in line) return <stack>{line.view}</stack>;
	if ("check" in line) return <CleanseCheckerVerdictView check={line.check} durationMs={line.durationMs} />;
	if ("outcome" in line) {
		return (
			<CleanseAgentOutcomeView
				outcome={line.outcome}
				assignment={line.assignment}
				agent={line.agent}
				total={line.total}
				durationMs={line.durationMs}
			/>
		);
	}
	return (
		<text color={line.tone} wrap="word">
			{replaceTabs(line.text)}
		</text>
	);
}

function RepairHeaderView(props: {
	readonly total: number;
	readonly done: number;
	readonly running: number;
	readonly totals: ReadonlyMap<string, CleanseAgentTotals>;
	readonly startedAt: number;
	readonly now: number;
}): JSX.Element {
	let tokens = 0;
	let cost = 0;
	for (const entry of props.totals.values()) {
		tokens += entry.tokens;
		cost += entry.cost;
	}
	const parts = [`${props.done}/${props.total}`];
	if (props.running > 0) parts.push(`${props.running} running`);
	if (tokens > 0) parts.push(`${formatNumber(tokens)} tok`);
	if (cost > 0) parts.push(formatCost(cost));
	parts.push(formatDuration(props.now - props.startedAt));
	return (
		<stack>
			<text wrap="word">
				<span color="accent">
					<spinner type="activity" />
				</span>
				{" Repairing "}
				<For each={parts}>
					{(part, index) => (
						<>
							{index() > 0 ? <span color="dim"> · </span> : null}
							{part}
						</>
					)}
				</For>
			</text>
			<progress min={0} max={props.total} value={props.done} />
		</stack>
	);
}

function RunningCheckerView(props: { readonly checker: CleanseRunningChecker; readonly now: number }): JSX.Element {
	return (
		<text wrap="word">
			<span color="warning">
				<spinner type="activity" />
			</span>
			{` ${props.checker.label} `}
			<span color="dim">· {formatDuration(props.now - props.checker.startedAt)}</span>
		</text>
	);
}

function RunningAgentView(props: {
	readonly name: string;
	readonly agent: CleanseRunningAgent;
	readonly now: number;
}): JSX.Element {
	const label = props.name.replace(/^Cleanse/, "");
	const toolCount = props.agent.progress?.toolCount ?? 0;
	return (
		<text wrap="word">
			<span color="warning">
				<spinner type="activity" />
			</span>{" "}
			<span bold>{label}</span>
			{` ${compactCleanseAssignmentFiles(props.agent.assignment)} `}
			<span color="dim">·</span> {agentActivity(props.agent.progress)}{" "}
			<span color="dim">
				· {toolCount > 0 ? `${toolCount} tool${toolCount === 1 ? "" : "s"} · ` : ""}
				{formatDuration(props.now - props.agent.startedAt)}
			</span>
		</text>
	);
}

function CleanseLiveView(props: { readonly state: CleanseBoardSnapshot }): JSX.Element {
	const now = useClock("spinner");
	const checkers = () => [...props.state.checkers.entries()];
	const agents = () =>
		[...props.state.agents.entries()].sort((left, right) => left[1].assignment.index - right[1].assignment.index);
	return (
		<stack>
			{props.state.phaseText ? (
				<text wrap="word">
					<span color="warning">
						<spinner type="activity" />
					</span>{" "}
					{props.state.phaseText}
				</text>
			) : null}
			<For each={checkers()}>{([, checker]) => <RunningCheckerView checker={checker} now={now()} />}</For>
			{props.state.repairTotal > 0 ? (
				<RepairHeaderView
					total={props.state.repairTotal}
					done={props.state.repairDone}
					running={props.state.agents.size}
					totals={props.state.totals}
					startedAt={props.state.repairStartedAt}
					now={now()}
				/>
			) : null}
			<For each={agents()}>{([name, agent]) => <RunningAgentView name={name} agent={agent} now={now()} />}</For>
		</stack>
	);
}

export function CleansePanelView(props: CleansePanelViewProps): JSX.Element {
	return (
		<frame title={props.title} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<stack>
				<br />
				{props.logLines.length > 0 ? (
					<stack>
						<For each={props.logLines}>{line => <CleanseLogLineView line={line} />}</For>
						<br />
					</stack>
				) : null}
				{props.liveView ? (
					<stack>
						{props.liveView}
						<br />
					</stack>
				) : null}
				{props.errorMessage ? (
					<stack>
						<text color="error" wrap="word">
							{replaceTabs(props.errorMessage)}
						</text>
						<br />
					</stack>
				) : null}
				<text color={props.footer.tone} wrap="word">
					{props.footer.icon ? (
						<>
							<icon name={props.footer.icon} />{" "}
						</>
					) : null}
					{props.footer.text}
				</text>
			</stack>
		</frame>
	);
}

export interface CleansePanelHandle extends OverlayDisposer {
	readonly interactive: true;
	log(text: string): void;
	logError(text: string): void;
	phase(text: string | undefined): void;
	checkerStarted(checker: CleanseCheckerDescriptor): void;
	checkerFinished(check: CleanseCheckResult, durationMs: number): void;
	repairFinished(): void;
	agentStarted(name: string, assignment: CleanseAssignment): void;
	agentProgress(name: string, progress: AgentProgress): void;
	agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void;
	close(): void;
	finish(outcome: CleansePanelRunStatus): void;
	error(message: string): void;
}

export interface CleansePanelProps {
	readonly title: string;
	readonly logLines: readonly CleanseLogLine[];
	readonly liveView?: JSX.Element;
	readonly errorMessage?: string;
	readonly footer: CleanseFooter;
	readonly width?: SizeValue;
}

export function CleansePanel(props: CleansePanelProps): JSX.Element {
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<box tabIndex={0}>
				<CleansePanelView
					title={props.title}
					logLines={props.logLines}
					liveView={props.liveView}
					errorMessage={props.errorMessage}
					footer={props.footer}
				/>
			</box>
		</Portal>
	);
}

function appendLog(lines: readonly CleanseLogLine[], line: CleanseLogLine): readonly CleanseLogLine[] {
	return lines.length < MAX_LOG_LINES ? [...lines, line] : [...lines.slice(1), line];
}

function footerFor(outcome: CleansePanelOutcome | undefined): CleanseFooter {
	switch (outcome) {
		case undefined:
			return { text: "Esc cancel /cleanse", tone: "muted" };
		case "clean":
			return { text: "Clean · Esc dismiss", tone: "success", icon: "status.success" };
		case "unresolved":
			return { text: "Diagnostics remain · Esc dismiss", tone: "warning", icon: "status.warning" };
		case "unsupported":
			return { text: "No runnable checker · Esc dismiss", tone: "warning", icon: "status.warning" };
		case "cancelled":
			return { text: "Cancelled · Esc dismiss", tone: "warning", icon: "status.warning" };
		case "error":
			return { text: "Error · Esc dismiss", tone: "error", icon: "status.error" };
	}
}

/** Open the cleanse panel overlay on a TUI instance, returning a controller handle. */
export function openCleansePanel(
	tui: TUI,
	options: CleansePanelOptions,
	opts?: { width?: SizeValue },
): CleansePanelHandle {
	const title = options.request ? `/cleanse ${replaceTabs(options.request)}` : "/cleanse";
	const model = new CleanseBoardModel();
	const [state, setState] = createSignal<CleansePanelState>({
		logLines: [],
		liveClosed: false,
	});

	const disposer = mountOverlay(tui, () => {
		const current = state();
		return (
			<CleansePanel
				title={title}
				logLines={current.logLines}
				liveView={
					current.liveClosed || !model.hasLiveRows() ? undefined : <CleanseLiveView state={model.snapshot()} />
				}
				errorMessage={current.errorMessage}
				footer={footerFor(current.outcome)}
				width={opts?.width}
			/>
		);
	});

	return Object.assign(disposer, {
		interactive: true as const,
		log(text: string): void {
			setState(previous => ({ ...previous, logLines: appendLog(previous.logLines, { text }) }));
		},
		logError(text: string): void {
			setState(previous => ({ ...previous, logLines: appendLog(previous.logLines, { text, tone: "error" }) }));
		},
		phase(text: string | undefined): void {
			model.phase(text);
		},
		checkerStarted(checker: CleanseCheckerDescriptor): void {
			model.checkerStarted(checker);
		},
		checkerFinished(check: CleanseCheckResult, durationMs: number): void {
			batch(() => {
				model.checkerFinished(check, durationMs);
				setState(previous => ({
					...previous,
					logLines: appendLog(previous.logLines, { check, durationMs }),
				}));
			});
		},
		repairFinished(): void {
			model.repairFinished();
		},
		agentStarted(name: string, assignment: CleanseAssignment): void {
			model.agentStarted(name, assignment);
		},
		agentProgress(name: string, progress: AgentProgress): void {
			model.agentProgress(name, progress);
		},
		agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void {
			batch(() => {
				const completion = model.agentFinished(outcome, assignment);
				setState(previous => ({
					...previous,
					logLines: appendLog(previous.logLines, completion),
				}));
			});
		},
		close(): void {
			setState(previous => (previous.liveClosed ? previous : { ...previous, liveClosed: true }));
		},
		finish(outcome: CleansePanelRunStatus): void {
			setState(previous => ({ ...previous, outcome, liveClosed: true }));
		},
		error(message: string): void {
			setState(previous => ({ ...previous, outcome: "error", errorMessage: message, liveClosed: true }));
		},
	});
}
