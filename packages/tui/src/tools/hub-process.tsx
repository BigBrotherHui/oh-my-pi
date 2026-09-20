import { Ellipsis } from "@oh-my-pi/pi-natives";
import { createDocument } from "../document/document";
import { Style } from "../core/style";
import { formatDuration, previewLine, replaceTabs } from "../render/render-utils";
import { createMemo, Match, Show, Switch, useClock, useViewport, type Accessor, type JSX } from "../reactive";
import type { ThemeColor } from "../theme/theme";
import { ExpandHint } from "../view/expand-hint";
import { TreeList } from "../view/tree-list";
import type { ToolUIStatus } from "../view/status-icon";
import type { DaemonSnapshot, DaemonState, DaemonSpec } from "./hub-contract";
import { readyPendingSummary, waitPendingSummary } from "./hub-contract";
import {
	currentTime,
	isLaunchDetails,
	launchOperation,
	outputText,
	type HubArgs,
	type HubViewProps,
} from "./hub-selection";
import type { DeepReadonly } from "./view";

const COLLAPSED_ITEM_LIMIT = 8;
const TERMINAL_PREVIEW_LINES = 10;

/** Select the semantic foreground used by supervised-process state labels. */
export function daemonColor(state: DaemonState): ThemeColor {
	if (state === "ready" || state === "running") return "success";
	if (state === "failed") return "error";
	return state === "exited" ? "muted" : "warning";
}

/** Describe readiness, lifetime, restart, and persistence state for a process row. */
export function daemonMeta(daemon: DeepReadonly<DaemonSnapshot>, now: number): readonly string[] {
	const parts: string[] = [daemon.state];
	if (daemon.readyPending?.length) parts.push(`waiting on ${daemon.readyPending.join("+")}`);
	if (daemon.exitCode !== undefined) parts.push(`exit ${daemon.exitCode}`);
	else if (daemon.pid !== undefined) parts.push(`pid ${daemon.pid}`);
	const elapsed = Math.max(0, (daemon.exitedAt ?? now) - daemon.startedAt);
	parts.push(daemon.exitedAt === undefined ? `up ${formatDuration(elapsed)}` : `ran ${formatDuration(elapsed)}`);
	if (daemon.restartCount > 0) parts.push(`restarts ${daemon.restartCount}`);
	if (daemon.detached) parts.push("detached");
	else if (daemon.persist) parts.push("persistent");
	return parts;
}

/** Summarize the command or wait target of a process-supervision call. */
export function processCallMeta(args: HubArgs): readonly string[] {
	const meta: string[] = [];
	if (args.op === "start" && args.application) meta.push([args.application, ...(args.args ?? [])].join(" "));
	if (args.op === "logs") {
		if (args.follow) meta.push("follow");
		if (args.grep) meta.push(`grep /${args.grep}/`);
	}
	if (args.op === "wait") meta.push(args.pattern ? `for /${args.pattern}/` : `for ${args.for ?? "exit"}`);
	if (args.op === "send") {
		if (args.signal) meta.push(args.signal);
		else if (args.text) meta.push(args.text);
		if (args.keys?.length) meta.push(args.keys.join(" "));
	}
	return meta.map(item => previewLine(replaceTabs(item), 40));
}

/** Render a process snapshot while retaining reactive state and duration labels. */
export function DaemonRow(props: {
	readonly daemon: DeepReadonly<DaemonSnapshot>;
	readonly now: () => number;
}): JSX.Element {
	const status = (): ToolUIStatus =>
		props.daemon.state === "failed"
			? "error"
			: props.daemon.state === "ready" || props.daemon.state === "running"
				? "done"
				: "warning";
	const meta = createMemo(() => daemonMeta(props.daemon, props.now()).join(" · "));
	return (
		<row gap={1}>
			<status value={status()} />
			<text color="accent" grow={1} minWidth={1} wrap="none" overflow="ellipsis">
				{replaceTabs(props.daemon.name)}
			</text>
			<text color={daemonColor(props.daemon.state)}>{meta()}</text>
		</row>
	);
}

