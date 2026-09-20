import type { ConfiguredThinkingLevel } from "../render/render-utils";
import type { OutputMeta } from "./output-meta";
import type { StructuredSubagentOutput } from "./task";
import type { DeepReadonly } from "./view";

/** Whether a wait snapshot contains only running jobs and no cancellations. */
export function isWaitingPollDetails(details: unknown): boolean {
	if (typeof details !== "object" || details === null || !("jobs" in details)) return false;
	const jobs = details.jobs;
	if (!Array.isArray(jobs) || jobs.length === 0) return false;
	if ("cancelled" in details && Array.isArray(details.cancelled) && details.cancelled.length > 0) return false;
	return jobs.every(job => typeof job === "object" && job !== null && "status" in job && job.status === "running");
}

/** Operation names accepted by hub coordination and process dispatch. */
export type HubOp =
	| "send"
	| "wait"
	| "inbox"
	| "list"
	| "jobs"
	| "cancel"
	| "start"
	| "ps"
	| "logs"
	| "stop"
	| "restart"
	| "describe";

/** Addressable peer metadata returned by hub roster queries. */
export interface HubPeerInfo {
	id: string;
	displayName: string;
	kind: string;
	status: string;
	parentId?: string;
	unread: number;
	lastActivity: number;
	activity?: string;
}

/** Peer lifecycle filters shared by roster queries and views. */
export type HubListStatus = "running" | "idle" | "parked";
/** Default peer-page size shared by hub schema and execution. */
export const DEFAULT_HUB_LIST_LIMIT = 32;
/** Maximum peer-page size accepted by hub roster queries. */
export const MAX_HUB_LIST_LIMIT = 100;

/** Roster totals that distinguish filtering from page truncation. */
export interface HubRosterCounts {
	running: number;
	idle: number;
	parked: number;
	shown: number;
	truncated: number;
}

/** Background-job lifecycle and result metadata shared by hub delivery and views. */
export interface JobSnapshot {
	id: string;
	type: "bash" | "task" | "eval";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	resolvedModel?: string;
	resolvedModelIdentity?: string;
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	advisor?: boolean;
	resultText?: string;
	errorText?: string;
	meta?: OutputMeta;
	artifactError?: OutputMeta["artifactError"];
	structured?: StructuredSubagentOutput;
	agentUrlId?: string;
}

/** Cancellation outcomes reported by the background-job manager. */
export type CancelStatus = "cancelled" | "not_found" | "already_completed";
/** One cancellation outcome and its user-facing explanation. */
export interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

/** Active subagent metadata shown when no background-job row owns the agent. */
export interface AgentActivitySnapshot {
	id: string;
	parentId?: string;
	activity?: string;
	ageMs: number;
	live: boolean;
	acceptedAt?: number;
}

/** Messaging, roster, and job result fields consumed by hub presentations. */
export interface CoordinationDetails {
	meta?: OutputMeta;
	op: HubOp;
	from?: string;
	to?: string;
	receipts?: IrcDeliveryReceipt[];
	waited?: IrcMessage | null;
	inbox?: IrcMessage[];
	peers?: HubPeerInfo[];
	counts?: HubRosterCounts;
	jobs?: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
	agents?: AgentActivitySnapshot[];
}

/** Hub result union separating coordination from supervised processes. */
export type HubDetails = CoordinationDetails | LaunchToolDetails;

/** Partially streamed hub arguments used before execution settles. */
export type HubRenderArgs = {
	op?: string;
	to?: string;
	message?: string;
	replyTo?: string;
	await?: boolean;
	from?: string;
	peek?: boolean;
	ids?: string[];
} & Partial<Omit<LaunchParams, "op">>;

/** Supervised-process states shared by the broker, CLI, and retained views. */
export type DaemonState = "starting" | "running" | "ready" | "restarting" | "stopping" | "exited" | "failed";
/** Restart policy retained by a supervised process specification. */
export type DaemonRestartPolicy = "no" | "on-failure" | "always";

