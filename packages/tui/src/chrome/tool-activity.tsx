import { Show, type Accessor, type JSX } from "../reactive";

export interface ToolActivityViewProps {
	readonly visible: Accessor<boolean>;
	readonly children: JSX.Element;
}

/** Conditionally retain tool-activity presentation in the mutable transcript tail. */
export function ToolActivityView(props: ToolActivityViewProps): JSX.Element {
	return <Show when={props.visible()}>{props.children}</Show>;
}