/** Render process listings, readiness failures, and native terminal output. */
export function ProcessBody(props: { readonly call: HubViewProps; readonly expanded: boolean }): JSX.Element {
	const viewport = useViewport();
	const tick = useClock("second");
	const details = createMemo(() => (isLaunchDetails(props.call.details) ? props.call.details : undefined));
	const op = createMemo(() => launchOperation(props.call.args, details()));
	const now = createMemo(() => currentTime(props.call, tick));
	const output = createMemo(() => outputText(props.call));
	const daemon = createMemo(() => details()?.daemon);
	const rows = createMemo(() => {
		const terminal = details()?.terminalRows;
		if (terminal !== undefined) return terminal;
		const text = output()
			.replace(/\n?\[[^\n]*\]$/, "")
			.trimEnd();
		return text ? text.split("\n") : [];
	});
	const terminalLimit = createMemo(() =>
		props.expanded
			? Number.MAX_SAFE_INTEGER
			: Math.max(
					1,
					Math.min(
						TERMINAL_PREVIEW_LINES,
						props.call.ui.allocation > 0 ? props.call.ui.allocation : TERMINAL_PREVIEW_LINES,
						Math.max(1, viewport().rows - 12),
					),
				),
	);
	const shownRows = createMemo(() => rows().slice(0, terminalLimit()));
	const terminalDocument = createMemo(() => createDocument(shownRows().join("\n")));
	const pending = createMemo(() => (daemon() ? readyPendingSummary(daemon()!, props.call.args.ready) : []));
	const exitedBeforeReady = createMemo(() =>
		Boolean(
			props.call.args.ready &&
			daemon() &&
			daemon()!.readyAt === undefined &&
			(daemon()!.state === "exited" || daemon()!.state === "failed"),
		),
	);
	const waitPending = createMemo(() => (daemon() ? waitPendingSummary(daemon()!, props.call.args) : []));
	const failed = createMemo(() => props.call.outcome === "failed" || daemon()?.state === "failed");
	return (
		<Show
			when={!failed()}
			fallback={
				<Show
					when={op() === "logs"}
					fallback={<text color="error">{output() || daemon()?.exitReason || "Launch failed."}</text>}
				>
					<stack gap={0}>
						<hr variant="frame" label="Output" />
						<text color="error">{output() || daemon()?.exitReason || "Launch failed."}</text>
					</stack>
				</Show>
			}
		>
			<Switch
				fallback={
					<Show when={output()} fallback={<text color="dim">(no output)</text>}>
						<preview
							document={props.call.output}
							edge="head"
							limit={props.expanded ? Math.max(1, props.call.output.lineCount()) : 3}
							unit="lines"
						/>
					</Show>
				}
			>
				<Match when={op() === "start"}>
					<stack>
						<Show when={daemon()?.readyMatch}>
							{(value: Accessor<string>) => (
								<text color="dim" wrap="clip" overflow="ellipsis" ellipsisStyle={Style.RESET}>
									log matched: {replaceTabs(value())}
								</text>
							)}
						</Show>
						<Show when={details()?.timedOut}>
							<text color="warning">
								{pending().length > 0
									? `Not ready — ${pending().join("; ")}. Still running.`
									: "Readiness timed out; the process is still running."}
							</text>
						</Show>
						<Show when={exitedBeforeReady()}>
							<text color="warning">Process exited before readiness was observed.</text>
						</Show>
					</stack>
				</Match>
				<Match when={op() === "list"}>
					<TreeList
						items={details()?.daemons ?? []}
						expanded={props.expanded}
						maxCollapsed={COLLAPSED_ITEM_LIMIT}
						itemType="process"
						renderItem={item => <DaemonRow daemon={item} now={now} />}
					/>
				</Match>
				<Match when={op() === "logs"}>
					<stack>
						<Show
							when={shownRows().length > 0}
							fallback={
								<Show when={props.call.phase === "settled"}>
									<text color="dim">(no output)</text>
								</Show>
							}
						>
							<hr variant="frame" label="Output" />
							<pre
								document={terminalDocument()}
								ansi
								color="toolOutput"
								wrap={false}
								ellipsis={Ellipsis.Unicode}
							/>
							<Show when={rows().length > shownRows().length}>
								<text color="dim">
									… {rows().length - shownRows().length} more lines{" "}
									<ExpandHint expanded={props.expanded} hasMore />
								</text>
							</Show>
						</Show>
					</stack>
				</Match>
				<Match when={op() === "describe"}>
					<Show when={details()?.spec}>
						{(value: Accessor<DeepReadonly<DaemonSpec>>) => (
							<stack>
								<text color="toolOutput">{replaceTabs([value().application, ...value().args].join(" "))}</text>
								<text color="dim">cwd {replaceTabs(value().cwd)}</text>
								<text color="dim">
									pty {String(value().pty)} · restart {value().restart}
									{value().detached ? " · detached" : value().persist ? " · persistent" : ""}
								</text>
							</stack>
						)}
					</Show>
				</Match>
				<Match when={op() === "wait"}>
					<stack>
						<Show when={details()?.matched}>
							{(value: Accessor<string>) => <text color="dim">matched: {replaceTabs(value())}</text>}
						</Show>
						<Show when={details()?.timedOut}>
							<text color="warning">
								{daemon()
									? `Wait timed out — still waiting on ${waitPending().join("; ")}.`
									: "Wait timed out."}
							</text>
						</Show>
					</stack>
				</Match>
				<Match when={op() === "send" || op() === "stop" || op() === "restart"}>
					<Show when={daemon()}>
						{(value: Accessor<DeepReadonly<DaemonSnapshot>>) => <DaemonRow daemon={value()} now={now} />}
					</Show>
				</Match>
			</Switch>
		</Show>
	);
}
