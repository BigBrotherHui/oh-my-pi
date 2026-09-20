import { createMemo, For, Show, type Accessor, type JSX } from "../reactive";
import { replaceTabs, shortenPath } from "../render/render-utils";
import type { ToolUIStatus } from "../host/elements/status";
import type { TruncationResult } from "./streaming-output";
import { ToolCard } from "../view/tool-card";
import { ToolHeader } from "../view/tool-header";
import type { CallOutcome, CallPhase, ToolViewDefinition, ToolViewProps } from "./view";
import { registerToolView } from "./registry";

/** Whether a lower or higher metric is better. */
export type MetricDirection = "lower" | "higher";

/** Disposition of a completed experiment. */
export type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";

/** JSON-compatible additional structured experiment information. */
export type ASIValue = string | number | boolean | null | ASIValue[] | { [key: string]: ASIValue };

/** Named structured experiment observations. */
export interface ASIData {
	[key: string]: ASIValue;
}

/** Numeric metrics indexed by name. */
export interface NumericMetricMap {
	[key: string]: number;
}

/** Name and unit of an experiment metric. */
export interface MetricDef {
	name: string;
	unit: string;
}

/** Recorded metric and disposition of an experiment run. */
export interface ExperimentResult {
	runNumber: number | null;
	commit: string;
	metric: number;
	metrics: NumericMetricMap;
	status: ExperimentStatus;
	description: string;
	timestamp: number;
	segment: number;
	confidence: number | null;
	asi?: ASIData;
	modifiedPaths: string[];
	scopeDeviations: string[];
	justification: string | null;
	flagged: boolean;
	flaggedReason: string | null;
}

/** Current experiment baseline, history, and scope. */
export interface ExperimentState {
	results: ExperimentResult[];
	bestMetric: number | null;
	bestDirection: MetricDirection;
	metricName: string;
	metricUnit: string;
	secondaryMetrics: MetricDef[];
	name: string | null;
	goal: string | null;
	currentSegment: number;
	maxExperiments: number | null;
	confidence: number | null;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	notes: string;
	branch: string | null;
	baselineCommit: string | null;
	sessionId: number | null;
}

/** Live elapsed time and output metadata of a benchmark. */
export interface RunExperimentProgressDetails {
	phase: "running";
	elapsed: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	runDirectory?: string;
}

