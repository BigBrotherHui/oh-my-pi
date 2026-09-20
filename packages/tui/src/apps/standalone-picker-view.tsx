import { createMemo, onMount, Show, useFocus, type JSX } from "../reactive";
import { createSelectController } from "../overlays/select-overlay";
import type { StandaloneSelectItem, StandaloneSelectOptions } from "./standalone-picker";

function selectStatus(query: string): string {
	const normalized = query
		.replace(/\t/g, " ")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized ? `  Search: ${normalized}` : "  Type to search";
}

export function StandaloneSelectView(props: {
	readonly items: readonly StandaloneSelectItem[];
	readonly options: StandaloneSelectOptions;
	onFinish(value: string | null): void;
}): JSX.Element {
	const focus = useFocus();
	const maxRows = createMemo(() => Math.min(props.items.length || 1, props.options.maxVisible ?? 10));
	const controller = createSelectController({
		options: () => props.items,
		maxRows,
		selectedValue: props.options.currentValue,
		scrollPolicy: "center",
		onSelect: props.onFinish,
		onCancel: () => props.onFinish(null),
	});
	const status = createMemo(() => (controller.searchEnabled() ? selectStatus(controller.query()) : undefined));
	const emptyText = createMemo(() => (controller.query().trim() ? "  No matching items" : "  No items"));
	onMount(() => focus.focus());
	return (
		<box
			tabIndex={focus.tabIndex}
			onKey={controller.handleKey}
			onMouse={event => controller.handleMouse(event, event.localRow)}
		>
			<Show
				when={controller.options().length > 0}
				fallback={
					<>
						<Show when={status()}>{status()}</Show>
						<text color="muted" wrap="clip" overflow="clip">
							{emptyText()}
						</text>
					</>
				}
			>
				<select
					options={controller.options()}
					selectedIndex={controller.selectedIndex()}
					hoveredIndex={controller.hoveredIndex()}
					offset={controller.offset()}
					maxRows={controller.maxRows()}
					primaryColumnWidth={32}
					trackColor="muted"
					thumbColor="accent"
					disabledColor="muted"
					hoverBackground="selectedBg"
					hoverFill={false}
				/>
				<Show when={status()}>{status()}</Show>
			</Show>
		</box>
	);
}

export function StandaloneInputView(props: { onFinish(value: string | null): void }): JSX.Element {
	const focus = useFocus();
	onMount(() => focus.focus());
	return (
		<input
			tabIndex={focus.tabIndex}
			onSubmit={value => props.onFinish(value.trim() || null)}
			onEscape={() => props.onFinish(null)}
		/>
	);
}
