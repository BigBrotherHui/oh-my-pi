import type { TextContent } from "@oh-my-pi/pi-ai";
import { createDocument } from "../document/document";
import { type JSX, useTheme } from "../reactive";
import { LIVE_DELEGATION_MESSAGE_TYPE, type CustomMessage } from "./messages";

export interface CustomMessageViewProps {
	readonly message: CustomMessage<unknown>;
	readonly expanded?: boolean;
	/** Builds an extension-owned view lazily, so a failed renderer cannot hide its persisted message. */
	readonly view?: (props: {
		readonly message: CustomMessage<unknown>;
		readonly expanded: boolean;
	}) => JSX.Element | undefined;
}

function renderCustomContent(props: CustomMessageViewProps): JSX.Element | undefined {
	if (!props.view) return undefined;
	try {
		return props.view({
			get message() {
				return props.message;
			},
			get expanded() {
				return props.expanded ?? false;
			},
		});
	} catch {
		return undefined;
	}
}

/** Extension message frame with an optional typed renderer and a durable transcript fallback. */
export function CustomMessageView(props: CustomMessageViewProps): JSX.Element {
	const theme = useTheme();
	const content = renderCustomContent(props);
	if (content) return content;

	const isLiveDelegation = props.message.customType === LIVE_DELEGATION_MESSAGE_TYPE;
	const text =
		typeof props.message.content === "string"
			? props.message.content
			: props.message.content
					.filter((item): item is TextContent => item.type === "text")
					.map(item => item.text)
					.join("\n");
	return (
		<box
			background="customMessageBg"
			border={{
				chars: {
					topLeft: theme.symbol("boxRound.topLeft"),
					topRight: theme.symbol("boxRound.topRight"),
					bottomLeft: theme.symbol("boxRound.bottomLeft"),
					bottomRight: theme.symbol("boxRound.bottomRight"),
					horizontal: theme.symbol("boxRound.horizontal"),
					vertical: theme.symbol("boxRound.vertical"),
				},
				color: isLiveDelegation ? "borderAccent" : "borderMuted",
			}}
			padding={1}
		>
			<stack gap={1}>
				{isLiveDelegation ? null : (
					<row gap={1} color="customMessageLabel" bold>
						<icon name="icon.package" />
						<text>{props.message.customType}</text>
					</row>
				)}
				<markdown document={createDocument(text)} color="customMessageText" />
			</stack>
		</box>
	);
}
