import type { TextContent } from "@oh-my-pi/pi-ai";
import { createDocument } from "../document/document";
import { ErrorBoundary, type JSX } from "../reactive";
import type { HookMessage } from "./messages";

const HOOK_COLLAPSED_LINES = 5;

export interface HookMessageViewProps {
	readonly message: HookMessage<unknown>;
	readonly expanded: boolean;
	/** A hook-provided declarative renderer that replaces the default frame. */
	readonly content?: JSX.Element;
}

function hookMessageText(message: HookMessage<unknown>): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((item): item is TextContent => item.type === "text")
				.map(item => item.text)
				.join("\n");
}

function collapsedHookMessageText(text: string): string {
	const lines = text.split("\n");
	return lines.length > HOOK_COLLAPSED_LINES ? `${lines.slice(0, HOOK_COLLAPSED_LINES).join("\n")}\n…` : text;
}

function DefaultHookMessageView(props: Pick<HookMessageViewProps, "message" | "expanded">): JSX.Element {
	const text = hookMessageText(props.message);
	const shown = props.expanded ? text : collapsedHookMessageText(text);
	return (
		<box background="customMessageBg" border={{ style: "round", color: "borderMuted" }} padding={1}>
			<stack gap={1}>
				<text bold color="customMessageLabel">
					{props.message.customType}
				</text>
				<markdown document={createDocument(shown)} color="customMessageText" options={{ ignoreTight: true }} />
			</stack>
		</box>
	);
}

/** Legacy hook message frame with an optional hook-provided declarative replacement. */
export function HookMessageView(props: HookMessageViewProps): JSX.Element {
	const fallback = <DefaultHookMessageView message={props.message} expanded={props.expanded} />;
	if (props.content === undefined || props.content === null || props.content === false) return fallback;
	return <ErrorBoundary fallback={fallback}>{props.content}</ErrorBoundary>;
}