/** Completed benchmark measurements, status, and output. */
export interface RunDetails {
	runNumber: number;
	runDirectory: string;
	benchmarkLogPath: string;
	command: string;
	exitCode: number | null;
	durationSeconds: number;
	passed: boolean;
	crashed: boolean;
	timedOut: boolean;
	tailOutput: string;
	parsedMetrics: NumericMetricMap | null;
	parsedPrimary: number | null;
	parsedAsi: ASIData | null;
	metricName: string;
	metricUnit: string;
	preRunDirtyPaths: string[];
	abandonedPriorRun: number | null;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/** Logged experiment result and updated baseline state. */
export interface LogDetails {
	experiment: ExperimentResult;
	state: ExperimentState;
	wallClockSeconds: number | null;
	scopeDeviations: string[];
	justification: string | null;
	flaggedRuns: Array<{ runId: number; reason: string }>;
}

/** Format an integer with comma-separated digit groups. */
export function commas(value: number): string {
	const sign = value < 0 ? "-" : "";
	const digits = String(Math.trunc(Math.abs(value)));
	const groups: string[] = [];
	for (let index = digits.length; index > 0; index -= 3) {
		groups.unshift(digits.slice(Math.max(0, index - 3), index));
	}
	return sign + groups.join(",");
}

/** Format a number with grouped digits and optional decimals. */
export function fmtNum(value: number, decimals: number = 0): string {
	if (decimals <= 0) return commas(Math.round(value));
	const absolute = Math.abs(value);
	const whole = Math.floor(absolute);
	const fraction = (absolute - whole).toFixed(decimals).slice(1);
	return `${value < 0 ? "-" : ""}${commas(whole)}${fraction}`;
}

/** Format an optional metric value with its unit. */
export function formatNum(value: number | null, unit: string): string {
	if (value === null) return "-";
	if (Number.isInteger(value)) return `${fmtNum(value)}${unit}`;
	return `${fmtNum(value, 2)}${unit}`;
}

/** Filename of the benchmark harness. */
export const HARNESS_FILENAME = "autoresearch.sh";

/** Default command that executes the benchmark harness. */
export const DEFAULT_HARNESS_COMMAND = `bash ${HARNESS_FILENAME}`;

/** Initialization outcome and experiment state. */
export interface InitExperimentDetails {
	state: ExperimentState;
	createdSession: boolean;
	bumpedSegment: boolean;
	abandonedRuns: number;
	harnessCommitted: boolean;
	baselineCommit: string | null;
}

/** Persisted experiment notes after an update. */
export interface UpdateNotesDetails {
	notes: string;
}

export function isRunDetails(value: unknown): value is RunDetails {
	if (typeof value !== "object" || value === null) return false;
	return "command" in value && "durationSeconds" in value;
}

export function isProgressDetails(value: unknown): value is RunExperimentProgressDetails {
	if (typeof value !== "object" || value === null) return false;
	return "phase" in value && value.phase === "running";
}

function toolStatus(phase: CallPhase, outcome: CallOutcome | undefined): ToolUIStatus {
	if (phase === "receiving" || phase === "queued") return "pending";
	if (phase === "running") return "running";
	if (outcome === "failed" || outcome === "timed_out") return "error";
	if (outcome === "cancelled" || outcome === "skipped") return "aborted";
	return "success";
}

function experimentColor(status: ExperimentStatus): "success" | "warning" | "error" {
	return status === "keep" ? "success" : status === "discard" ? "warning" : "error";
}

function displayText(value: unknown): string {
	return typeof value === "string" ? replaceTabs(value) : "";
}

function outputLines(text: string): string[] {
	return replaceTabs(text).split("\n");
}

function autoresearchHeader(status: ToolUIStatus, label: string, meta?: JSX.Element): JSX.Element {
	return (
		<ToolHeader
			status={status}
			label={
				<span color="toolTitle" bold>
					{label}
				</span>
			}
			meta={meta}
		/>
	);
}

function experimentStatus(details: RunDetails): { text: string; color: "error" | "success" } {
	if (details.timedOut) return { text: `TIMEOUT ${details.durationSeconds.toFixed(1)}s`, color: "error" };
	if (details.exitCode !== 0)
		return { text: `FAIL exit=${details.exitCode} ${details.durationSeconds.toFixed(1)}s`, color: "error" };
	const metric =
		details.parsedPrimary !== null
			? ` ${details.metricName}=${formatNum(details.parsedPrimary, details.metricUnit)}`
			: "";
	return { text: `PASS ${details.durationSeconds.toFixed(1)}s${metric}`, color: "success" };
}

/** Reactive view definition for init_experiment. */
export const initExperimentToolView: ToolViewDefinition<{ name: string }, InitExperimentDetails> = {
	view: (props: ToolViewProps<{ name: string }, InitExperimentDetails>): JSX.Element => {
		const status = createMemo(() => toolStatus(props.phase, props.outcome));
		const name = createMemo(() => displayText(props.args.name));
		const text = createMemo(() => {
			props.output.version();
			return props.output.text();
		});

		return (
			<ToolCard
				phase={props.phase}
				outcome={props.outcome}
				framed={false}
				header={autoresearchHeader(status(), "init_experiment", <span color="accent">{name()}</span>)}
			>
				<Show when={text().length > 0}>
					<stack>
						<For each={outputLines(text())}>{line => <text>{line}</text>}</For>
					</stack>
				</Show>
			</ToolCard>
		);
	},
	summary: props => ({
		label: "init_experiment",
		detail: props.args.name,
		status: toolStatus(props.phase, props.outcome),
	}),
	framed: false,
};

/** Reactive view definition for log_experiment. */
export const logExperimentToolView: ToolViewDefinition<{ status: ExperimentStatus; description: string }, LogDetails> =
	{
		view: (props: ToolViewProps<{ status: ExperimentStatus; description: string }, LogDetails>): JSX.Element => {
			const status = createMemo(() => toolStatus(props.phase, props.outcome));
			const details = createMemo(() => props.details);
			const disposition = createMemo(() => props.args.status);
			const description = createMemo(() => displayText(props.args.description));
			const text = createMemo(() => {
				props.output.version();
				return props.output.text();
			});

			return (
				<ToolCard
					phase={props.phase}
					outcome={props.outcome}
					framed={false}
					header={autoresearchHeader(
						status(),
						"log_experiment",
						<Show when={disposition()} fallback={<span color="muted">{description()}</span>}>
							{(value: Accessor<ExperimentStatus>) => (
								<span>
									<span color={experimentColor(value())}>{value()}</span>{" "}
									<span color="muted">{description()}</span>
								</span>
							)}
						</Show>,
					)}
				>
					<Show
						when={details()}
						fallback={
							<Show when={text().length > 0}>
								<stack>
									<For each={outputLines(text())}>{line => <text>{line}</text>}</For>
								</stack>
							</Show>
						}
					>
						{(d: () => LogDetails) => {
							const exp = d().experiment;
							const state = d().state;
							return (
								<text>
									<span color={experimentColor(exp.status)}>{exp.status.toUpperCase()}</span>{" "}
									<span color="muted">{displayText(exp.description)}</span>{" "}
									<span color="accent">
										{state.metricName}={formatNum(exp.metric, state.metricUnit)}
									</span>
									{state.bestMetric !== null && (
										<span color="dim">{` baseline ${formatNum(state.bestMetric, state.metricUnit)}`}</span>
									)}
									{state.confidence !== null && (
										<span color="dim">{` conf ${state.confidence.toFixed(1)}x`}</span>
									)}
									{d().scopeDeviations.length > 0 && (
										<span color="warning">{` deviations:${d().scopeDeviations.length}`}</span>
									)}
								</text>
							);
						}}
					</Show>
				</ToolCard>
			);
		},
		summary: props => ({
			label: "log_experiment",
			detail: props.args.status ? `${props.args.status}: ${props.args.description}` : props.args.description,
			status: toolStatus(props.phase, props.outcome),
		}),
		framed: false,
	};

interface RunExperimentContentProps {
	readonly props: ToolViewProps<unknown, RunDetails | RunExperimentProgressDetails>;
	readonly expanded: boolean;
}

function RunExperimentContent(content: RunExperimentContentProps): JSX.Element {
	const details = createMemo(() => content.props.details);
	const text = createMemo(() => {
		content.props.output.version();
		return content.props.output.text();
	});

	return (
		<Show
			when={details()}
			fallback={
				<Show when={text().length > 0}>
					<stack>
						<For each={outputLines(text())}>{line => <text>{line}</text>}</For>
					</stack>
				</Show>
			}
		>
			{(d: Accessor<RunDetails | RunExperimentProgressDetails>) => {
				const run = d();
				if (isProgressDetails(run)) {
					const preview = text();
					return (
						<stack>
							<text color="warning">Running {run.elapsed}...</text>
							<Show when={preview.length > 0}>
								<stack>
									<For each={outputLines(preview)}>{line => <text color="dim">{line}</text>}</For>
								</stack>
							</Show>
						</stack>
					);
				}

				if (isRunDetails(run)) {
					const resultStatus = experimentStatus(run);
					if (!content.expanded && run.tailOutput.trim().length === 0) {
						return <text color={resultStatus.color}>{resultStatus.text}</text>;
					}

					const preview = content.expanded
						? replaceTabs(run.tailOutput)
						: replaceTabs(run.tailOutput.split("\n").slice(-5).join("\n"));
					const fullOutputPath = content.expanded && run.truncation !== undefined ? run.fullOutputPath : undefined;
					return (
						<stack>
							<text color={resultStatus.color}>{resultStatus.text}</text>
							<Show when={preview.length > 0}>
								<stack>
									<For each={preview.split("\n")}>{line => <text color="dim">{line}</text>}</For>
								</stack>
							</Show>
							<Show when={fullOutputPath}>
								{(path: Accessor<string>) => <text color="warning">Full output: {shortenPath(path())}</text>}
							</Show>
						</stack>
					);
				}

				return (
					<Show when={text().length > 0}>
						<stack>
							<For each={outputLines(text())}>{line => <text>{line}</text>}</For>
						</stack>
					</Show>
				);
			}}
		</Show>
	);
}

/** Reactive view definition for run_experiment. */
export const runExperimentToolView: ToolViewDefinition<unknown, RunDetails | RunExperimentProgressDetails> = {
	view: (props: ToolViewProps<unknown, RunDetails | RunExperimentProgressDetails>): JSX.Element => {
		const status = createMemo(() => toolStatus(props.phase, props.outcome));

		return (
			<ToolCard
				phase={props.phase}
				outcome={props.outcome}
				framed={false}
				expanded={props.ui.expanded}
				header={autoresearchHeader(
					status(),
					"run_experiment",
					<span color="muted">{DEFAULT_HARNESS_COMMAND}</span>,
				)}
				summary={<RunExperimentContent props={props} expanded={false} />}
			>
				<RunExperimentContent props={props} expanded />
			</ToolCard>
		);
	},
	summary: props => ({
		label: "run_experiment",
		detail: DEFAULT_HARNESS_COMMAND,
		status: toolStatus(props.phase, props.outcome),
	}),
	framed: false,
};

/** Reactive view definition for update_notes. */
export const updateNotesToolView: ToolViewDefinition<{ body: string; append_idea?: string }, UpdateNotesDetails> = {
	view: (props: ToolViewProps<{ body: string; append_idea?: string }, UpdateNotesDetails>): JSX.Element => {
		const status = createMemo(() => toolStatus(props.phase, props.outcome));
		const preview = createMemo(() => displayText(props.args.append_idea ?? props.args.body?.slice(0, 100)));
		const text = createMemo(() => {
			props.output.version();
			return props.output.text();
		});

		return (
			<ToolCard
				phase={props.phase}
				outcome={props.outcome}
				framed={false}
				header={autoresearchHeader(status(), "update_notes", <span color="muted">{preview()}</span>)}
			>
				<Show when={text().length > 0}>
					<stack>
						<For each={outputLines(text())}>{line => <text color="muted">{line}</text>}</For>
					</stack>
				</Show>
			</ToolCard>
		);
	},
	summary: props => ({
		label: "update_notes",
		detail: props.args.append_idea ?? props.args.body?.slice(0, 60),
		status: toolStatus(props.phase, props.outcome),
	}),
	framed: false,
};

registerToolView("init_experiment", initExperimentToolView);
registerToolView("log_experiment", logExperimentToolView);
registerToolView("run_experiment", runExperimentToolView);
registerToolView("update_notes", updateNotesToolView);
