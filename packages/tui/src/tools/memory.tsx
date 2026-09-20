import { createMemo, For, Show, type Accessor, type JSX } from "../reactive";
import type { OutputDocument } from "../document/types";
import { PREVIEW_LIMITS, replaceTabs } from "../render/render-utils";
import type { ToolUIStatus } from "../host/elements/status";
import type { SymbolKey } from "../theme/symbols";
import { ExpandHint } from "../view/expand-hint";
import { ToolCard } from "../view/tool-card";
import { registerToolView } from "./registry";
import type { CallOutcome, CallPhase, ToolViewDefinition, ToolViewProps } from "./view";

/** Arguments accepted by the retain tool. */
export interface RetainRenderArgs {
	items?: unknown;
}

/** Arguments accepted by query-based memory tools (recall, reflect). */
export interface QueryRenderArgs {
	query?: string;
}

/** Number of memories accepted by retain. */
export interface MemoryRetainDetails {
	count: number;
}

type MemoryPresentation = "call" | "result" | "error" | "aborted";

interface MemoryHeaderProps {
	readonly status?: ToolUIStatus;
	readonly icon?: SymbolKey;
	readonly title: string;
	readonly description?: string;
	readonly meta?: string;
	readonly wrap?: "word" | "clip";
}

/** Parse and normalize memory content items from retain arguments. */
export function retainContents(args: { readonly items?: unknown } | undefined): string[] {
	const items = args?.items;
	if (!Array.isArray(items)) return [];

	const contents: string[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object" || !("content" in item) || typeof item.content !== "string") continue;
		const content = replaceTabs(item.content.trim());
		if (content.length > 0) contents.push(content);
	}
	return contents;
}

function resultText(output: OutputDocument): string {
	return output.text().trim();
}

function presentationFor(phase: CallPhase, outcome: CallOutcome | undefined, hasResult: boolean): MemoryPresentation {
	if (outcome === "failed" || outcome === "timed_out") return "error";
	if (outcome === "cancelled" || outcome === "skipped") return "aborted";
	if (hasResult || phase === "settled") return "result";
	return "call";
}

function statusFor(phase: CallPhase, outcome: CallOutcome | undefined): ToolUIStatus {
	if (phase === "receiving" || phase === "queued") return "pending";
	if (phase === "running") return "running";
	if (outcome === "failed" || outcome === "timed_out") return "error";
	if (outcome === "cancelled" || outcome === "skipped") return "aborted";
	return "done";
}

function queryDescription(query: string | undefined): string | undefined {
	const trimmed = replaceTabs((query ?? "").trim());
	return trimmed || undefined;
}

function errorText(text: string, fallback: string): string {
	const clean = text.replace(/^Error:\s*/, "").trim();
	return replaceTabs(clean || fallback);
}

/** Header equivalent to the historical status-line renderer, without ANSI-string assembly. */
function MemoryHeader(props: MemoryHeaderProps): JSX.Element {
	return (
		<text wrap={props.wrap ?? "word"} overflow={props.wrap === "clip" ? "clip" : undefined}>
			<Show
				when={props.icon}
				fallback={
					<Show when={props.status}>{(status: Accessor<ToolUIStatus>) => <status value={status()} />}</Show>
				}
			>
				{(icon: Accessor<SymbolKey>) => <icon name={icon()} color="accent" />}
			</Show>{" "}
			<span color="accent">{props.title}</span>
			<Show when={props.description}>
				{(description: Accessor<string>) => (
					<>
						: <span color="muted">{description()}</span>
					</>
				)}
			</Show>
			<Show when={props.meta}>
				{(meta: Accessor<string>) => <span color="dim"> {meta().replace(/\r\n?|\n/g, " ")}</span>}
			</Show>
		</text>
	);
}

function MemoryError(props: {
	readonly phase: CallPhase;
	readonly outcome: CallOutcome | undefined;
	readonly text: string;
	readonly fallback: string;
}): JSX.Element {
	return (
		<ToolCard phase={props.phase} outcome={props.outcome} framed={false} expanded={true} paddingX={0} tint={false}>
			<text color="error" wrap="word">
				<status value="error" /> Error: {errorText(props.text, props.fallback)}
			</text>
		</ToolCard>
	);
}

