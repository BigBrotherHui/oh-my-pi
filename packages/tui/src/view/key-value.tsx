import { For, type JSX } from "../reactive";
import type { ThemeColor } from "../theme/schema";

/** One label/value pair. */
export interface KeyValueRow {
	readonly label: JSX.Element;
	readonly value: JSX.Element;
	readonly labelColor?: ThemeColor;
	readonly valueColor?: ThemeColor;
}

/** Props for a flexible key/value list. */
export interface KeyValueProps {
	readonly rows: readonly KeyValueRow[];
	readonly gap?: number;
	readonly labelMinWidth?: number;
}

/** Render values in rows where labels shrink and values receive remaining width. */
export function KeyValue(props: KeyValueProps): JSX.Element {
	return (
		<stack>
			<For each={props.rows}>
				{row => (
					<row gap={props.gap ?? 1}>
						<text
							minWidth={props.labelMinWidth ?? 1}
							shrink={1}
							wrap="none"
							overflow="ellipsis"
							color={row.labelColor ?? "muted"}
						>
							{row.label}
						</text>
						<text grow={1} minWidth={1} overflow="ellipsis" color={row.valueColor}>
							{row.value}
						</text>
					</row>
				)}
			</For>
		</stack>
	);
}
