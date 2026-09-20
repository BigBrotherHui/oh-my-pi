import type { Style } from "../core/style";
import type { JSX } from "../reactive";

export interface TextViewProps {
	readonly text: string;
	readonly style?: Style;
}

/** Declarative text run with optional explicit presentation style. */
export function TextView(props: TextViewProps): JSX.Element {
	return <text style={props.style}>{props.text}</text>;
}
