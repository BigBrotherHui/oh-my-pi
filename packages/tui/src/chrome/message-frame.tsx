import type { TextContent } from "@oh-my-pi/pi-ai";
import { Show, type JSX } from "../reactive";
import type { ThemeColor } from "../theme/schema";

export interface FramedMessage {
	readonly customType: string;
	readonly content: string | readonly (TextContent | { readonly type: string })[];
}

export interface FramedMessageViewProps {
	readonly content: JSX.Element;
	readonly custom?: boolean;
	readonly header?: string;
	readonly borderColor?: ThemeColor;
}

/** Framed transcript content. Custom renderers provide their own body element. */
export function FramedMessageView(props: FramedMessageViewProps): JSX.Element {
	return (
		<frame title={props.header} borderColor={props.borderColor ?? "border"}>
			<Show when={!props.custom}>
				{props.header && (
					<text color="accent" bold>
						{props.header}
					</text>
				)}
			</Show>
			{props.content}
		</frame>
	);
}
