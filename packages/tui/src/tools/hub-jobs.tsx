import { formatDuration, isFeedModelBadgeEnabled, replaceTabs, thinkingLevelGlyph } from "../render/render-utils";
import { createMemo, For, Show, type Accessor, type JSX, useTheme } from "../reactive";
import type { ThemeColor } from "../theme/theme";
import { TreeList } from "../view/tree-list";
import type { ToolUIStatus } from "../view/status-icon";
import { formatArtifactErrorNotice } from "./output-meta";
import type { AgentActivitySnapshot, JobSnapshot } from "./hub-contract";
import { coordinationDetails, isJobPoll, outputText, sortedJobs, type HubViewProps } from "./hub-selection";
import type { DeepReadonly } from "./view";

const COLLAPSED_ITEM_LIMIT = 8;
const JOB_PREVIEW_LINES_COLLAPSED = 1;
const JOB_PREVIEW_LINES_EXPANDED = 4;
const JOB_LABEL_LINES_COLLAPSED = 1;
const JOB_LABEL_LINES_EXPANDED = 3;

/** Select and order visible jobs without repeating already-settled poll rows. */
export function jobsForDisplay(props: HubViewProps): readonly DeepReadonly<JobSnapshot>[] {
	const details = coordinationDetails(props.details);
	const agents = details?.agents ?? [];
	let jobs = details?.jobs ?? [];
	if (props.phase === "settled" && isJobPoll(props.args) && agents.length === 0)
		jobs = jobs.filter(job => job.status !== "running");
	return sortedJobs(jobs);
}

/** Hide completed polls that contain only still-running jobs and no agent activity. */
export function hideSealedPoll(props: HubViewProps): boolean {
	const details = coordinationDetails(props.details);
	return Boolean(
		props.phase === "settled" &&
		isJobPoll(props.args) &&
		details &&
		(details.agents?.length ?? 0) === 0 &&
		(details.jobs?.length ?? 0) > 0 &&
		jobsForDisplay(props).length === 0,
	);
}

/** Describe the job operation while ids are still streaming and no snapshot exists. */
export function jobCallDescription(args: HubViewProps["args"]): string {
	const ids = args.ids ?? [];
	if (args.op === "jobs") return "background jobs";
	if (args.op === "cancel")
		return ids.length === 1 ? `cancel ${ids[0]}` : ids.length > 0 ? `cancel ${ids.length} jobs` : "all running jobs";
	return ids.length === 1 ? `poll ${ids[0]}` : ids.length > 0 ? `poll ${ids.length} jobs` : "all running jobs";
}

/** Summarize active and settled jobs for the shared hub header. */
export function jobDescription(
	jobs: readonly DeepReadonly<JobSnapshot>[],
	agents: readonly DeepReadonly<AgentActivitySnapshot>[],
): string {
	if (jobs.length === 0) return `${agents.length} running agent${agents.length === 1 ? "" : "s"} — no jobs`;
	let running = 0;
	for (const job of jobs) if (job.status === "running") running++;
	const noun = jobs.length === 1 ? "job" : "jobs";
	if (running === 0) return `${jobs.length} ${noun} settled`;
	return running === jobs.length
		? `waiting on ${jobs.length} ${noun}`
		: `waiting on ${running} of ${jobs.length} ${noun}`;
}

/** Count completion, failure, cancellation, and detached-agent header badges. */
export function jobMeta(
	jobs: readonly DeepReadonly<JobSnapshot>[],
	agents: readonly DeepReadonly<AgentActivitySnapshot>[],
): readonly { text: string; color: ThemeColor }[] {
	const parts: { text: string; color: ThemeColor }[] = [];
	let completed = 0;
	let failed = 0;
	let cancelled = 0;
	for (const job of jobs) {
		if (job.status === "completed") completed++;
		else if (job.status === "failed") failed++;
		else if (job.status === "cancelled") cancelled++;
	}
	if (completed) parts.push({ text: `${completed} done`, color: "success" });
	if (failed) parts.push({ text: `${failed} failed`, color: "error" });
	if (cancelled) parts.push({ text: `${cancelled} cancelled`, color: "warning" });
	if (agents.length > 0 && jobs.length > 0)
		parts.push({ text: `${agents.length} agent${agents.length === 1 ? "" : "s"}`, color: "accent" });
	return parts;
}

