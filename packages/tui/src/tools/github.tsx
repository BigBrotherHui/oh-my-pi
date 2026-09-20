import { createMemo, For, Show, type JSX, useTheme } from "../reactive";
import { formatShortSha, pushLine } from "./gh-format";
import { PREVIEW_LIMITS, replaceTabs } from "../render/render-utils";
import { Card } from "../view/card";
import { ExpandHint } from "../view/expand-hint";
import type { ToolUIStatus } from "../host/elements/status";
import type { ThemeColor } from "../theme/schema";
import type { SymbolKey } from "../theme/symbols";
import type { CallOutcome, CallPhase, DeepReadonly, ToolViewDefinition, ToolViewProps } from "./view";
import { registerToolView } from "./registry";

import type { OutputMeta } from "./output-meta";
import type { IsoBackendKind } from "@oh-my-pi/pi-natives";

export type GithubToolRenderArgs = {
	op?: string;
	run?: string;
	branch?: string;
	repo?: string;
	pr?: string | readonly string[];
	query?: string;
};

const SUCCESS_CONCLUSIONS: Record<string, true> = {
	success: true,
	neutral: true,
	skipped: true,
};
const FAILURE_CONCLUSIONS: Record<string, true> = {
	failure: true,
	timed_out: true,
	cancelled: true,
	action_required: true,
	startup_failure: true,
};
const RUNNING_STATUSES: Record<string, true> = { in_progress: true };

/** Content cap for semantic search metadata, independent of terminal layout. */
const SEARCH_METADATA_MAX_CHARS = 80;

const OP_TITLES: Record<string, string> = {
	repo_view: "GitHub Repo",
	pr_checkout: "GitHub PR Checkout",
	pr_push: "GitHub PR Push",
	search_issues: "GitHub Search Issues",
	search_prs: "GitHub Search PRs",
	search_code: "GitHub Search Code",
	search_commits: "GitHub Search Commits",
	search_repos: "GitHub Search Repos",
	run_watch: "GitHub Run Watch",
};

export function formatOpTitle(op: string | undefined): string {
	if (op && OP_TITLES[op]) return OP_TITLES[op];
	return "GitHub";
}

function boundedSearchMetadata(value: string): string {
	return value.length <= SEARCH_METADATA_MAX_CHARS ? value : `${value.slice(0, SEARCH_METADATA_MAX_CHARS - 1)}…`;
}

export function extractIssueId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (/^\d+$/.test(trimmed)) return `#${trimmed}`;
	const match = trimmed.match(/\/(?:issues|pull)\/(\d+)/);
	if (match) return `#${match[1]}`;
	return trimmed;
}

export function formatPrIdentifier(pr: string | readonly string[] | undefined): string | undefined {
	if (pr === undefined) return undefined;
	if (typeof pr === "string") return extractIssueId(pr);

	const parts = pr.map(p => extractIssueId(p)).filter((p): p is string => p !== undefined);
	if (parts.length === 0) return undefined;
	if (parts.length > 3) {
		return `${parts.slice(0, 3).join(", ")}, +${parts.length - 3} more`;
	}
	return parts.join(", ");
}

export function buildOpMeta(args: Readonly<Partial<GithubToolRenderArgs>>): string[] {
	const meta: string[] = [];
	const op = args.op;
	switch (op) {
		case "pr_checkout":
		case "pr_push": {
			const id = formatPrIdentifier(args.pr);
			if (id) meta.push(id);
			else if (args.branch) meta.push(args.branch);
			if (args.repo) meta.push(args.repo);
			break;
		}
		case "search_issues":
		case "search_prs":
		case "search_code":
		case "search_commits": {
			if (args.query) meta.push(boundedSearchMetadata(args.query));
			if (args.repo) meta.push(args.repo);
			break;
		}
		case "search_repos": {
			if (args.query) meta.push(boundedSearchMetadata(args.query));
			break;
		}
		case "repo_view": {
			if (args.repo) meta.push(args.repo);
			if (args.branch) meta.push(args.branch);
			break;
		}
		case "run_watch":
			break;
		default: {
			if (args.repo) meta.push(args.repo);
			break;
		}
	}
	return meta;
}

