import { Show, type JSX } from "../reactive";

/** Props for compact diff counters. */
export interface DiffStatsProps {
	readonly added: number;
	readonly removed: number;
	readonly hunks: number;
}

/** Render non-zero diff counts with semantic colors. */
export function DiffStats(props: DiffStatsProps): JSX.Element {
	return (
		<>
			<Show when={props.added > 0}>
				<span color="toolDiffAdded">+{props.added}</span>
			</Show>
			<Show when={props.removed > 0}>
				<Show when={props.added > 0}>
					<span color="dim"> / </span>
				</Show>
				<span color="toolDiffRemoved">-{props.removed}</span>
			</Show>
			<Show when={props.hunks > 0}>
				<Show when={props.added > 0 || props.removed > 0}>
					<span color="dim"> / </span>
				</Show>
				<span color="dim">
					{props.hunks} hunk{props.hunks === 1 ? "" : "s"}
				</span>
			</Show>
		</>
	);
}
