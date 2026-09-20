import { createMemo, For, Show, type Accessor, type JSX } from "../reactive";
import { MoreItems } from "./more-items";

/** Reactive position data passed to a tree-list row renderer. */
export interface TreeListItemContext {
	readonly index: Accessor<number>;
	readonly isLast: Accessor<boolean>;
}

/** Props for a flat keyed tree list with collapsed summaries. */
export interface TreeListProps<T> {
	readonly items: readonly T[];
	readonly expanded?: boolean;
	readonly maxCollapsed?: number;
	readonly itemType?: string;
	readonly truncateFrom?: "start" | "end";
	readonly trailingSummary?: string;
	readonly indent?: number;
	readonly renderItem: (item: T, context: TreeListItemContext) => JSX.Element;
}

/** Render keyed items through the tree element so it owns theme guide glyphs. */
export function TreeList<T>(props: TreeListProps<T>): JSX.Element {
	const visibleItems = createMemo<readonly T[]>(() => {
		if (props.expanded ?? false) return props.items;
		const count = Math.max(0, Math.trunc(props.maxCollapsed ?? 8));
		if (count === 0) return [];
		return props.truncateFrom === "start" ? props.items.slice(-count) : props.items.slice(0, count);
	});
	const remaining = createMemo(() => Math.max(0, props.items.length - visibleItems().length));
	const hasSummary = createMemo(
		() => remaining() > 0 || (!(props.expanded ?? false) && props.trailingSummary !== undefined),
	);
	return (
		<tree guides={true} indent={props.indent}>
			<For each={visibleItems()}>
				{(item, index) => (
					<stack>
						{props.renderItem(item, {
							index,
							isLast: () => index() === visibleItems().length - 1 && !hasSummary(),
						})}
					</stack>
				)}
			</For>
			<Show when={hasSummary()}>
				<stack>
					<text color="muted">
						{props.trailingSummary ?? <MoreItems remaining={remaining()} itemType={props.itemType ?? "item"} />}
					</text>
				</stack>
			</Show>
		</tree>
	);
}
