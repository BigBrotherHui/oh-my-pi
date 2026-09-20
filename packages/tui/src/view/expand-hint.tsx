import type { Keybinding } from "../keybindings";
import { Show, type JSX } from "../reactive";
import { useKeymap } from "../host/keymap";

/** Props for the collapsed-content expansion hint. */
export interface ExpandHintProps {
	readonly expanded?: boolean;
	readonly hasMore?: boolean;
	readonly action?: Keybinding;
	readonly hint?: string;
}

/** Render a keymap-aware expand hint while more content is hidden. */
export function ExpandHint(props: ExpandHintProps): JSX.Element {
	const keymap = useKeymap();
	const hint = (): string => props.hint ?? keymap.hint(props.action ?? "app.tools.expand");
	return (
		<Show when={!(props.expanded ?? false) && props.hasMore !== false}>
			<badge color="dim">{hint()}: Expand</badge>
		</Show>
	);
}
