import type { TextContent } from "@oh-my-pi/pi-ai";
import { Attr, Style } from "../core/style";
import { createDocument } from "../document/document";
import { createMemo, type JSX, useTheme } from "../reactive";
import type { CollabPromptDetails, CustomMessage } from "./messages";

export interface CollabPromptMessageViewProps {
	readonly message: CustomMessage<CollabPromptDetails>;
}

/** Collaborator prompt rendered with the historical user-message treatment. */
export function CollabPromptMessageView(props: CollabPromptMessageViewProps): JSX.Element {
	const from = props.message.details?.from?.trim() || "guest";
	const text =
		typeof props.message.content === "string"
			? props.message.content
			: props.message.content
					.filter((content): content is TextContent => content.type === "text")
					.map(content => content.text)
					.join("");
	const document = createDocument(text);
	const { theme } = useTheme();
	const authorStyle = createMemo(() => theme().style("accent").plus(Attr.Bold));
	const prefixStyle = createMemo(() => theme().style("accent"));
	const bubbleStyle = createMemo(() =>
		Style.of({
			fg: theme().fgOnBgColor("userMessageText", "userMessageBg"),
			bg: theme().bgColor("userMessageBg"),
		}),
	);
	const markdownOptions = createMemo(() => ({
		paddingX: 1,
		paddingY: 1,
		ignoreTight: true,
		defaultTextStyle: { style: bubbleStyle() },
	}));

	return (
		<stack>
			<text wrap="word">
				{" "}
				<span style={authorStyle()}>«{from}»</span>
				<span style={prefixStyle()}> › </span>
			</text>
			<box background="userMessageBg">
				<markdown document={document} options={markdownOptions()} />
			</box>
		</stack>
	);
}
