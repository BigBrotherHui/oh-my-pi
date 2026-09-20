import { isRecord } from "@oh-my-pi/pi-utils";
import { createEffect, createMemo, createSignal, Show, useViewport, type Accessor, type JSX } from "../reactive";
import { replaceTabs } from "../render/render-utils";
import { createDocument } from "../document/document";
import { useTheme } from "../theme/reactive";
import { JsonTree } from "../view/json-tree";
import { Section } from "../view/section";
import type { ToolUIStatus } from "../view/status-icon";
import { ToolCard } from "../view/tool-card";
import { ToolHeader } from "../view/tool-header";
import { GenericResultBody } from "./generic-result-body";
import { registerToolView } from "./registry";
import type { CallOutcome, CallPhase, ToolViewDefinition, ToolViewProps } from "./view";

import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
} from "./json-tree";

/** Frameless fallback padding on either side. */
const TOOL_CARD_HORIZONTAL_CHROME = 2;

export function toolStatus(phase: CallPhase, outcome?: CallOutcome): ToolUIStatus {
	if (phase === "running" || phase === "receiving") return "running";
	if (phase === "queued") return "pending";
	if (outcome === "failed" || outcome === "timed_out") return "error";
	if (outcome === "cancelled" || outcome === "skipped") return "info";
	return "done";
}

function hasDisplayArgs(args: unknown): args is Record<string, unknown> {
	if (!isRecord(args)) return false;
	for (const key in args) {
		if (Object.hasOwn(args, key)) return true;
	}
	return false;
}

/**
 * Preserve the final segment of a bare carriage-return overwrite and retain
 * ANSI control sequences for the preformatted output surface.
 */
function splitTerminalOutputLines(text: string): string[] {
	return text.split(/\r?\n/u).map(line => {
		const carriageReturn = line.lastIndexOf("\r");
		return replaceTabs(carriageReturn < 0 ? line : line.slice(carriageReturn + 1));
	});
}

export function DefaultToolView(props: ToolViewProps<unknown, unknown>): JSX.Element {
	const { theme } = useTheme();
	const viewport = useViewport();
	const status = createMemo(() => toolStatus(props.phase, props.outcome));
	const label = createMemo(() => props.label || props.toolName || "Tool");
	const args = createMemo(() => (isRecord(props.args) ? props.args : undefined));
	const displayArgs = createMemo(() => {
		const value = args();
		return value && hasDisplayArgs(value) ? value : undefined;
	});
	const treeLast = createMemo(() => theme().tree.last);
	const inlineArgsBudget = createMemo(() => {
		const contentWidth = Math.max(0, viewport().columns - TOOL_CARD_HORIZONTAL_CHROME);
		return Math.max(20, contentWidth - Bun.stringWidth(treeLast()) - 2);
	});

	const outputText = createMemo(() => {
		props.output.version();
		return props.output.text().trimEnd();
	});
	const outputLines = createMemo(() => (outputText().length > 0 ? splitTerminalOutputLines(outputText()) : []));
	const outputDocument = createDocument();
	createEffect(() => {
		const next = outputLines().join("\n");
		if (outputDocument.text() !== next) outputDocument.apply({ kind: "reset", text: next });
	});

	const [argsTreeTruncated, setArgsTreeTruncated] = createSignal(false);

	const header = (
		<ToolHeader
			status={status()}
			label={
				<Show when={props.outcome === "skipped"} fallback={<span color="accent">{label()}</span>}>
					<span color="muted">{label()}</span>
				</Show>
			}
		/>
	);

	const summary = (
		<stack gap={0}>
			<Show when={displayArgs()}>
				{(value: Accessor<Record<string, unknown>>) => (
					<row gap={1}>
						<row gap={0}>
							<text> </text>
							<text color="dim">{treeLast()}</text>
						</row>
						<text color="dim" grow={1} minWidth={1} wrap="none" overflow="ellipsis">
							{formatArgsInline(value(), inlineArgsBudget())}
						</text>
					</row>
				)}
			</Show>
			<GenericResultBody
				document={outputDocument}
				notices={() => props.notices}
				phase={() => props.phase}
				expanded={() => false}
				textPresentation={() => ({ kind: "pre", ansi: true })}
			/>
		</stack>
	);

	return (
		<ToolCard
			phase={props.phase}
			outcome={props.outcome}
			framed={false}
			expanded={props.ui.expanded}
			header={header}
			summary={summary}
		>
			<stack gap={0}>
				<Show when={args()}>
					{(value: Accessor<Record<string, unknown>>) => (
						<>
							<br />
							<Section label="Args">
								<JsonTree
									value={value()}
									maxDepth={JSON_TREE_MAX_DEPTH_EXPANDED}
									maxLines={JSON_TREE_MAX_LINES_EXPANDED}
									maxScalarLength={JSON_TREE_SCALAR_LEN_EXPANDED}
									onResult={result => setArgsTreeTruncated(result.truncated)}
								/>
								<Show when={argsTreeTruncated()}>
									<text color="dim">…</text>
								</Show>
							</Section>
							<br />
						</>
					)}
				</Show>
				<GenericResultBody
					document={outputDocument}
					notices={() => props.notices}
					phase={() => props.phase}
					expanded={() => true}
					textPresentation={() => ({ kind: "pre", ansi: true })}
					emptyState="settled"
				/>
			</stack>
		</ToolCard>
	);
}

export const defaultToolView: ToolViewDefinition<unknown, unknown> = {
	view: props => <DefaultToolView {...props} />,
	framed: false,
	summary: props => {
		const args = isRecord(props.args) ? props.args : undefined;
		const detail = args && hasDisplayArgs(args) ? formatArgsInline(args, 60) || undefined : undefined;
		return {
			label: props.label || props.toolName || "Tool",
			detail,
			status: toolStatus(props.phase, props.outcome),
		};
	},
};

registerToolView("default", defaultToolView);
