import type { Keybinding } from "../keybindings";
import { For, Show, type JSX } from "../reactive";
import { Kbd } from "./kbd";

/** One key/action description pair. */
export interface HintItem {
	readonly action?: Keybinding;
	readonly hint?: string;
	readonly description: string;
}

/** Props for compact keyboard hints. */
export interface HintsProps {
	readonly items?: readonly HintItem[];
	readonly text?: string;
	readonly separator?: string;
}

/** Render explicit text or a keymap-aware sequence of hints. */
export function Hints(props: HintsProps): JSX.Element {
	return (
		<Show
			when={props.text}
			fallback={
				<For each={props.items ?? []}>
					{(item, index) => (
						<>
							<Show when={index() > 0}>{props.separator ?? "  "}</Show>
							<Kbd action={item.action} hint={item.hint} />
							<span color="muted"> {item.description}</span>
						</>
					)}
				</For>
			}
		>
			<span color="dim">{props.text}</span>
		</Show>
	);
}
