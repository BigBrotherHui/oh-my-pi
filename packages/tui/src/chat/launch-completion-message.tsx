import { formatDuration, isRecord } from "@oh-my-pi/pi-utils";
import { useTheme, type JSX } from "../reactive";
import type { CustomMessage } from "./messages";

interface LaunchCompletionDaemon {
	readonly name: string;
	readonly state: string;
	readonly startedAt?: number;
	readonly exitedAt?: number;
	readonly exitCode?: number;
}

/**
 * Compact terminal notice emitted when a broker-supervised process exits.
 *
 * This intentionally remains a plain transcript row rather than the generic
 * custom-message card: launch notifications are tool activity and historically
 * shared the compact background-job presentation.
 */
export function LaunchCompletionMessageView(props: { readonly message: CustomMessage<unknown> }): JSX.Element {
	const theme = useTheme();
	const daemons = launchCompletionDaemons(props.message.details);
	const fallback =
		daemons.length === 0 && typeof props.message.content === "string" ? props.message.content : undefined;

	return (
		<stack>
			{fallback === undefined ? null : (
				<text color="dim" wrap="word">{` ${theme.symbol("status.done")} ${fallback}`}</text>
			)}
			{daemons.map(daemon => (
				<LaunchCompletionDaemonRow daemon={daemon} />
			))}
		</stack>
	);
}

function LaunchCompletionDaemonRow(props: { readonly daemon: LaunchCompletionDaemon }): JSX.Element {
	const theme = useTheme();
	const failed =
		props.daemon.state === "failed" || (props.daemon.exitCode !== undefined && props.daemon.exitCode !== 0);
	const duration = completionDuration(props.daemon);
	return (
		<text wrap="none" overflow="ellipsis">
			<span color={failed ? "error" : "success"}>
				{` ${theme.symbol(failed ? "status.error" : "status.done")} Supervised process ${failed ? "failed" : "completed"}`}
			</span>
			<span> </span>
			<span color="accent">{props.daemon.name}</span>
			{props.daemon.exitCode === undefined ? null : <span color="dim">{` (exit ${props.daemon.exitCode})`}</span>}
			{duration === undefined ? null : <span color="dim">{` (${duration})`}</span>}
		</text>
	);
}

function launchCompletionDaemons(details: unknown): readonly LaunchCompletionDaemon[] {
	if (!isRecord(details) || !Array.isArray(details.daemons)) return [];
	return details.daemons.filter(isLaunchCompletionDaemon);
}

function isLaunchCompletionDaemon(value: unknown): value is LaunchCompletionDaemon {
	if (!isRecord(value) || typeof value.name !== "string" || typeof value.state !== "string") return false;
	return (
		(value.startedAt === undefined || typeof value.startedAt === "number") &&
		(value.exitedAt === undefined || typeof value.exitedAt === "number") &&
		(value.exitCode === undefined || typeof value.exitCode === "number")
	);
}

function completionDuration(daemon: LaunchCompletionDaemon): string | undefined {
	if (daemon.startedAt === undefined || daemon.exitedAt === undefined) return undefined;
	return formatDuration(daemon.exitedAt - daemon.startedAt);
}
