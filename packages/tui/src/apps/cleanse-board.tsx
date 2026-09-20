import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { matchesKey } from "../keys";
import { onMount, createSignal, For, type Accessor, type JSX, type Setter, useClock, useFocus } from "../reactive";
import { render, type RootHandle } from "../root";
import { ProcessTerminal, type Terminal } from "../terminal";
import { loadThemeSync } from "../theme/loader";
import { theme } from "../theme/theme";
import { sanitizeDisplaySingleLine } from "../overlays/extensions/display-text";
import type { HostKeyEvent } from "../host/input";
import type { AgentProgress } from "../tools/task";

export interface CleanseCheckerDescriptor {
	readonly id: string;
	readonly label: string;
}

export interface CleanseCheckResult extends CleanseCheckerDescriptor {
	readonly diagnostics: readonly unknown[];
}

export interface CleanseAssignment {
	readonly index: number;
	readonly groups: readonly { readonly file?: string }[];
	readonly weight: number;
}

export interface CleanseAgentOutcome {
	readonly name: string;
	readonly success: boolean;
	readonly error?: string;
	readonly resolvedModel?: string;
}

export interface CleanseRunningChecker {
	readonly label: string;
	readonly startedAt: number;
}

export interface CleanseRunningAgent {
	readonly assignment: CleanseAssignment;
	readonly startedAt: number;
	readonly progress?: AgentProgress;
}

export interface CleanseAgentTotals {
	readonly tokens: number;
	readonly cost: number;
}

/** Permanent data promoted from a finished agent's live row. */
export interface CleanseAgentCompletion {
	readonly outcome: CleanseAgentOutcome;
	readonly assignment: CleanseAssignment;
	readonly agent: CleanseRunningAgent | undefined;
	readonly total: CleanseAgentTotals | undefined;
	readonly durationMs: number | undefined;
}

export type CleanseBoardLogEntry =
	| { readonly id: number; readonly kind: "text"; readonly text: string; readonly tone?: "error" }
	| { readonly id: number; readonly kind: "check"; readonly check: CleanseCheckResult; readonly durationMs: number }
	| { readonly id: number; readonly kind: "agent"; readonly completion: CleanseAgentCompletion };

/** Read-only live state shared by the CLI reporter and the interactive panel. */
export interface CleanseBoardSnapshot {
	readonly phaseText: string | undefined;
	readonly checkers: ReadonlyMap<string, CleanseRunningChecker>;
	readonly agents: ReadonlyMap<string, CleanseRunningAgent>;
	/** Lifetime totals; entries remain after their live row completes. */
	readonly totals: ReadonlyMap<string, CleanseAgentTotals>;
	readonly repairTotal: number;
	readonly repairDone: number;
	readonly repairStartedAt: number;
	readonly logs: readonly CleanseBoardLogEntry[];
	readonly closed: boolean;
}

/**
 * Shared live-run domain model for `/cleanse`.
 *
 * The model is the single reactive source for retained standalone rows. The
 * overlay consumes the same mutators while retaining its own bounded panel
 * scrollback presentation.
 */
export class CleanseBoardModel {
	#phaseText: string | undefined;
	readonly #checkers = new Map<string, CleanseRunningChecker>();
	readonly #agents = new Map<string, CleanseRunningAgent>();
	readonly #totals = new Map<string, CleanseAgentTotals>();
	readonly #logs: CleanseBoardLogEntry[] = [];
	#repairTotal = 0;
	#repairDone = 0;
	#repairStartedAt = 0;
	#nextLogId = 1;
	#closed = false;
	readonly #revision: Accessor<number>;
	readonly #setRevision: Setter<number>;

	constructor() {
		const [revision, setRevision] = createSignal(0);
		this.#revision = revision;
		this.#setRevision = setRevision;
	}

