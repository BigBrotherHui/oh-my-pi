import type { Keybinding } from "../keybindings";
import { useKeymap } from "../host/keymap";
import type { JSX } from "../reactive";

/** Props for a resolved keyboard hint. */
export interface KbdProps {
	readonly action?: Keybinding;
	readonly hint?: string;
	readonly children?: string;
}

/** Render an explicit hint or resolve an action through the active keymap. */
export function Kbd(props: KbdProps): JSX.Element {
	const keymap = useKeymap();
	const label = (): string => props.hint ?? props.children ?? (props.action ? keymap.hint(props.action) : "");
	return <span color="dim">{label()}</span>;
}
