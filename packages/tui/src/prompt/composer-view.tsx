import { Show, type JSX } from "../reactive";
import { TranscriptView, type TranscriptStore } from "../chat/transcript-store";

/** Declarative composer shell mounted by the interactive root. */
export interface ComposerViewProps {
	readonly transcript: TranscriptStore;
	readonly header?: JSX.Element;
	readonly beforeEditor?: JSX.Element;
	readonly editor: JSX.Element;
	readonly status?: JSX.Element;
	readonly afterEditor?: JSX.Element;
}

/** Transcript, optional chrome, editor, and status in terminal reading order. */
export function ComposerView(props: ComposerViewProps): JSX.Element {
	return (
		<stack>
			<TranscriptView store={props.transcript} header={props.header} />
			<Show when={props.beforeEditor}>{props.beforeEditor}</Show>
			{props.editor}
			<Show when={props.status}>{props.status}</Show>
			<Show when={props.afterEditor}>{props.afterEditor}</Show>
		</stack>
	);
}