	/** Read the current reactive live state without copying it into a view. */
	snapshot(): CleanseBoardSnapshot {
		this.#revision();
		return {
			phaseText: this.#phaseText,
			checkers: this.#checkers,
			agents: this.#agents,
			totals: this.#totals,
			repairTotal: this.#repairTotal,
			repairDone: this.#repairDone,
			repairStartedAt: this.#repairStartedAt,
			logs: this.#logs,
			closed: this.#closed,
		};
	}

	hasLiveRows(): boolean {
		this.#revision();
		return Boolean(this.#phaseText) || this.#checkers.size > 0 || this.#repairTotal > 0;
	}

	log(text: string, tone?: "error"): void {
		if (this.#closed) return;
		this.#logs.push({ id: this.#nextLogId++, kind: "text", text, tone });
		this.#notify();
	}

	phase(text: string | undefined): void {
		if (this.#closed || this.#phaseText === text) return;
		this.#phaseText = text;
		this.#notify();
	}

	checkerStarted(checker: CleanseCheckerDescriptor): void {
		if (this.#closed) return;
		this.#checkers.set(checker.id, { label: checker.label, startedAt: Date.now() });
		this.#notify();
	}

	/** Remove a transient checker row and promote its verdict to scrollback. */
	checkerFinished(check: CleanseCheckResult, durationMs = 0): void {
		if (this.#closed) return;
		this.#checkers.delete(check.id);
		this.#logs.push({ id: this.#nextLogId++, kind: "check", check, durationMs });
		this.#notify();
	}

	/** End the repair phase and remove its transient rows before verification. */
	repairFinished(): void {
		if (this.#closed || (this.#repairTotal === 0 && this.#repairDone === 0 && this.#agents.size === 0)) return;
		this.#repairTotal = 0;
		this.#repairDone = 0;
		this.#agents.clear();
		this.#notify();
	}

	agentStarted(name: string, assignment: CleanseAssignment): void {
		if (this.#closed) return;
		const now = Date.now();
		if (this.#repairStartedAt === 0) this.#repairStartedAt = now;
		this.#repairTotal += 1;
		this.#agents.set(name, { assignment, startedAt: now });
		this.#notify();
	}

	agentProgress(name: string, progress: AgentProgress): void {
		if (this.#closed) return;
		this.#totals.set(name, { tokens: progress.tokens, cost: progress.cost });
		const agent = this.#agents.get(name);
		if (agent) this.#agents.set(name, { ...agent, progress });
		this.#notify();
	}

	/** Remove a transient agent row and promote the completion to scrollback. */
	agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): CleanseAgentCompletion {
		const agent = this.#agents.get(outcome.name);
		const completion: CleanseAgentCompletion = {
			outcome,
			assignment,
			agent,
			total: this.#totals.get(outcome.name),
			durationMs: agent ? Date.now() - agent.startedAt : undefined,
		};
		if (this.#closed) return completion;
		this.#agents.delete(outcome.name);
		this.#repairDone = Math.min(this.#repairDone + 1, this.#repairTotal);
		this.#logs.push({ id: this.#nextLogId++, kind: "agent", completion });
		this.#notify();
		return completion;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#notify();
	}

	#notify(): void {
		this.#setRevision(revision => revision + 1);
	}
}

/** Single compact destination used by the live and completed repair rows. */
export function compactCleanseAssignmentFiles(assignment: CleanseAssignment): string {
	const files = assignment.groups.map(group => group.file ?? "<project>");
	const first = files[0] ?? "<project>";
	return files.length > 1 ? `${first} +${files.length - 1}` : first;
}

/** Normalize failure text; the native wrapping row owns viewport fitting. */
export function cleanseErrorPreview(error: string | undefined): string {
	return sanitizeDisplaySingleLine(error ?? "subagent failed")
		.replace(/\s+/g, " ")
		.trim();
}

function formatCost(cost: number): string {
	return `$${cost >= 0.095 ? cost.toFixed(2) : cost.toFixed(3)}`;
}

function checkerVerdict(check: CleanseCheckResult, durationMs: number): string {
	const count = check.diagnostics.length;
	return `${count === 0 ? "✓" : "●"} ${check.label} ${count === 0 ? "clean" : `${count} issue${count === 1 ? "" : "s"}`} · ${formatDuration(durationMs)}`;
}

function CleanseCheckLogView(props: { readonly check: CleanseCheckResult; readonly durationMs: number }): JSX.Element {
	const count = props.check.diagnostics.length;
	const tone = count === 0 ? "success" : "warning";
	return (
		<text wrap="word">
			<span color={tone}>{count === 0 ? "✓" : "●"}</span>
			{` ${props.check.label} `}
			<span color={tone}>{count === 0 ? "clean" : `${count} issue${count === 1 ? "" : "s"}`}</span>
			<span color="dim"> · {formatDuration(props.durationMs)}</span>
		</text>
	);
}

function CleanseAgentLogView(props: { readonly completion: CleanseAgentCompletion }): JSX.Element {
	const { outcome, assignment, agent, total, durationMs } = props.completion;
	const files = compactCleanseAssignmentFiles(assignment);
	if (!outcome.success) {
		return (
			<text color="error" wrap="word">
				✗ {outcome.name} {files} {cleanseErrorPreview(outcome.error)}
			</text>
		);
	}
	const meta: string[] = [];
	const toolCount = agent?.progress?.toolCount ?? 0;
	if (toolCount > 0) meta.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
	if (total && total.tokens > 0) meta.push(`${formatNumber(total.tokens)} tok`);
	if (durationMs !== undefined) meta.push(formatDuration(durationMs));
	return (
		<text wrap="word">
			<span color="success">✓</span> {outcome.name} {files}
			{meta.length > 0 ? <span color="dim"> · {meta.join(" · ")}</span> : null}
		</text>
	);
}

function CleanseLogView(props: { readonly entry: CleanseBoardLogEntry }): JSX.Element {
	if (props.entry.kind === "check")
		return <CleanseCheckLogView check={props.entry.check} durationMs={props.entry.durationMs} />;
	if (props.entry.kind === "agent") return <CleanseAgentLogView completion={props.entry.completion} />;
	return (
		<text color={props.entry.tone} wrap="word">
			{props.entry.text}
		</text>
	);
}

function CleanseLiveRowsView(props: {
	readonly model: CleanseBoardModel;
	readonly now: Accessor<number>;
}): JSX.Element {
	const snapshot = () => props.model.snapshot();
	const checkers = () => [...snapshot().checkers.entries()];
	const agents = () =>
		[...snapshot().agents.entries()].sort((left, right) => left[1].assignment.index - right[1].assignment.index);
	const totals = () => {
		let tokens = 0;
		let cost = 0;
		for (const total of snapshot().totals.values()) {
			tokens += total.tokens;
			cost += total.cost;
		}
		return { tokens, cost };
	};
	const repairMeta = () => {
		const state = snapshot();
		const summary = totals();
		const parts = [`${state.repairDone}/${state.repairTotal}`];
		if (state.agents.size > 0) parts.push(`${state.agents.size} running`);
		if (summary.tokens > 0) parts.push(`${formatNumber(summary.tokens)} tok`);
		if (summary.cost > 0) parts.push(formatCost(summary.cost));
		parts.push(formatDuration(props.now() - state.repairStartedAt));
		return parts.join(" · ");
	};
	return (
		<stack>
			{snapshot().phaseText ? (
				<text wrap="word">
					<spinner type="activity" color="warning" /> {snapshot().phaseText}
				</text>
			) : null}
			<For each={checkers()}>
				{([, checker]) => (
					<text wrap="word">
						<spinner type="activity" color="warning" /> {checker.label}{" "}
						<span color="dim">· {formatDuration(props.now() - checker.startedAt)}</span>
					</text>
				)}
			</For>
			{snapshot().repairTotal > 0 ? (
				<stack>
					<progress
						min={0}
						max={snapshot().repairTotal}
						value={snapshot().repairDone}
						prefix=" Repairing "
						suffix={` ${repairMeta()}`}
					/>
					<For each={agents()}>
						{([name, agent]) => {
							const activity = () => {
								const progress = agent.progress;
								if (!progress) return "starting";
								if (progress.retryState)
									return `rate-limited · retry ${progress.retryState.attempt}/${progress.retryState.maxAttempts}`;
								const intent = sanitizeDisplaySingleLine(progress.lastIntent ?? "")
									.replace(/\s+/g, " ")
									.trim();
								const tool = progress.currentTool
									? `${progress.currentTool}${progress.currentToolArgs ? ` ${sanitizeDisplaySingleLine(progress.currentToolArgs).replace(/\s+/g, " ").trim()}` : ""}`
									: "";
								return intent || tool || "thinking";
							};
							return (
								<text wrap="word">
									<spinner type="activity" color="warning" /> <span bold>{name.replace(/^Cleanse/, "")}</span>{" "}
									{compactCleanseAssignmentFiles(agent.assignment)} <span color="dim">·</span> {activity()}{" "}
									<span color="dim">· {formatDuration(props.now() - agent.startedAt)}</span>
								</text>
							);
						}}
					</For>
				</stack>
			) : null}
		</stack>
	);
}

/** Retained normal-buffer surface for standalone cleanse progress and results. */
export function CleanseBoardView(props: {
	readonly model: CleanseBoardModel;
	readonly onCancel?: () => void;
}): JSX.Element {
	const focus = useFocus();
	const now = useClock("spinner");
	const snapshot = () => props.model.snapshot();
	const handleKey = (event: HostKeyEvent): void => {
		if (!matchesKey(event.data, "escape") && !matchesKey(event.data, "ctrl+c")) return;
		event.preventDefault();
		event.stopPropagation();
		props.onCancel?.();
	};
	onMount(() => focus.focus());
	return (
		<box tabIndex={focus.tabIndex} onKey={handleKey}>
			<transcript>
				<transcript-block settled={snapshot().closed}>
					<stack>
						<For each={snapshot().logs}>{entry => <CleanseLogView entry={entry} />}</For>
						<sized paint={() => <CleanseLiveRowsView model={props.model} now={now} />} />
					</stack>
				</transcript-block>
			</transcript>
		</box>
	);
}

export interface CleanseStatusBoard {
	readonly interactive: boolean;
	log(text: string): void;
	phase(text: string | undefined): void;
	checkerStarted(checker: CleanseCheckerDescriptor): void;
	checkerFinished(check: CleanseCheckResult, durationMs: number): void;
	repairFinished(): void;
	/** Temporarily release stdin for a standalone picker without discarding rows. */
	suspend?(): void;
	/** Reattach the retained board after a standalone picker settles. */
	resume?(): void;
	agentStarted(name: string, assignment: CleanseAssignment): void;
	agentProgress(name: string, progress: AgentProgress): void;
	agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void;
	close(): void;
}

interface BoardOutput {
	readonly isTTY?: boolean;
	readonly terminal?: Terminal;
	write(text: string): unknown;
}

export interface CleanseStatusBoardOptions {
	readonly terminal?: Terminal;
	readonly onCancel?: () => void;
}

function assignmentFileList(assignment: CleanseAssignment): string {
	return assignment.groups.map(group => group.file ?? "<project>").join(", ");
}

/** Retained TTY reporter. Root and clock are created only once real work starts. */
class CleanseReactiveBoard implements CleanseStatusBoard {
	readonly interactive = true;
	readonly #model = new CleanseBoardModel();
	readonly #terminal: Terminal;
	readonly #onCancel: (() => void) | undefined;
	#root: RootHandle | undefined;
	#cancelled = false;
	#closed = false;
	#suspended = false;

	constructor(terminal: Terminal, onCancel?: () => void) {
		this.#terminal = terminal;
		this.#onCancel = onCancel;
	}

	log(text: string): void {
		this.#mount();
		this.#model.log(text);
	}

	phase(text: string | undefined): void {
		this.#mount();
		this.#model.phase(text);
	}

	checkerStarted(checker: CleanseCheckerDescriptor): void {
		this.#mount();
		this.#model.checkerStarted(checker);
	}

	checkerFinished(check: CleanseCheckResult, durationMs: number): void {
		this.#mount();
		this.#model.checkerFinished(check, durationMs);
	}

	repairFinished(): void {
		this.#model.repairFinished();
	}

	suspend(): void {
		if (this.#closed || this.#suspended) return;
		this.#suspended = true;
		this.#root?.dispose();
		this.#root = undefined;
	}

	resume(): void {
		if (this.#closed || !this.#suspended) return;
		this.#suspended = false;
		this.#mount();
	}

	agentStarted(name: string, assignment: CleanseAssignment): void {
		this.#mount();
		this.#model.agentStarted(name, assignment);
	}

	agentProgress(name: string, progress: AgentProgress): void {
		this.#model.agentProgress(name, progress);
	}

	agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void {
		this.#mount();
		this.#model.agentFinished(outcome, assignment);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#model.close();
		this.#root?.dispose();
		this.#root = undefined;
	}

	#mount(): void {
		if (this.#closed || this.#suspended || this.#root !== undefined) return;
		const activeTheme = typeof theme === "undefined" ? loadThemeSync("dark") : theme;
		this.#root = render(() => <CleanseBoardView model={this.#model} onCancel={() => this.#cancel()} />, {
			terminal: this.#terminal,
			theme: activeTheme,
		});
	}

	#cancel(): void {
		if (this.#cancelled) return;
		this.#cancelled = true;
		this.#onCancel?.();
	}
}

/** Plain reporter for piped and redirected command output. */
class CleanseReporter implements CleanseStatusBoard {
	readonly interactive = false;
	readonly #output: BoardOutput;
	readonly #errors: BoardOutput;
	readonly #model = new CleanseBoardModel();

	constructor(output: BoardOutput, errors: BoardOutput) {
		this.#output = output;
		this.#errors = errors;
	}

	log(text: string): void {
		this.#model.log(text);
		this.#output.write(`${text}\n`);
	}

	phase(text: string | undefined): void {
		this.#model.phase(text);
		if (text) this.log(text);
	}

	checkerStarted(checker: CleanseCheckerDescriptor): void {
		this.#model.checkerStarted(checker);
	}

	checkerFinished(check: CleanseCheckResult, durationMs: number): void {
		this.#model.checkerFinished(check, durationMs);
		this.#output.write(`${checkerVerdict(check, durationMs)}\n`);
	}

	repairFinished(): void {
		this.#model.repairFinished();
	}

	agentStarted(name: string, assignment: CleanseAssignment): void {
		this.#model.agentStarted(name, assignment);
		this.#output.write(`[start] ${name}: ${assignmentFileList(assignment)} (weight ${assignment.weight})\n`);
	}

	agentProgress(name: string, progress: AgentProgress): void {
		this.#model.agentProgress(name, progress);
	}

	agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void {
		this.#model.agentFinished(outcome, assignment);
		if (outcome.success) {
			this.#output.write(`[done] ${outcome.name}${outcome.resolvedModel ? ` (${outcome.resolvedModel})` : ""}\n`);
			return;
		}
		this.#errors.write(`[fail] ${outcome.name}: ${cleanseErrorPreview(outcome.error)}\n`);
	}

	close(): void {
		this.#model.close();
	}
}

/** Create a retained live board for TTY output and a line-oriented reporter otherwise. */
export function createCleanseStatusBoard(
	output: BoardOutput = process.stdout,
	errors: BoardOutput = process.stderr,
	options: CleanseStatusBoardOptions = {},
): CleanseStatusBoard {
	const terminal = options.terminal ?? output.terminal;
	if (output.isTTY === true && (terminal !== undefined || output === process.stdout)) {
		return new CleanseReactiveBoard(terminal ?? new ProcessTerminal(), options.onCancel);
	}
	return new CleanseReporter(output, errors);
}