function flattenHeaderText(text: string): string {
	return text.replace(/\r\n?|\n/g, " ");
}

export function getWatchHeader(watch: DeepReadonly<GhRunWatchViewDetails>): string {
	if (watch.mode === "run" && watch.run) {
		if (watch.state === "watching") {
			return `watching run #${watch.run.id} on ${watch.repo}`;
		}
		return `run #${watch.run.id} on ${watch.repo}`;
	}

	const shortSha = formatShortSha(watch.headSha) ?? "this commit";
	if (watch.state === "watching") {
		return `watching ${shortSha} on ${watch.repo}`;
	}
	return `workflow runs for ${shortSha} on ${watch.repo}`;
}

export function getRunLabel(run: DeepReadonly<GhRunWatchRunDetails>): string {
	return replaceTabs(run.workflowName ?? run.displayTitle ?? "GitHub Actions");
}

export function getRunMeta(run: DeepReadonly<GhRunWatchRunDetails>): string[] {
	const parts: string[] = [];
	if (run.branch) {
		parts.push(replaceTabs(run.branch));
	} else if (run.headSha) {
		parts.push(formatShortSha(run.headSha) ?? run.headSha);
	}
	parts.push(`#${run.id}`);
	return parts;
}

function jobStatusToUI(job: DeepReadonly<GhRunWatchJobDetails>): ToolUIStatus {
	if (job.conclusion && SUCCESS_CONCLUSIONS[job.conclusion]) return "success";
	if (job.conclusion && FAILURE_CONCLUSIONS[job.conclusion]) return "error";
	if (job.status && RUNNING_STATUSES[job.status]) return "running";
	return "pending";
}

function jobTextColor(status: ToolUIStatus): ThemeColor {
	if (status === "success") return "success";
	if (status === "error") return "error";
	if (status === "running") return "warning";
	return "muted";
}

function jobIconColor(status: ToolUIStatus): ThemeColor {
	if (status === "success") return "accent";
	return jobTextColor(status);
}

function failedLogLines(entry: DeepReadonly<GhRunWatchFailedLogDetails>, expanded: boolean): string[] {
	if (!entry.available || !entry.tail) return [];
	const raw = replaceTabs(entry.tail)
		.split("\n")
		.filter(line => line.length > 0);
	const limit = expanded ? raw.length : Math.min(PREVIEW_LIMITS.OUTPUT_COLLAPSED, raw.length);
	return raw.slice(-limit);
}

function failedLogRemainder(entry: DeepReadonly<GhRunWatchFailedLogDetails>, expanded: boolean): number {
	if (!entry.available || !entry.tail || expanded) return 0;
	const lineCount = replaceTabs(entry.tail)
		.split("\n")
		.filter(line => line.length > 0).length;
	return Math.max(0, lineCount - PREVIEW_LIMITS.OUTPUT_COLLAPSED);
}

function statusFor(phase: CallPhase, outcome: CallOutcome | undefined): ToolUIStatus {
	if (phase === "running") return "pending";
	if (phase === "queued" || phase === "receiving") return "pending";
	if (outcome === "failed" || outcome === "timed_out") return "error";
	if (outcome === "cancelled" || outcome === "skipped") return "aborted";
	return "success";
}

function outputLines(text: string): string[] {
	const lines = replaceTabs(text).split("\n");
	while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines;
}

interface GithubHeaderProps {
	readonly status?: ToolUIStatus;
	readonly icon?: SymbolKey;
	readonly title: string;
	readonly titleColor?: ThemeColor;
	readonly meta?: readonly string[];
	readonly metaColor?: ThemeColor;
	readonly wrap?: "word" | "none";
}

