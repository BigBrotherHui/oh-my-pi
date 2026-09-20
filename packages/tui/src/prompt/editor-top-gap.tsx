import { Show, type Accessor, type JSX } from "../reactive";

/** Root-local composer shape and measured occupancy for editor spacing. */
export interface EditorTopGapViewProps {
	/** Current composer shape, scoped to the editor's reactive root. */
	readonly composerShape: Accessor<string>;
	/** Whether the status/working row directly above rendered lines this frame. */
	readonly statusRowOccupied: Accessor<boolean>;
}

/** Keep one blank row above idle editors; occupied band layouts sit flush with their status row. */
export function EditorTopGapView(props: EditorTopGapViewProps): JSX.Element {
	return (
		<Show when={props.composerShape() !== "band" || !props.statusRowOccupied()}>
			<br />
		</Show>
	);
}
