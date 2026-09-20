import type { JSX } from "../reactive";

/** A transcript block is now represented directly by a keyed reactive view. */
export interface ChatBlockViewProps {
	readonly children: JSX.Element;
}

export function ChatBlockView(props: ChatBlockViewProps): JSX.Element {
	return <transcript-block>{props.children}</transcript-block>;
}