function GithubHeader(props: GithubHeaderProps): JSX.Element {
	const theme = useTheme();
	const meta = createMemo(() =>
		(props.meta ?? [])
			.map(flattenHeaderText)
			.filter(value => value.trim().length > 0)
			.join(theme.theme().sep.dot),
	);
	const leading = createMemo<JSX.Element | undefined>(() => {
		if (props.status !== undefined) return <status value={props.status} />;
		if (props.icon !== undefined) return <icon name={props.icon} color="accent" />;
		return undefined;
	});

	return (
		<text wrap={props.wrap ?? "none"} overflow="ellipsis">
			{leading()} <span color={props.titleColor ?? "accent"}>{flattenHeaderText(props.title)}</span>
			<Show when={meta().length > 0}>
				{" "}
				<span color={props.metaColor ?? "dim"}>{meta()}</span>
			</Show>
		</text>
	);
}

function PendingWatchView(props: {
	readonly args: DeepReadonly<GithubToolRenderArgs>;
	readonly phase: CallPhase;
}): JSX.Element {
	const status = createMemo<ToolUIStatus>(() => "pending");
	const meta = createMemo<{ color: ThemeColor; value: string }>(() => {
		const run =
			typeof props.args.run === "string" && props.args.run.trim().length > 0 ? props.args.run.trim() : undefined;
		if (run) return { color: "dim", value: `#${run}` };
		const branch =
			typeof props.args.branch === "string" && props.args.branch.trim().length > 0
				? props.args.branch.trim()
				: undefined;
		return branch ? { color: "text", value: branch } : { color: "dim", value: "current HEAD" };
	});

	return (
		<stack>
			<GithubHeader status={status()} title="GitHub Run Watch" meta={[meta().value]} metaColor={meta().color} />
			<text color="dim">waiting for workflow data...</text>
		</stack>
	);
}

function WatchRunBlock(props: { readonly run: DeepReadonly<GhRunWatchRunDetails> }): JSX.Element {
	const meta = createMemo(() => getRunMeta(props.run));
	return (
		<stack>
			<text wrap="none" overflow="ellipsis">
				<span color="accent">{getRunLabel(props.run)}</span>
				<For each={meta()}>
					{(part, index) => (
						<span color={index() === meta().length - 1 ? "muted" : "text"}>
							{"  "}
							{part}
						</span>
					)}
				</For>
			</text>
			<Show when={props.run.jobs.length > 0} fallback={<text color="dim">waiting for workflow jobs...</text>}>
				<For each={props.run.jobs}>
					{job => {
						const status = jobStatusToUI(job);
						const color = jobTextColor(status);
						return (
							<row gap={1}>
								<status value={status} color={jobIconColor(status)} />
								<text color={color} grow={1} minWidth={8} wrap="none" overflow="ellipsis">
									{replaceTabs(job.name)}
								</text>
								<Show when={job.durationSeconds !== undefined}>
									<text color={color}>{job.durationSeconds}s</text>
								</Show>
							</row>
						);
					}}
				</For>
			</Show>
		</stack>
	);
}

function FailedLogSection(props: {
	readonly entries: readonly DeepReadonly<GhRunWatchFailedLogDetails>[];
	readonly expanded: boolean;
}): JSX.Element {
	return (
		<>
			<hr variant="frame" label="failed logs" />
			<stack>
				<For each={props.entries}>
					{entry => {
						const context = entry.workflowName ? `${entry.workflowName}  #${entry.runId}` : `run #${entry.runId}`;
						const lines = () => failedLogLines(entry, props.expanded);
						const remaining = () => failedLogRemainder(entry, props.expanded);
						return (
							<stack>
								<row gap={1}>
									<status value="error" />
									<text grow={1} minWidth={1} wrap="none" overflow="ellipsis">
										<span color="error">{replaceTabs(entry.jobName)}</span>
										<span color="muted">
											{"  "}
											{context}
										</span>
									</text>
								</row>
								<Show
									when={entry.available && entry.tail}
									fallback={<text color="dim"> log tail unavailable</text>}
								>
									<For each={lines()}>
										{line => (
											<text color="dim" wrap="clip" overflow="ellipsis">
												{" "}
												{line}
											</text>
										)}
									</For>
									<Show when={remaining() > 0}>
										<text color="dim">
											… {remaining()} more log lines <ExpandHint expanded={props.expanded} hasMore />
										</text>
									</Show>
								</Show>
							</stack>
						);
					}}
				</For>
			</stack>
		</>
	);
}