/** Readiness conditions that must all pass before a process becomes ready. */
export interface DaemonReadySpec {
	log?: string;
	port?: number;
	host?: string;
	timeoutMs: number;
}

/** Launch settings retained for process restart and inspection. */
export interface DaemonSpec {
	name: string;
	application: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	pty: boolean;
	ready?: DaemonReadySpec;
	restart: DaemonRestartPolicy;
	persist: boolean;
	detached: boolean;
}

/** Serializable supervised-process state exposed to broker clients and views. */
export interface DaemonSnapshot {
	name: string;
	id: string;
	state: DaemonState;
	pid?: number;
	createdAt: number;
	startedAt: number;
	readyAt?: number;
	exitedAt?: number;
	exitCode?: number;
	exitReason?: string;
	restartCount: number;
	outputBytes: number;
	owner?: string;
	readyMatch?: string;
	readyPending?: ("log" | "port")[];
	persist: boolean;
	detached: boolean;
}

/** Peer message metadata and body retained in hub delivery snapshots. */
export interface IrcMessage {
	id: string;
	from: string;
	to: string;
	body: string;
	ts: number;
	replyTo?: string;
	wakeRelay?: boolean;
}

/** Per-recipient delivery outcome used by hub send results. */
export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}

/** Broker launch parameters; hub translates its ps operation into list. */
export interface LaunchParams {
	op: "start" | "list" | "logs" | "wait" | "send" | "stop" | "restart" | "describe";
	name?: string;
	application?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	pty?: boolean;
	ready?: { log?: string; port?: number; host?: string; timeout?: number };
	restart?: "no" | "on-failure" | "always";
	persist?: boolean;
	detached?: boolean;
	lines?: number;
	head?: boolean;
	grep?: string;
	follow?: boolean;
	cursor?: number;
	for?: "ready" | "exit";
	pattern?: string;
	text?: string;
	enter?: boolean;
	keys?: string[];
	signal?: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGKILL";
	timeout?: number;
}

/** Process-supervision result metadata retained for compact hub rendering. */
export interface LaunchToolDetails {
	op: LaunchParams["op"];
	daemon?: DaemonSnapshot;
	daemons?: DaemonSnapshot[];
	cursor?: number;
	timedOut?: boolean;
	state?: DaemonState;
	terminalRows?: string[];
	matched?: string;
	spec?: DaemonSpec;
}

/** Describe unmet readiness conditions with their configured log or port target. */
export function readyPendingSummary(
	daemon: Pick<DeepReadonly<DaemonSnapshot>, "readyPending">,
	ready?: Readonly<Pick<NonNullable<LaunchParams["ready"]>, "log" | "port" | "host">>,
): string[] {
	const parts: string[] = [];
	for (const condition of daemon.readyPending ?? []) {
		if (condition === "log")
			parts.push(ready?.log ? `log pattern /${ready.log}/ never matched` : "the log pattern never matched");
		else
			parts.push(
				ready?.port !== undefined
					? `port ${ready.port} on ${ready.host ?? "127.0.0.1"} never accepted connections`
					: "the port never accepted connections",
			);
	}
	return parts;
}

/** Explain whether a process wait is blocked on output, readiness, or exit. */
export function waitPendingSummary(
	daemon: Pick<DeepReadonly<DaemonSnapshot>, "state" | "readyPending">,
	params: Readonly<Pick<LaunchParams, "for" | "pattern">>,
): string[] {
	if (params.pattern) return [`output pattern /${params.pattern}/ never matched`];
	if ((params.for ?? "exit") === "exit") return [`process exit (still ${daemon.state})`];
	const pending = readyPendingSummary(daemon);
	return pending.length > 0 ? pending : [`readiness (still ${daemon.state})`];
}

/** Roster order shared by hub views and live-agent prompt limits. */
export const LIST_STATUS_ORDER: Record<string, number> = { running: 0, idle: 1, parked: 2 };
