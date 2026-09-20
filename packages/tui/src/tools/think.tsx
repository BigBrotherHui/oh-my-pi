import { createEffect, createMemo, Show, type JSX } from "../reactive";
import { createDocument } from "../document/document";
import type { ToolViewDefinition, ToolViewProps } from "./view";
import { registerToolView } from "./registry";

/** Streamed private scratchpad text. */
export type ThinkRenderArgs = {
	thoughts?: string;
};

export interface ThinkViewProps {
	readonly thoughts: string;
}

/** Run-native private scratchpad view. */
export function ThinkView(props: ThinkViewProps): JSX.Element {
	const document = createDocument(props.thoughts);
	const hasThoughts = createMemo(() => props.thoughts.trim().length > 0);

	createEffect(() => {
		const thoughts = props.thoughts;
		if (thoughts !== document.text()) document.apply({ kind: "reset", text: thoughts });
	});

	return (
		<Show when={hasThoughts()}>
			<markdown
				document={document}
				color="thinkingText"
				options={{
					paddingX: 1,
				}}
			/>
		</Show>
	);
}

/** Render private scratchpad text as a reactive tool view. */
export const thinkToolView: ToolViewDefinition<ThinkRenderArgs, unknown> = {
	view: (props: ToolViewProps<ThinkRenderArgs, unknown>) => {
		const thoughts = createMemo(() => {
			const raw = props.args.thoughts;
			return typeof raw === "string" ? raw : "";
		});
		return <ThinkView thoughts={thoughts()} />;
	},
	presentation: "inline",
	tint: false,
};

registerToolView("think", thinkToolView);