function WatchResultView(
	props: ToolViewProps<GithubToolRenderArgs, GhToolDetails> & { readonly watch: DeepReadonly<GhRunWatchViewDetails> },
): JSX.Element {
	const status = createMemo(() => statusFor(props.phase, props.outcome));
	const failed = createMemo(() => props.outcome === "failed" || props.outcome === "timed_out");
	const aborted = createMemo(() => props.outcome === "cancelled" || props.outcome === "skipped");
	const runs = createMemo(() => {
		if (props.watch.mode === "run") return props.watch.run ? [props.watch.run] : [];
		return props.watch.runs ?? [];
	});
	const failedLogs = createMemo(() => props.watch.failedLogs ?? []);
	const header = createMemo(() => (
		<GithubHeader
			status={props.phase === "settled" && !failed() && !aborted() ? undefined : status()}
			icon={props.phase === "settled" && !failed() && !aborted() ? "tool.gh" : undefined}
			title="GitHub Run Watch"
			titleColor={failed() ? "error" : "accent"}
			meta={[getWatchHeader(props.watch)]}
		/>
	));

	return (
		<Card title={header()} borderColor={failed() ? "error" : "borderMuted"} backgroundBorder={false}>
			<stack>
				<Show when={props.watch.note}>
					<text color="dim">{replaceTabs(props.watch.note!)}</text>
				</Show>
				<Show when={props.watch.mode === "commit" && runs().length === 0}>
					<text color="dim">waiting for workflow runs...</text>
				</Show>
				<For each={runs()}>
					{(run, index) => (
						<>
							<Show when={index() > 0}>
								<br />
							</Show>
							<WatchRunBlock run={run} />
						</>
					)}
				</For>
				<Show when={failedLogs().length > 0}>
					<FailedLogSection entries={failedLogs()} expanded={props.ui.expanded} />
				</Show>
			</stack>
		</Card>
	);
}

