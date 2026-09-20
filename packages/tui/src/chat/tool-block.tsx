/**
 * Reactive ToolBlock view for the new transcript architecture.
 *
 * Consumes a ToolCallModel, resolves the registered ToolViewDefinition,
 * applies state tint for non-framed views, and renders images and expand state.
 * Transcript layout selects ToolBlockSummary separately under viewport pressure.
 */

import { createMemo, For, Show, type Accessor, type JSX } from "../reactive";
import "../tools";
import { createComponent } from "../host/renderer";
import { resolveToolView, type ResolvedToolView, type ToolViewSource } from "../tools/registry";
import { createImagePaintState } from "../components/image";
import { useTheme } from "../theme/reactive";
import type { ToolCallModel } from "../tools/model";
import type { ActivitySummary, CallOutcome, CallPhase } from "../tools/view";

export interface ToolBlockProps {
	readonly model: ToolCallModel;
	/** Caller-approved extension and mounted-device presentation source. */
	readonly source?: ToolViewSource;
}

function recipeFor(phase: CallPhase, outcome: CallOutcome | undefined): string | undefined {
	if (phase !== "settled") return `tool.card.${phase}`;
	if (outcome === "success") return "tool.card.success";
	if (outcome === "failed" || outcome === "timed_out") return "tool.card.error";
	return undefined;
}

function ToolPresentation(props: {
	readonly resolved: Accessor<ResolvedToolView>;
	readonly model: ToolCallModel;
}): JSX.Element {
	return (
		<Show when={props.resolved()} keyed>
			{(resolved: ResolvedToolView) => createComponent(resolved.definition.view, resolved.model ?? props.model)}
		</Show>
	);
}

/** Resolve the host-approved presentation for a tool model. */
function createToolResolution(props: ToolBlockProps): Accessor<ResolvedToolView> {
	const source: ToolViewSource = { ...props.source, model: props.model };
	const initialResolution = resolveToolView(props.model.toolName, source);
	return createMemo(() => resolveToolView(props.model.toolName, source), initialResolution, {
		equals: (previous, next) => previous?.definition === next.definition && previous?.identity === next.identity,
	});
}

/**
 * One-row reactive tool identity for a constrained transcript allocation.
 * Resolves the same host-approved view and activity summary as ToolBlock.
 */
export function ToolBlockSummary(props: ToolBlockProps): JSX.Element {
	const resolved = createToolResolution(props);
	const summary = createMemo(() => {
		const definition = resolved().definition;
		if (definition.presentation === "inline") return undefined;
		return definition.summary?.(resolved().model ?? props.model);
	});

	return (
		<Show
			when={summary()}
			fallback={
				<row gap={1} recipe="tool.compact">
					<status
						value={
							props.model.outcome === "failed" ? "error" : props.model.phase === "settled" ? "done" : "running"
						}
					/>
					<text grow={1} minWidth={1} wrap="none" overflow="ellipsis">
						{props.model.label}
					</text>
				</row>
			}
		>
			{(sum: () => ActivitySummary) => (
				<row gap={1} recipe="tool.compact">
					<status value={sum().status} />
					<text grow={1} minWidth={1} wrap="none" overflow="ellipsis">
						{sum().label}
					</text>
					<Show when={sum().detail}>
						<text color="dim" wrap="none" overflow="ellipsis">
							{sum().detail}
						</text>
					</Show>
				</row>
			)}
		</Show>
	);
}

/**
 * Standard reactive ToolBlock view.
 */
export function ToolBlock(props: ToolBlockProps): JSX.Element {
	const { theme } = useTheme();
	const resolved = createToolResolution(props);
	const isHidden = () => props.model.ui.allocation === 0;

	return (
		<Show when={!isHidden()}>
			<box
				padding={{
					y: 1,
					x: props.source?.toolView !== undefined && !resolved().definition.framed ? 1 : 0,
				}}
				recipe={
					resolved().definition.framed || resolved().definition.tint === false
						? undefined
						: recipeFor(props.model.phase, props.model.outcome)
				}
			>
				<Show
					when={resolved().definition.presentation === "inline"}
					fallback={
						<stack>
							<Show
								when={resolved().definition.framed}
								fallback={
									<box
										recipe={
											resolved().definition.tint === false
												? undefined
												: recipeFor(props.model.phase, props.model.outcome)
										}
									>
										<ToolPresentation resolved={resolved} model={props.model} />
									</box>
								}
							>
								<ToolPresentation resolved={resolved} model={props.model} />
							</Show>
							<Show when={props.model.ui.showImages && props.model.images.length > 0}>
								<For each={props.model.images}>
									{img => (
										<image
											state={createImagePaintState({
												base64Data: img.data,
												mimeType: img.mimeType,
												theme: { fallbackStyle: theme().style("dim") },
												options: { imageKey: img.id ?? img.path ?? img.mimeType },
											})}
										/>
									)}
								</For>
							</Show>
						</stack>
					}
				>
					<ToolPresentation resolved={resolved} model={props.model} />
				</Show>
			</box>
		</Show>
	);
}
