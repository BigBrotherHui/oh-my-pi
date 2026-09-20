import type { JSX } from "../reactive";

export interface TruncatedTextViewProps {
	readonly text: string;
	readonly paddingX?: number;
	readonly paddingY?: number;
}

/** Single-line text presentation with optional surrounding whitespace. */
export function TruncatedTextView(props: TruncatedTextViewProps): JSX.Element {
	return (
		<box padding={{ x: props.paddingX ?? 0, y: props.paddingY ?? 0 }}>
			<text wrap="none" overflow="ellipsis">
				{props.text.split(/\r?\n/, 1)[0] ?? ""}
			</text>
		</box>
	);
}
