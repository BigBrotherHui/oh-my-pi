import { Show, type JSX, useTightLayout } from "../reactive";

export interface StrippedToolCallsPlaceholderViewProps {
	readonly strippedToolCalls: number;
	readonly visible: boolean;
}

/**
 * Dim transcript marker for tool calls stripped from the resolved branch
 * (failed/retried turns, results on sibling branches). It is tool activity,
 * so it hides and reappears with the `display.hideToolActivity` toggle.
 */
export function StrippedToolCallsPlaceholderView(props: StrippedToolCallsPlaceholderViewProps): JSX.Element | null {
	const tight = useTightLayout();
	return (
		<Show when={props.visible}>
			<box padding={{ left: tight() ? 0 : 1, right: tight() ? 0 : 1 }}>
				<text color="dim" italic wrap="word">
					{`${props.strippedToolCalls} tool call${props.strippedToolCalls === 1 ? "" : "s"} elided — no result on this branch`}
				</text>
			</box>
		</Show>
	);
}
