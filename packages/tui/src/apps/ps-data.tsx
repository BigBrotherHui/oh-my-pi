import * as path from "node:path";
import "../host/intrinsics";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { For, Show, type JSX } from "../reactive";
import type { DaemonSnapshot, DaemonSpec, DaemonState } from "../tools/hub-contract";
import type { ThemeColor } from "../theme/theme";

/** One broker scope: a project runtime dir or a machine-global service dir. */
export interface PsScope {
	kind: "project" | "global";
	runtimeDir: string;
	projectDir?: string;
	service?: string;
	brokerPid?: number;
}

/** One process snapshot and its table display metadata. */
export interface PsDaemonRow {
	snapshot: DaemonSnapshot;
	/** Launch command from the persisted spec, when readable. */
	command?: string;
	cwd?: string;
	/** Whether omp launched and supervises the process (vs adopted). */
	supervised: boolean;
}

/** Process rows grouped under their owning broker scope. */
export interface PsScopeReport {
	scope: PsScope;
	daemons: PsDaemonRow[];
}

/** Scope selector shared by every ps action: current project, `--dir`, or `--global`. */
export interface PsTarget {
	dir?: string;
	global?: string;
}

/** Process states without a running process or live uptime. */
export const TERMINAL_STATES: Partial<Record<DaemonState, true>> = { exited: true, failed: true };

/** Combine an executable and its arguments for display. */
export function formatCommand(spec: DaemonSpec | undefined): string | undefined {
	return spec ? [spec.application, ...spec.args].join(" ") : undefined;
}

/** Collapse a launch command to one display line (inline scripts embed newlines/tabs). */
export function collapseCommand(command: string | undefined): string {
	return command ? command.replaceAll(/\s+/gu, " ").trim() : "";
}

/** One-line daemon summary used by action results and detail views. */
export function daemonLabel(daemon: DaemonSnapshot): string {
	const pid = daemon.pid === undefined ? "" : ` pid=${daemon.pid}`;
	const exit = daemon.exitCode === undefined ? "" : ` exit=${daemon.exitCode}`;
	return `${daemon.name}: ${daemon.state}${pid}${exit}`;
}

/** Plain STATE cell text, e.g. `ready`, `exited(143)`. */
export function stateCellText(row: PsDaemonRow): string {
	const { snapshot } = row;
	let text = snapshot.state;
	if (TERMINAL_STATES[snapshot.state] && snapshot.exitCode !== undefined) text += `(${snapshot.exitCode})`;
	return text;
}

/** Semantic color associated with a daemon process state. */
export function stateColor(row: PsDaemonRow): ThemeColor {
	const state = row.snapshot.state;
	if (state === "ready" || state === "running") return "success";
	if (state === "failed") return "error";
	if (TERMINAL_STATES[state]) return "dim";
	return "warning";
}

/** Display persistence and supervision flags for a process row. */
export function flagsCell(row: PsDaemonRow): string {
	const parts: string[] = [];
	if (row.snapshot.detached) parts.push("detached");
	else if (row.snapshot.persist) parts.push("persist");
	if (!row.supervised && !TERMINAL_STATES[row.snapshot.state]) parts.push("unsupervised");
	return parts.join(",");
}

/** Display elapsed runtime, or a dash for a terminal process. */
export function uptimeCell(snapshot: DaemonSnapshot, now: number): string {
	if (TERMINAL_STATES[snapshot.state]) return "-";
	return formatDuration(now - snapshot.startedAt);
}

/** Labels aligned with the process table's display cells. */
export const TABLE_HEADER = ["NAME", "STATE", "PID", "UPTIME", "RESTARTS", "FLAGS", "COMMAND"];

export function tableCellsPlain(row: PsDaemonRow, now: number): string[] {
	return [
		row.snapshot.name,
		stateCellText(row),
		row.snapshot.pid !== undefined && !TERMINAL_STATES[row.snapshot.state] ? String(row.snapshot.pid) : "-",
		uptimeCell(row.snapshot, now),
		String(row.snapshot.restartCount),
		flagsCell(row),
		collapseCommand(row.command),
	];
}

/** Scope heading, e.g. `project /work/pi — broker pid 1234`. */
export function ScopeHeaderView(props: { readonly scope: PsScope }): JSX.Element {
	const label = () =>
		props.scope.kind === "global"
			? (props.scope.service ?? path.basename(props.scope.runtimeDir))
			: (props.scope.projectDir ?? path.basename(props.scope.runtimeDir));
	return (
		<text wrap="none">
			{props.scope.kind === "global" ? "global " : "project "}
			<span bold>{label()}</span>
			<span color="dim"> — </span>
			<span color={props.scope.brokerPid === undefined ? "dim" : "success"}>
				{props.scope.brokerPid === undefined ? "broker not running" : `broker pid ${props.scope.brokerPid}`}
			</span>
		</text>
	);
}

/** Complete retained static report shared by `omp ps`'s one-shot output. */
export function PsReportView(props: {
	readonly reports: readonly PsScopeReport[];
	readonly now: number;
	readonly includeAll: boolean;
}): JSX.Element {
	const columns = [
		{ minWidth: 8, maxWidth: 32, overflow: "ellipsis" as const },
		{ minWidth: 7, maxWidth: 16, overflow: "ellipsis" as const },
		{ minWidth: 5, maxWidth: 12, align: "right" as const },
		{ minWidth: 6, maxWidth: 16, align: "right" as const },
		{ minWidth: 8, maxWidth: 12, align: "right" as const },
		{ minWidth: 5, maxWidth: 24, overflow: "ellipsis" as const },
		{ minWidth: 12, grow: 1, overflow: "ellipsis" as const },
	];
	return (
		<stack>
			<Show when={props.reports.length > 0} fallback={<text color="dim">No daemon broker scopes found.</text>}>
				<For each={props.reports}>
					{(report, index) => (
						<stack>
							<Show when={index() > 0}>
								<text>{""}</text>
							</Show>
							<ScopeHeaderView scope={report.scope} />
							<Show when={report.daemons.length > 0} fallback={<text color="dim"> no processes</text>}>
								<box padding={{ left: 2 }}>
									<stack>
										<table rows={[TABLE_HEADER]} columns={columns} gap={2} color="dim" />
										<table
											rows={report.daemons.map(row =>
												tableCellsPlain(row, props.now).map((text, cell) => ({
													text,
													color: cell === 1 ? stateColor(row) : undefined,
												})),
											)}
											columns={columns}
											gap={2}
										/>
									</stack>
								</box>
							</Show>
						</stack>
					)}
				</For>
			</Show>
			<Show when={!props.includeAll && props.reports.length > 0}>
				<text color="dim">Use --all to include other projects and global services.</text>
			</Show>
		</stack>
	);
}
