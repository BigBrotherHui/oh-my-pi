import { Show, type JSX } from "../reactive";

/** Props for a labeled vertical section. */
export interface SectionProps {
	readonly label?: string;
	readonly children?: JSX.Element;
	readonly gap?: number;
}

/** Render an optional muted heading above section content. */
export function Section(props: SectionProps): JSX.Element {
	return (
		<stack gap={props.gap ?? 0}>
			<Show when={props.label}>
				<text color="dim">{props.label}</text>
			</Show>
			{props.children}
		</stack>
	);
}
