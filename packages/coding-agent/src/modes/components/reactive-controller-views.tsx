import "@oh-my-pi/pi-tui/host/intrinsics";
import type { JSX } from "@oh-my-pi/pi-tui/reactive";
import { createDocument } from "@oh-my-pi/pi-tui";
import type { ThemeColor } from "@oh-my-pi/pi-tui/theme";

export function CommandMarkdownPanelView(props: { readonly title: string; readonly markdown: string }): JSX.Element {
	const document = createDocument(props.markdown.trim());
	return (
		<box recipe="tool.card.queued" padding={1}>
			<stack gap={1}>
				<text color="accent" bold>
					{props.title}
				</text>
				<markdown document={document} />
			</stack>
		</box>
	);
}

export function CommandPanelView(props: { readonly title: string; readonly content: JSX.Element }): JSX.Element {
	return (
		<box recipe="tool.card.queued" padding={1}>
			<stack gap={1}>
				<text color="accent" bold>
					{props.title}
				</text>
				{props.content}
			</stack>
		</box>
	);
}

/** Render command feedback with native semantic text styling. */
export function CommandNoticeView(props: {
	readonly text: string;
	readonly color?: ThemeColor;
	readonly italic?: boolean;
}): JSX.Element {
	return (
		<text color={props.color ?? "accent"} italic={props.italic}>
			{props.text}
		</text>
	);
}

export function BusyView(props: { readonly message: string }): JSX.Element {
	return (
		<row gap={1} color="muted">
			<spinner type="status" />
			<text>{props.message}</text>
		</row>
	);
}

export function McpAuthorizationLinkView(props: { readonly url: string; readonly launchUrl?: string }): JSX.Element {
	return (
		<stack gap={1}>
			<text color="success">Open authorization URL:</text>
			<text color="accent" underline link={props.url}>
				Click here to authorize
			</text>
			<text color="muted" wrap="word">
				Copy URL: {props.url}
			</text>
			{props.launchUrl && props.launchUrl !== props.url ? (
				<text color="muted" wrap="word">
					Local shortcut (this machine only): {props.launchUrl}
				</text>
			) : null}
		</stack>
	);
}

export function McpAuthorizationView(props: {
	readonly url: string;
	readonly launchUrl?: string;
	readonly manualLoginTip: string;
}): JSX.Element {
	return (
		<box recipe="tool.card.running" padding={1}>
			<stack gap={1}>
				<text color="accent" bold>
					OAuth Authorization Required
				</text>
				<text color="muted">Preparing browser authorization…</text>
				<text color="muted">Waiting for authorization… Press Esc to cancel; 5 minute timeout.</text>
				<text color="muted">{props.manualLoginTip}</text>
				<text color="success">Attempting to open browser…</text>
				<text color="muted">Alternative if browser did not open:</text>
				<McpAuthorizationLinkView url={props.url} launchUrl={props.launchUrl} />
			</stack>
		</box>
	);
}

export function McpConnectingView(props: { readonly serverName: string; readonly status?: string }): JSX.Element {
	return (
		<row gap={1} color="muted">
			<spinner type="status" />
			<text>{props.status ?? `Connecting to "${props.serverName}"…`}</text>
		</row>
	);
}

export function ExtensionWidgetTextView(props: {
	readonly lines: readonly string[];
	readonly truncated: boolean;
}): JSX.Element {
	return (
		<stack>
			{props.lines.map(line => (
				<text>{line}</text>
			))}
			{props.truncated ? <text color="muted">… (widget truncated)</text> : null}
		</stack>
	);
}