function GenericResultView(
	props: ToolViewProps<GithubToolRenderArgs, GhToolDetails> & { readonly title: string },
): JSX.Element {
	const status = createMemo(() => statusFor(props.phase, props.outcome));
	const failed = createMemo(() => props.outcome === "failed" || props.outcome === "timed_out");
	const aborted = createMemo(() => props.outcome === "cancelled" || props.outcome === "skipped");
	const terminal = createMemo(() => props.phase === "settled");
	const lines = createMemo(() => {
		props.output.version();
		return outputLines(props.output.text());
	});
	const visible = createMemo(() => {
		const all = lines();
		const limit = props.ui.expanded ? all.length : Math.min(all.length, PREVIEW_LIMITS.OUTPUT_EXPANDED);
		return all.slice(0, limit);
	});
	const remaining = createMemo(() => Math.max(0, lines().length - visible().length));
	const textColor = createMemo<ThemeColor>(() => {
		if (failed()) return "error";
		if (aborted()) return "dim";
		return "toolOutput";
	});
	const header = createMemo(() => {
		const emptySuccess = terminal() && !failed() && !aborted() && lines().length === 0;
		return (
			<GithubHeader
				status={emptySuccess ? "warning" : failed() || aborted() || !terminal() ? status() : undefined}
				icon={terminal() && !failed() && !aborted() && lines().length > 0 ? "tool.gh" : undefined}
				title={props.title}
				titleColor={failed() ? "error" : "accent"}
				meta={buildOpMeta(props.args)}
			/>
		);
	});
	const emptyText = createMemo(() => {
		if (failed()) return "request failed";
		if (aborted()) return "request aborted";
		return "no output";
	});
	const needsCard = createMemo(() => failed() || aborted() || visible().length > 1);

	return (
		<Show
			when={lines().length > 0}
			fallback={
				<stack>
					{header()}
					<text color="dim">{emptyText()}</text>
				</stack>
			}
		>
			<Show
				when={needsCard()}
				fallback={
					<stack>
						{header()}
						<text color={textColor()} wrap="clip" overflow="ellipsis">
							{visible()[0]}
						</text>
					</stack>
				}
			>
				<Card title={header()} borderColor={failed() ? "error" : "borderMuted"} backgroundBorder={false}>
					<stack>
						<For each={visible()}>
							{line => (
								<text color={textColor()} wrap="clip" overflow="ellipsis">
									{line}
								</text>
							)}
						</For>
						<Show when={remaining() > 0}>
							<text color="dim">
								… {remaining()} more lines <ExpandHint expanded={props.ui.expanded} hasMore />
							</text>
						</Show>
					</stack>
				</Card>
			</Show>
		</Show>
	);
}

/** Display metadata for GitHub operations. */
export interface GhToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	worktreePath?: string;
	remote?: string;
	remoteBranch?: string;
	headSha?: string;
	runId?: number;
	runIds?: number[];
	status?: string;
	conclusion?: string;
	failedJobs?: string[];
	watch?: GhRunWatchViewDetails;
	checkouts?: GhPrCheckoutSummary[];
}

/** Checkout location and branch metadata for a pull request. */
export interface GhPrCheckoutSummary {
	prNumber?: number;
	url?: string;
	branch: string;
	worktreePath: string;
	remote: string;
	remoteBranch: string;
	reused: boolean;
	clonedWith?: IsoBackendKind;
}

/** Display state of a watched workflow job. */
export interface GhRunWatchJobDetails {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
	url?: string;
}

/** Display state of a watched workflow run. */
export interface GhRunWatchRunDetails {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	url?: string;
	jobs: GhRunWatchJobDetails[];
}

/** Captured log preview for a failed job. */
export interface GhRunWatchFailedLogDetails {
	runId: number;
	workflowName?: string;
	jobName: string;
	conclusion?: string;
	tail?: string;
	available: boolean;
}

/** Live workflow watcher display snapshot. */
export interface GhRunWatchViewDetails {
	mode: "run" | "commit";
	state: "watching" | "completed";
	repo: string;
	branch?: string;
	headSha?: string;
	pollCount?: number;
	note?: string;
	run?: GhRunWatchRunDetails;
	runs?: GhRunWatchRunDetails[];
	failedLogs?: GhRunWatchFailedLogDetails[];
}

/** Normalized status and timestamps of a workflow job. */
export interface GhRunJobSnapshot {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	startedAt?: string;
	completedAt?: string;
	url?: string;
}

/** Normalized workflow run and job snapshot. */
export interface GhRunSnapshot {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	jobs: GhRunJobSnapshot[];
}

/** Captured failure logs associated with a run and job. */
export interface GhFailedJobLog {
	run: GhRunSnapshot;
	job: GhRunJobSnapshot;
	full?: string;
	tail?: string;
	available: boolean;
}

/** Choose the terminal conclusion or current job state. */
export function formatJobState(job: GhRunJobSnapshot): string {
	return job.conclusion ?? job.status ?? "unknown";
}

