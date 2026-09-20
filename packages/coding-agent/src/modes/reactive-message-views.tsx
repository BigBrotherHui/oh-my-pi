import "@oh-my-pi/pi-tui/host/intrinsics";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { JSX } from "@oh-my-pi/pi-tui/reactive";
import type { ThemeColor } from "@oh-my-pi/pi-tui/theme/schema";

export function NoticeView(props: { readonly text: string; readonly color?: ThemeColor }): JSX.Element {
	return <text color={props.color ?? "dim"}>{props.text}</text>;
}

export function FileMentionsView(props: {
	readonly files: Extract<AgentMessage, { role: "fileMention" }>["files"];
}): JSX.Element {
	return (
		<stack>
			{props.files.map(file => (
				<row gap={1}>
					<icon name="cmd.folderPlus" color="accent" />
					<path value={file.path} grow={1} overflow="middle" />
					<text color="dim">{file.skippedReason ?? `${file.lineCount ?? 0} lines`}</text>
				</row>
			))}
		</stack>
	);
}

export function UpdateAvailableView(props: { readonly version: string }): JSX.Element {
	return (
		<box recipe="tool.card.queued" padding={1}>
			<stack gap={1}>
				<text color="warning" bold>
					Update Available
				</text>
				<text>{`New version ${props.version} is available. Run: omp update`}</text>
			</stack>
		</box>
	);
}

export function PendingMessagesView(props: {
	readonly groups: readonly { readonly label: string; readonly messages: readonly string[] }[];
}): JSX.Element {
	return (
		<stack>
			{props.groups.map(group => (
				<stack>
					<text color="dim">{`${group.label} · ${group.messages.length}`}</text>
					{group.messages.map((message, index) => (
						<text color="dim">{`  ${index + 1}. ${message.replace(/\r?\n/g, " ↵ ")}`}</text>
					))}
				</stack>
			))}
		</stack>
	);
}
