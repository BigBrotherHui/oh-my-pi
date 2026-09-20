import type { DeepReadonly, ToolViewProps } from "./view";
import type { CoordinationDetails, HubDetails, HubRenderArgs, JobSnapshot, LaunchToolDetails } from "./hub-contract";

/** Reactive call contract shared by the hub's three operation views. */
export type HubViewProps = ToolViewProps<HubRenderArgs, HubDetails>;
/** Partial streamed arguments used to select a hub presentation. */
export type HubArgs = HubViewProps["args"];
/** Distinct hub operation families with independent result bodies. */
export type HubPresentation = "jobs" | "launch" | "messaging";

/** Distinguish supervised-process snapshots from coordination results. */
export function isLaunchDetails(details: HubViewProps["details"]): details is DeepReadonly<LaunchToolDetails> {
	return Boolean(
		details &&
		("daemon" in details ||
			"daemons" in details ||
			"terminalRows" in details ||
			"spec" in details ||
			"state" in details ||
			"cursor" in details),
	);
}

/** Expose coordination fields only for messaging and background-job results. */
export function coordinationDetails(details: HubViewProps["details"]): DeepReadonly<CoordinationDetails> | undefined {
	return !details || isLaunchDetails(details) ? undefined : details;
}

function isLaunchStyleArgs(args: HubArgs): boolean {
	if (["start", "ps", "logs", "stop", "restart", "describe"].includes(args.op ?? "")) return true;
	return (args.op === "send" || args.op === "wait") && Boolean(args.name) && !args.to && !args.from;
}

function isJobStyleArgs(args: HubArgs): boolean {
	return (
		args.op === "jobs" ||
		args.op === "cancel" ||
		(args.op === "wait" && (Boolean(args.ids?.length) || (!args.from && !args.name)))
	);
}

/** Canonical disambiguation for overlapping send and wait operations. */
export function hubPresentationFor(args: HubArgs, details: HubViewProps["details"]): HubPresentation {
	if (isLaunchDetails(details) || isLaunchStyleArgs(args)) return "launch";
	return isJobStyleArgs(args) ? "jobs" : "messaging";
}

/** Identify a job poll rather than a peer or supervised-process wait. */
export function isJobPoll(args: HubArgs): boolean {
	return args.op === "wait" && !args.from && !args.name;
}

/** Resolve the broker operation represented by a supervised-process call. */
export function launchOperation(
	args: HubArgs,
	details: DeepReadonly<LaunchToolDetails> | undefined,
): string | undefined {
	const op = details?.op ?? args.op;
	return op === "ps" ? "list" : op;
}

/** Read document output while tracking its streaming revision. */
export function outputText(props: HubViewProps): string {
	props.output.version();
	return props.output.text().trimEnd();
}

/** Hold retired rows at their frozen time instead of advancing live durations. */
export function currentTime(props: HubViewProps, tick: () => number): number {
	return props.ui.frozenAt ?? tick();
}

const JOB_STATUS_ORDER: Readonly<Record<JobSnapshot["status"], number>> = {
	running: 0,
	failed: 1,
	cancelled: 2,
	completed: 3,
};

/** Order job rows by active/failure state, then longest-running first. */
export function sortedJobs(jobs: readonly DeepReadonly<JobSnapshot>[]): readonly DeepReadonly<JobSnapshot>[] {
	return [...jobs].sort(
		(left, right) =>
			JOB_STATUS_ORDER[left.status] - JOB_STATUS_ORDER[right.status] || right.durationMs - left.durationMs,
	);
}