/** Format workflow jobs as a Markdown section. */
export function renderJobsSection(jobs: GhRunJobSnapshot[]): string[] {
	if (jobs.length === 0) {
		return ["## Jobs", "", "No jobs reported yet."];
	}

	const lines: string[] = [`## Jobs (${jobs.length})`, ""];
	for (const job of jobs) {
		lines.push(`- [${formatJobState(job)}] ${job.name}`);
		if (job.startedAt) {
			pushLine(lines, "  Started", job.startedAt);
		}
		if (job.completedAt) {
			pushLine(lines, "  Completed", job.completedAt);
		}
		if (job.url) {
			pushLine(lines, "  URL", job.url);
		}
	}

	return lines;
}

/** Format failed workflow logs as Markdown sections. */
export function renderFailedJobLogs(
	failedJobLogs: GhFailedJobLog[],
	options: { mode: "tail"; tail: number } | { mode: "full" },
): string[] {
	if (failedJobLogs.length === 0) {
		return [];
	}

	const lines: string[] = ["## Failed Jobs", ""];
	for (const entry of failedJobLogs) {
		lines.push(`### ${entry.job.name} [${entry.job.conclusion ?? "failed"}]`);
		pushLine(lines, "Run", `#${entry.run.id}`);
		pushLine(lines, "Workflow", entry.run.workflowName ?? undefined);
		if (entry.job.startedAt) {
			pushLine(lines, "Started", entry.job.startedAt);
		}
		if (entry.job.completedAt) {
			pushLine(lines, "Completed", entry.job.completedAt);
		}
		if (entry.job.url) {
			pushLine(lines, "URL", entry.job.url);
		}
		lines.push("");
		const logText = options.mode === "full" ? entry.full : entry.tail;
		if (entry.available && logText) {
			lines.push(options.mode === "full" ? "Full log:" : `Last ${options.tail} log lines:`);
			lines.push("```text");
			lines.push(logText);
			lines.push("```");
		} else {
			lines.push(options.mode === "full" ? "Full log unavailable." : "Log tail unavailable.");
		}
		lines.push("");
	}

	return lines;
}

/** Format a workflow run and its jobs as Markdown. */
export function renderRunSection(run: GhRunSnapshot): string[] {
	const label = run.workflowName ? `### Run #${run.id} - ${run.workflowName}` : `### Run #${run.id}`;
	const lines: string[] = [label, ""];
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Commit", formatShortSha(run.headSha));
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));
	return lines;
}

/** Reactive tool view for GitHub operations and live workflow status. */
export const githubToolView: ToolViewDefinition<GithubToolRenderArgs, GhToolDetails> = {
	view: (props: ToolViewProps<GithubToolRenderArgs, GhToolDetails>): JSX.Element => {
		const op = createMemo(() => {
			const raw = props.args.op;
			return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
		});
		const watch = createMemo(() => props.details?.watch);
		const isWatch = createMemo(() => op() === "run_watch" || watch() !== undefined);
		const hasOutput = createMemo(() => {
			props.output.version();
			return outputLines(props.output.text()).length > 0;
		});
		const hasResult = createMemo(() => props.phase === "settled" || watch() !== undefined || hasOutput());

		const result = createMemo<JSX.Element>(() => {
			if (!hasResult()) {
				if (isWatch()) return <PendingWatchView args={props.args} phase={props.phase} />;
				return (
					<GithubHeader
						status={statusFor(props.phase, props.outcome)}
						title={formatOpTitle(op())}
						meta={buildOpMeta(props.args)}
						wrap="word"
					/>
				);
			}

			const currentWatch = watch();
			if (currentWatch !== undefined) return <WatchResultView {...props} watch={currentWatch} />;
			return <GenericResultView {...props} title={isWatch() ? "GitHub Run Watch" : formatOpTitle(op())} />;
		});

		return result;
	},

	summary: props => ({
		label: formatOpTitle(props.args.op),
		detail: buildOpMeta(props.args).join(" · ") || undefined,
		status: statusFor(props.phase, props.outcome),
	}),
	framed: true,
	tint: false,
};

registerToolView("github", githubToolView);