function jobStatus(status: JobSnapshot["status"]): ToolUIStatus {
	if (status === "completed") return "done";
	if (status === "failed") return "error";
	return status === "cancelled" ? "aborted" : "running";
}

function jobColor(status: JobSnapshot["status"]): ThemeColor {
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	return status === "cancelled" ? "warning" : "accent";
}

function jobPreview(text: string, limit: number): readonly string[] {
	const resultBody = text.startsWith("<task-result")
		? /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(text)?.[2]?.trim() || text
		: text;
	const flattened =
		resultBody.startsWith("{") || resultBody.startsWith("[")
			? resultBody.slice(0, 640).replace(/\s+/g, " ")
			: resultBody;
	return flattened
		.split("\n")
		.map(line => replaceTabs(line).trim())
		.filter(Boolean)
		.slice(0, limit);
}

function JobRow(props: { readonly job: DeepReadonly<JobSnapshot>; readonly expanded: boolean }): JSX.Element {
	const { theme } = useTheme();
	const labels = createMemo(() => {
		const all = replaceTabs(props.job.label || "(no label)").split(/\r?\n/);
		const limit = props.expanded ? JOB_LABEL_LINES_EXPANDED : JOB_LABEL_LINES_COLLAPSED;
		const visible = all.slice(0, limit);
		if (all.length > limit && visible.length > 0) visible[visible.length - 1] = `${visible[visible.length - 1]} …`;
		return visible;
	});
	const preview = createMemo(() =>
		jobPreview(
			props.job.errorText || props.job.resultText || "",
			props.expanded ? JOB_PREVIEW_LINES_EXPANDED : JOB_PREVIEW_LINES_COLLAPSED,
		),
	);
	const model = createMemo(() => {
		if (props.job.type !== "task" || !isFeedModelBadgeEnabled()) return undefined;
		const identity = props.job.resolvedModelIdentity ?? props.job.resolvedModel;
		if (!identity) return undefined;
		const thinking =
			props.job.resolvedThinkingLevel === undefined
				? ""
				: `${thinkingLevelGlyph(props.job.resolvedThinkingLevel, theme())} `;
		return `${thinking}${identity}${props.job.advisor ? ` ${theme().symbol("icon.advisor")}` : ""}`;
	});
	const artifactError = createMemo(() => {
		const artifact = props.job.meta?.artifactError ?? props.job.artifactError;
		return artifact ? formatArtifactErrorNotice(artifact) : undefined;
	});
	const distinctLabel = createMemo(() => props.job.label.trim() !== props.job.id);
	return (
		<stack gap={0}>
			<Show
				when={distinctLabel() && labels().length > 0}
				fallback={
					<text wrap="clip" overflow="ellipsis">
						<status value={jobStatus(props.job.status)} />{" "}
						<badge color={jobColor(props.job.status)}>{props.job.type}</badge>{" "}
						<Show when={model()}>{(value: Accessor<string>) => <badge color="muted">{value()} </badge>}</Show>
						<span color="toolOutput">{replaceTabs(props.job.id)}</span>
						{" · "}
						<span color="dim">{formatDuration(props.job.durationMs)}</span>
					</text>
				}
			>
				<row gap={0} pad={false} wrap="continuation" continuationIndent={1}>
					<text shrink={0} wrap="none">
						<status value={jobStatus(props.job.status)} />{" "}
						<badge color={jobColor(props.job.status)}>{props.job.type}</badge>{" "}
						<Show when={model()}>{(value: Accessor<string>) => <badge color="muted">{value()} </badge>}</Show>
						<span color="toolOutput">{replaceTabs(props.job.id)}</span>
					</text>
					<text
						color="toolOutput"
						grow={1}
						minWidth={1}
						wrap="clip"
						overflow="ellipsis"
						ellipsisColor="toolOutput"
					>
						{" "}
						{labels()[0]}
					</text>
					<text shrink={0} wrap="none">
						{" · "}
						<span color="dim">{formatDuration(props.job.durationMs)}</span>
					</text>
				</row>
			</Show>
			<For each={labels().slice(1)}>
				{line => (
					<text color="toolOutput" wrap="clip" overflow="ellipsis" ellipsisColor="toolOutput">
						{"  "}
						{line}
					</text>
				)}
			</For>
			<Show when={artifactError()}>{(value: Accessor<string>) => <text color="warning">{value()}</text>}</Show>
			<For each={preview()}>
				{line => (
					<text
						color={props.job.errorText ? "error" : "dim"}
						wrap="clip"
						overflow="ellipsis"
						ellipsisColor={props.job.errorText ? "error" : "dim"}
					>
						{"  "}
						{line}
					</text>
				)}
			</For>
		</stack>
	);
}