/** Reactive view definition for the retain memory tool. */
export const retainToolView: ToolViewDefinition<RetainRenderArgs, MemoryRetainDetails> = {
	view: (props: ToolViewProps<RetainRenderArgs, MemoryRetainDetails>): JSX.Element => {
		const contents = createMemo(() => retainContents(props.args));
		const presentation = createMemo(() => presentationFor(props.phase, props.outcome, props.hasResult));
		const text = createMemo(() => resultText(props.output));
		const limit = createMemo(() => (props.ui.expanded ? contents().length : PREVIEW_LIMITS.COLLAPSED_ITEMS));
		const shown = createMemo(() => contents().slice(0, limit()));
		const remaining = createMemo(() => contents().length - shown().length);
		const summary = createMemo(() => {
			if (presentation() === "error" || presentation() === "aborted") return undefined;
			if (text()) return text().replace(/\.$/, "");
			const count = props.details?.count;
			return count === undefined ? undefined : `${count} ${count === 1 ? "memory" : "memories"} stored`;
		});
		const headerStatus = createMemo<ToolUIStatus | undefined>(() => {
			if (presentation() === "aborted") return "aborted";
			if (presentation() === "call" || props.phase !== "settled") return "pending";
			return undefined;
		});
		const headerIcon = createMemo<SymbolKey | undefined>(() =>
			headerStatus() === undefined && presentation() === "result" ? "tool.memory" : undefined,
		);

		return (
			<Show
				when={presentation() === "error"}
				fallback={
					<ToolCard
						phase={props.phase}
						outcome={props.outcome}
						framed={false}
						paddingX={0}
						tint={false}
						header={<MemoryHeader status={headerStatus()} icon={headerIcon()} title="Retain" meta={summary()} />}
					>
						<stack>
							<For each={shown()}>
								{content => (
									<text wrap="clip" overflow="ellipsis" ellipsisColor="muted">
										{"  "}
										<icon name="format.bullet" color="muted" /> <span color="toolOutput">{content}</span>
									</text>
								)}
							</For>
							<Show when={remaining() > 0}>
								<text color="dim">
									{"  "}… {remaining()} more <ExpandHint expanded={props.ui.expanded} hasMore />
								</text>
							</Show>
						</stack>
					</ToolCard>
				}
			>
				<MemoryError phase={props.phase} outcome={props.outcome} text={text()} fallback="Retain failed" />
			</Show>
		);
	},

	summary: props => ({
		label: "Retain",
		detail: props.details?.count !== undefined ? `${props.details.count} memories` : undefined,
		status: statusFor(props.phase, props.outcome),
	}),
	framed: false,
	tint: false,
};

