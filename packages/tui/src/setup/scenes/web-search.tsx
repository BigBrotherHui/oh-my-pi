import {
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	onMount,
	Show,
	useFocus,
	useTheme,
	useViewport,
	type Accessor,
	type JSX,
} from "../../reactive";
import { createSelectController } from "../../overlays/select-overlay";
import { SEARCH_PROVIDER_OPTIONS, type SearchProviderId } from "../../tools/web-search";
import type { SetupHost, SetupSceneResult } from "./types";

const MAX_VISIBLE = 8;
const SELECT_ROW_OFFSET = 2;
const WEB_SEARCH_OPTIONS = SEARCH_PROVIDER_OPTIONS;
type Availability = "checking" | boolean;
type WebSearchOption = (typeof WEB_SEARCH_OPTIONS)[number];

/** Tab-local setup context; the wizard supplies its exact post-chrome row budget when embedded. */
export interface WebSearchSceneContext {
	readonly host: Pick<SetupHost, "isSearchProviderAvailable" | "saveWebSearchSelection" | "webSearchSelection">;
	complete(result: SetupSceneResult): void;
	readonly availableRows?: Accessor<number>;
	/** Whether this mounted tab is presently visible and receives interaction. */
	readonly active?: Accessor<boolean>;
}

function searchStatus(query: string): string {
	const normalized = query.replace(/\s+/g, " ").trim();
	return normalized ? `  Search: ${normalized}` : "  Type to search";
}

/** Provider picker rendered within the providers setup scene. */
export function WebSearchSceneView(context: WebSearchSceneContext): JSX.Element {
	const viewport = useViewport();
	const theme = useTheme();
	const focus = useFocus();
	const availableRows = (): number => Math.max(0, Math.trunc(context.availableRows?.() ?? viewport().rows));
	const [availability, setAvailability] = createSignal<ReadonlyMap<SearchProviderId, Availability>>(
		new Map<SearchProviderId, Availability>(),
	);
	const [saved, setSaved] = createSignal(false);
	const statusRows = createMemo(() => 1 + (saved() ? 2 + (ready() === false ? 1 : 0) : 0));
	const maxRows = createMemo(() => Math.min(MAX_VISIBLE, Math.max(1, availableRows() - statusRows() - 4)));
	const controller = createSelectController({
		options: () => WEB_SEARCH_OPTIONS,
		maxRows,
		selectedValue: context.host.webSearchSelection,
		scrollPolicy: "center",
		onChange: value => {
			setSaved(false);
			const option = optionFor(value);
			if (option) checkAvailability(option);
		},
		onSelect: value => {
			const option = optionFor(value);
			if (!option) return;
			context.host.saveWebSearchSelection(option.value);
			setSaved(true);
		},
		onCancel: () => context.complete("skipped"),
	});
	let disposed = false;

	const optionFor = (value: string): WebSearchOption | undefined =>
		WEB_SEARCH_OPTIONS.find(option => option.value === value);
	const selected = (): WebSearchOption =>
		optionFor(controller.options()[controller.selectedIndex()]?.value ?? "") ?? WEB_SEARCH_OPTIONS[0]!;

	const checkAvailability = (option: WebSearchOption): void => {
		if (option.value === "auto" || availability().has(option.value)) return;
		setAvailability(previous => new Map(previous).set(option.value, "checking"));
		void context.host.isSearchProviderAvailable(option.value).then(
			ready => {
				if (!disposed) setAvailability(previous => new Map(previous).set(option.value, ready));
			},
			() => {
				if (!disposed) setAvailability(previous => new Map(previous).set(option.value, false));
			},
		);
	};
	const ready = (): Availability | "auto" => {
		const option = selected();
		return option.value === "auto" ? "auto" : (availability().get(option.value) ?? "checking");
	};
	const status = createMemo(() => searchStatus(controller.query()));
	const emptyText = createMemo(() => (controller.query().trim() ? "  No matching items" : "  No items"));

	const active = context.active;
	if (active) {
		createEffect(
			on(active, visible => {
				if (!visible) return;
				const selectedOnActivation = selected();
				setAvailability(new Map<SearchProviderId, Availability>());
				setSaved(false);
				controller.selectValue(selectedOnActivation.value);
				checkAvailability(selectedOnActivation);
				focus.focus();
			}),
		);
	} else {
		onMount(() => {
			focus.focus();
			checkAvailability(selected());
		});
	}
	onCleanup(() => {
		disposed = true;
	});

	return (
		<box
			tabIndex={focus.tabIndex}
			onKey={controller.handleKey}
			onMouse={event => controller.handleMouse(event, event.localRow - SELECT_ROW_OFFSET)}
		>
			<stack gap={1}>
				<text color="muted">Choose the provider the web_search tool should prefer.</text>
				<Show
					when={controller.options().length > 0}
					fallback={
						<stack gap={0}>
							<Show when={controller.searchEnabled()}>
								<text color="muted" wrap="clip" overflow="clip">
									{status()}
								</text>
							</Show>
							<text color="muted" wrap="clip" overflow="clip">
								{emptyText()}
							</text>
						</stack>
					}
				>
					<stack gap={0}>
						<select
							options={controller.options()}
							selectedIndex={controller.selectedIndex()}
							hoveredIndex={controller.hoveredIndex()}
							offset={controller.offset()}
							maxRows={controller.maxRows()}
							primaryColumnWidth={32}
							trackColor="muted"
							thumbColor="accent"
							hoverBackground="selectedBg"
							hoverFill={false}
						/>
						<Show when={controller.searchEnabled()}>
							<text color="muted" wrap="clip" overflow="clip">
								{status()}
							</text>
						</Show>
					</stack>
				</Show>
				<stack gap={0}>
					<Show
						when={ready() === "auto"}
						fallback={
							<Show
								when={ready() === "checking"}
								fallback={
									<Show
										when={ready() === true}
										fallback={<text color="warning">{theme.symbol("status.pending")} Needs credentials</text>}
									>
										<text color="success">{theme.symbol("status.success")} Ready to use</text>
									</Show>
								}
							>
								<text color="dim">Checking availability…</text>
							</Show>
						}
					>
						<text color="dim">Automatically uses the first configured provider.</text>
					</Show>
					<Show when={saved()}>
						<br />
						<text color="success">
							{theme.symbol("status.success")} Web search set to {selected().label}
						</text>
						<Show when={ready() === false}>
							<text color="dim">Not configured yet — add its API key or sign in to enable it.</text>
						</Show>
					</Show>
				</stack>
			</stack>
		</box>
	);
}
