import { Style } from "../core/style";
import { formatAge } from "../render/render-utils";
import { createMemo, For, type JSX, useClock, useTheme } from "../reactive";
import type { ThemeColor } from "../theme/theme";
import { ToolHeader } from "../view/tool-header";
import type { ToolUIStatus } from "../view/status-icon";
import { jobCallDescription, jobDescription, jobMeta, jobsForDisplay } from "./hub-jobs";
import { daemonColor, processCallMeta } from "./hub-process";
import {
	coordinationDetails,
	currentTime,
	hubPresentationFor,
	isLaunchDetails,
	launchOperation,
	type HubViewProps,
} from "./hub-selection";

/** Map a hub call lifecycle to its common header and compact-summary status. */
export function toolStatus(props: HubViewProps): ToolUIStatus {
	if (props.phase === "receiving" || props.phase === "queued") return "pending";
	if (props.phase === "running") return "running";
	if (props.outcome === "failed") return "error";
	if (props.outcome === "timed_out") return "warning";
	if (props.outcome === "cancelled") return "aborted";
	return props.outcome === "skipped" ? "info" : "done";
}

/** Render the operation-specific hub title and live lifecycle metadata. */
export function HubHeader(props: { readonly call: HubViewProps }): JSX.Element {
	const { theme } = useTheme();
	const tick = useClock("second");
	const presentation = createMemo(() => hubPresentationFor(props.call.args, props.call.details));
	const coordination = createMemo(() => coordinationDetails(props.call.details));
	const launch = createMemo(() => (isLaunchDetails(props.call.details) ? props.call.details : undefined));
	const jobs = createMemo(() => jobsForDisplay(props.call));
	const agents = createMemo(() => coordination()?.agents ?? []);
	const now = createMemo(() => currentTime(props.call, tick));
	const status = createMemo<ToolUIStatus>(() => {
		if (presentation() === "jobs") {
			if (props.call.phase !== "settled") return "pending";
			if (jobs().some(job => job.status === "failed")) return "warning";
			if (jobs().some(job => job.status === "running") || agents().length > 0) return "running";
		}
		if (presentation() === "launch") {
			if (launch()?.daemon?.state === "failed") return "error";
			if (props.call.phase !== "settled") return "running";
		}
		if (presentation() === "messaging" && props.call.phase !== "settled") return "pending";
		if (presentation() === "messaging" && props.call.args.op === "wait" && !coordination()?.waited) return "warning";
		const result = toolStatus(props.call);
		return result === "done" ? "success" : result;
	});
	const label = createMemo(() => {
		if (presentation() === "jobs")
			return jobs().length > 0 || agents().length > 0
				? jobDescription(jobs(), agents())
				: jobCallDescription(props.call.args);
		if (presentation() === "launch") {
			const operation = launchOperation(props.call.args, launch()) ?? "…";
			const target = launch()?.daemon?.name ?? props.call.args.name ?? props.call.args.application;
			return target ? (
				<>
					<span color="accent">Launch {operation}</span>: <span color="muted">{target}</span>
				</>
			) : (
				<span color="accent">Launch {operation}</span>
			);
		}
		if (props.call.args.op === "send") {
			const target =
				props.call.phase === "settled" ? (coordination()?.to ?? props.call.args.to) : props.call.args.to;
			return `IRC ${theme().nav.selected} ${target?.trim() || "…"}`;
		}
		if (props.call.args.op === "wait") return `IRC ${theme().nav.back} ${props.call.args.from?.trim() || "anyone"}`;
		if (props.call.args.op === "inbox") return "IRC inbox";
		return props.call.args.op === "list" ? "IRC peers" : "Hub";
	});
	const counts = createMemo(() => jobMeta(jobs(), agents()));
	const meta = createMemo<readonly { text: string; color?: ThemeColor; before?: ThemeColor }[]>(() => {
		if (presentation() === "jobs") return [];
		const details = coordination();
		const op = details?.op ?? props.call.args.op;
		const parts: { text: string; color?: ThemeColor; before?: ThemeColor }[] = [];
		if (presentation() === "messaging") {
			if (op === "send") {
				if (props.call.phase !== "settled") {
					if (props.call.args.to === "all") parts.push({ text: "broadcast", color: "dim" });
					if (props.call.args.await) parts.push({ text: "await reply", color: "dim" });
					if (props.call.args.replyTo) parts.push({ text: "reply", color: "dim" });
				}
				const receipts = details?.receipts ?? [];
				if (receipts.length === 1) {
					const receipt = receipts[0]!;
					const color: ThemeColor =
						receipt.outcome === "woken"
							? "success"
							: receipt.outcome === "revived"
								? "warning"
								: receipt.outcome === "failed"
									? "error"
									: "accent";
					parts.push({ text: receipt.outcome, color });
				}
				if (receipts.length > 1) {
					const delivered = receipts.filter(receipt => receipt.outcome !== "failed").length;
					const failed = receipts.length - delivered;
					if (delivered) parts.push({ text: `${delivered} delivered`, color: "success" });
					if (failed) parts.push({ text: `${failed} failed`, color: "error" });
				}
				if (details?.waited === null) parts.push({ text: "no reply", color: "warning" });
			}
			if (op === "wait") {
				if (details?.waited?.ts)
					parts.push({
						text: formatAge(Math.max(1, Math.round((now() - details.waited.ts) / 1_000))),
						color: "dim",
					});
				else if (props.call.phase === "settled") parts.push({ text: "timed out", color: "dim" });
			}
			if (op === "inbox") {
				if (details?.inbox)
					parts.push({
						text: `${details.inbox.length} ${details.inbox.length === 1 ? "message" : "messages"}`,
						color: "dim",
					});
				if (props.call.args.peek) parts.push({ text: "peek", color: "dim" });
			}
			if (op === "list") {
				const roster = details?.counts;
				if (roster) {
					parts.push(
						{ text: `${roster.running} running`, color: "dim" },
						{ text: `${roster.idle} idle`, color: "dim" },
						{ text: `${roster.parked} parked`, color: "dim" },
					);
					if (roster.truncated > 0) parts.push({ text: `${roster.truncated} truncated`, color: "dim" });
				} else {
					const peers = details?.peers ?? [];
					const idle = peers.filter(peer => peer.status === "idle").length;
					const parked = peers.filter(peer => peer.status === "parked").length;
					const unread = peers.reduce((total, peer) => total + peer.unread, 0);
					if (idle > 0) parts.push({ text: `${idle} idle`, color: "dim" });
					if (parked > 0) parts.push({ text: `${parked} parked`, color: "dim" });
					if (unread > 0) parts.push({ text: `${unread} unread`, color: "warning" });
				}
			}
			return parts;
		}
		if (props.call.outcome === "failed") return [];
		const launchDetails = launch();
		if (launchOperation(props.call.args, launchDetails) === "logs") {
			if (props.call.phase !== "settled") {
				for (const text of processCallMeta(props.call.args)) parts.push({ text, color: "dim" });
			} else {
				if (launchDetails?.state)
					parts.push({ text: launchDetails.state, color: daemonColor(launchDetails.state) });
				if (launchDetails?.cursor !== undefined) parts.push({ text: `cursor ${launchDetails.cursor}` });
				if (launchDetails?.timedOut) parts.push({ text: "follow timed out", color: "warning" });
			}
			return parts;
		}
		for (const text of processCallMeta(props.call.args)) parts.push({ text, color: "dim" });
		const daemon = launchDetails?.daemon;
		if (!daemon) return parts;
		parts.push({ text: daemon.state, color: daemonColor(daemon.state), before: "dim" });
		if (daemon.readyPending?.length)
			parts.push({ text: `waiting on ${daemon.readyPending.join("+")}`, color: "warning" });
		if (daemon.exitCode !== undefined)
			parts.push({ text: `exit ${daemon.exitCode}`, color: daemon.exitCode === 0 ? "muted" : "error" });
		else if (daemon.pid !== undefined) parts.push({ text: `pid ${daemon.pid}` });
		const elapsed = Math.max(0, (daemon.exitedAt ?? now()) - daemon.startedAt);
		parts.push({ text: `${daemon.exitedAt === undefined ? "up" : "ran"} ${Math.round(elapsed / 100) / 10}s` });
		if (daemon.restartCount > 0) parts.push({ text: `restarts ${daemon.restartCount}` });
		if (daemon.detached) parts.push({ text: "detached" });
		else if (daemon.persist) parts.push({ text: "persistent" });
		return parts;
	});
	return (
		<ToolHeader
			status={status()}
			statusColor={status() === "success" && props.call.args.op && presentation() !== "jobs" ? "accent" : undefined}
			ellipsisStyle={presentation() === "messaging" && props.call.args.op === "list" ? Style.RESET : undefined}
			wrap="none"
			successIcon={
				presentation() === "messaging" && props.call.args.op
					? "tool.irc"
					: presentation() === "launch"
						? "tool.launch"
						: undefined
			}
			label={label()}
			metaStyle="content"
			meta={
				presentation() === "jobs" ? (
					<For each={counts()}>
						{(part, index) => (
							<>
								{index() > 0 ? " · " : ""}
								<span color={part.color}>{part.text}</span>
							</>
						)}
					</For>
				) : meta().length > 0 ? (
					<For each={meta()}>
						{(part, index) => (
							<>
								{index() > 0 ? (
									part.before ? (
										<span color={part.before}> · </span>
									) : presentation() === "messaging" ? (
										<span color="dim"> · </span>
									) : (
										" · "
									)
								) : (
									""
								)}
								<span color={part.color}>{part.text}</span>
							</>
						)}
					</For>
				) : undefined
			}
		/>
	);
}