/** Reactive view definition for the recall memory tool. */
export const recallToolView: ToolViewDefinition<QueryRenderArgs, unknown> = {
	view: (props: ToolViewProps<QueryRenderArgs, unknown>): JSX.Element => {
		const text = createMemo(() => resultText(props.output));
		const presentation = createMemo(() => presentationFor(props.phase, props.outcome, props.hasResult));
		const match = createMemo(() => text().match(/^Found (\d+) relevant/));
		const found = createMemo(() => (match() ? Number(match()![1]) : 0));
		const body = createMemo(() => text().replace(/^[^\n]*\n+/, ""));
		const description = createMemo(() => queryDescription(props.args.query));
		const status = createMemo<ToolUIStatus | undefined>(() => {
			if (presentation() === "aborted") return "aborted";
			if (presentation() === "call" || props.phase !== "settled") return "pending";
			return found() > 0 ? undefined : "warning";
		});
		const icon = createMemo<SymbolKey | undefined>(() =>
			status() === undefined && presentation() === "result" ? "tool.memory" : undefined,
		);
		const meta = createMemo(() => {
			if (presentation() !== "result" || props.phase !== "settled") return undefined;
			return found() > 0 ? `${found()} found` : "no matches";
		});
		const bodyLines = createMemo(() => {
			const value = body().trim();
			return value ? value.split("\n").slice(0, PREVIEW_LIMITS.OUTPUT_EXPANDED) : [];
		});

		return (
			<Show
				when={presentation() === "error"}
				fallback={
					<ToolCard
						phase={props.phase}
						outcome={props.outcome}
						framed={false}
						paddingX={0}
						tint={false}
						header={
							<MemoryHeader
								status={status()}
								icon={icon()}
								title="Recall"
								description={description()}
								meta={meta()}
								wrap={status() === undefined ? "clip" : "word"}
							/>
						}
					>
						<Show when={found() > 0}>
							<Show
								when={props.ui.expanded}
								fallback={
									<text>
										{"  "}
										<ExpandHint hasMore />
									</text>
								}
							>
								<stack>
									<For each={bodyLines()}>
										{line => (
											<text wrap="none" color="muted">
												{"  "}
												{replaceTabs(line)}
											</text>
										)}
									</For>
								</stack>
							</Show>
						</Show>
					</ToolCard>
				}
			>
				<MemoryError phase={props.phase} outcome={props.outcome} text={text()} fallback="Recall failed" />
			</Show>
		);
	},

	summary: props => {
		const text = resultText(props.output);
		const match = text.match(/^Found (\d+) relevant/);
		const found = match ? Number(match[1]) : 0;
		const status = statusFor(props.phase, props.outcome);
		return {
			label: "Recall",
			detail: props.args.query,
			status: status === "done" && found === 0 ? "warning" : status,
		};
	},
	framed: false,
	tint: false,
};

/** Reactive view definition for the reflect memory tool. */
export const reflectToolView: ToolViewDefinition<QueryRenderArgs, unknown> = {
	view: (props: ToolViewProps<QueryRenderArgs, unknown>): JSX.Element => {
		const text = createMemo(() => resultText(props.output));
		const presentation = createMemo(() => presentationFor(props.phase, props.outcome, props.hasResult));
		const description = createMemo(() => queryDescription(props.args.query));
		const lines = createMemo(() =>
			text()
				.split("\n")
				.filter(line => line.trim().length > 0),
		);
		const limit = createMemo(() =>
			props.ui.expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED,
		);
		const shown = createMemo(() => lines().slice(0, limit()));
		const remaining = createMemo(() => lines().length - shown().length);
		const status = createMemo<ToolUIStatus | undefined>(() => {
			if (presentation() === "aborted") return "aborted";
			if (presentation() === "call" || props.phase !== "settled") return "pending";
			return undefined;
		});
		const icon = createMemo<SymbolKey | undefined>(() =>
			status() === undefined && presentation() === "result" ? "tool.memory" : undefined,
		);

		return (
			<Show
				when={presentation() === "error"}
				fallback={
					<ToolCard
						phase={props.phase}
						outcome={props.outcome}
						framed={false}
						paddingX={0}
						tint={false}
						header={
							<MemoryHeader
								status={status()}
								icon={icon()}
								title="Reflect"
								description={description()}
								wrap={status() === undefined ? "clip" : "word"}
							/>
						}
					>
						<stack>
							<For each={shown()}>
								{line => (
									<text wrap="none">
										{"  "}
										<span color="toolOutput">{replaceTabs(line)}</span>
									</text>
								)}
							</For>
							<Show when={remaining() > 0}>
								<text wrap="none" color="dim">
									{"  "}… {remaining()} more lines <ExpandHint expanded={props.ui.expanded} hasMore />
								</text>
							</Show>
						</stack>
					</ToolCard>
				}
			>
				<MemoryError phase={props.phase} outcome={props.outcome} text={text()} fallback="Reflect failed" />
			</Show>
		);
	},

	summary: props => ({
		label: "Reflect",
		detail: props.args.query,
		status: statusFor(props.phase, props.outcome),
	}),
	framed: false,
	tint: false,
};

registerToolView("retain", retainToolView);
registerToolView("recall", recallToolView);
registerToolView("reflect", reflectToolView);
