import { For, type JSX } from "../reactive";

/** One keyed list item. */
export interface ListItem {
	readonly content: JSX.Element;
}

/** Props for a bulleted list. */
export interface ListProps {
	readonly items: readonly (ListItem | string)[];
	readonly marker?: string | ((index: number, last: boolean) => string);
}

/** Render a reactive list with a muted marker column. */
export function List(props: ListProps): JSX.Element {
	return (
		<stack>
			<For each={props.items}>
				{(item, index) => {
					const marker = (): string => {
						const value = props.marker ?? "•";
						return typeof value === "function" ? value(index(), index() === props.items.length - 1) : value;
					};
					return (
						<row gap={1}>
							<text color="dim" shrink={0}>
								{marker()}
							</text>
							<text grow={1} minWidth={0}>
								{typeof item === "string" ? item : item.content}
							</text>
						</row>
					);
				}}
			</For>
		</stack>
	);
}