function AgentRow(props: { readonly agent: DeepReadonly<AgentActivitySnapshot> }): JSX.Element {
	return (
		<row gap={1}>
			<status value={props.agent.live ? "running" : "warning"} />
			<badge color={props.agent.live ? "accent" : "warning"}>{props.agent.live ? "agent" : "agent · no turn"}</badge>
			<text color="muted" grow={1} minWidth={1} wrap="none" overflow="ellipsis">
				{replaceTabs(props.agent.id)}
			</text>
			<Show when={props.agent.activity}>
				{(activity: Accessor<string>) => (
					<text color="toolOutput" grow={1} minWidth={1} wrap="none" overflow="ellipsis">
						{replaceTabs(activity())}
					</text>
				)}
			</Show>
			<text color="dim">{formatDuration(props.agent.ageMs)}</text>
			<Show when={props.agent.parentId}>{(value: Accessor<string>) => <text color="dim">← {value()}</text>}</Show>
		</row>
	);
}

/** Render bounded job results and active-agent rows for hub polling operations. */
export function JobsBody(props: { readonly call: HubViewProps; readonly expanded: boolean }): JSX.Element {
	const details = createMemo(() => coordinationDetails(props.call.details));
	const jobs = createMemo(() => jobsForDisplay(props.call));
	const agents = createMemo(() => details()?.agents ?? []);
	const aggregateError = createMemo(() => {
		const artifact = details()?.meta?.artifactError;
		if (!artifact || details()?.meta?.source?.type === "report")
			return artifact ? formatArtifactErrorNotice(artifact) : undefined;
		return (details()?.jobs ?? []).some(job => (job.meta?.artifactError ?? job.artifactError) === artifact)
			? undefined
			: formatArtifactErrorNotice(artifact);
	});
	return (
		<stack gap={0}>
			<Show
				when={jobs().length > 0 || agents().length > 0}
				fallback={
					<Show when={props.call.phase === "settled"}>
						<text color={props.call.outcome === "failed" ? "error" : "dim"}>
							{outputText(props.call) || "No jobs to process"}
						</text>
					</Show>
				}
			>
				<Show when={aggregateError()}>{(value: Accessor<string>) => <text color="warning">{value()}</text>}</Show>
				<Show when={jobs().length > 0}>
					<TreeList
						items={jobs()}
						expanded={props.expanded}
						maxCollapsed={COLLAPSED_ITEM_LIMIT}
						itemType="job"
						renderItem={job => <JobRow job={job} expanded={props.expanded} />}
					/>
				</Show>
				<Show when={agents().length > 0}>
					<TreeList
						items={agents()}
						expanded={props.expanded}
						maxCollapsed={COLLAPSED_ITEM_LIMIT}
						itemType="agent"
						renderItem={agent => <AgentRow agent={agent} />}
					/>
				</Show>
			</Show>
		</stack>
	);
}
