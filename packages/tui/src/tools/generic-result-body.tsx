import { Ellipsis } from "@oh-my-pi/pi-natives";
import { createMemo, createSignal, For, Show, type Accessor, type JSX } from "../reactive";
import type { OutputNotice, TextDocument } from "../document/types";
import { Style } from "../core/style";
import { ExpandHint } from "../view/expand-hint";
import { JsonTree } from "../view/json-tree";
import { TruncationNotice } from "../view/truncation-notice";
import type { CallPhase } from "./view";

import {
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
} from "./json-tree";

const COLLAPSED_OUTPUT_LINES = 4;
const EXPANDED_OUTPUT_LINES = 12;

/** Native text renderer for a generic tool result. */
export type GenericResultTextPresentation =
	| { readonly kind: "pre"; readonly ansi?: boolean }
	| { readonly kind: "markdown" };

/** Shared result content contract for generic and MCP tool cards. */
export interface GenericResultBodyProps {
	readonly document: TextDocument;
	readonly notices: Accessor<readonly OutputNotice[]>;
	readonly phase: Accessor<CallPhase>;
	readonly expanded: Accessor<boolean>;
	readonly textPresentation: Accessor<GenericResultTextPresentation>;
	/** Render the settled empty-result placeholder in this presentation. */
	readonly emptyState?: "settled";
}

/**
 * Render a retained result document as JSON when possible or through its
 * declared native text renderer otherwise. Result notices and expansion stay
 * coupled to the same reactive document in every caller.
 */
export function GenericResultBody(props: GenericResultBodyProps): JSX.Element {
	const outputText = createMemo(() => {
		props.document.version();
		return props.document.text().trimEnd();
	});
	const lineCount = createMemo(() => {
		const text = outputText();
		if (text.length === 0) return 0;
		let lines = 1;
		for (let index = 0; index < text.length; index++) {
			if (text.charCodeAt(index) === 0x0a) lines++;
		}
		return lines;
	});
	const parsedJson = createMemo(() => {
		const text = outputText();
		if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	});
	const [jsonTruncated, setJsonTruncated] = createSignal(false);
	const rendersMarkdown = createMemo(() => props.textPresentation().kind === "markdown");
	const preAnsi = createMemo(() => {
		const presentation = props.textPresentation();
		return presentation.kind === "pre" ? presentation.ansi : undefined;
	});

	const textOutput = () => {
		const expanded = props.expanded();
		const limit = expanded ? EXPANDED_OUTPUT_LINES : COLLAPSED_OUTPUT_LINES;
		const hiddenLines = () => Math.max(0, lineCount() - limit);
		return (
			<>
				<scroll height={limit} scrollbar={false} shrinkToFit>
					<Show
						when={rendersMarkdown()}
						fallback={
							<pre
								document={props.document}
								ansi={preAnsi()}
								color="toolOutput"
								ellipsis={Ellipsis.Unicode}
								ellipsisStyle={Style.RESET}
							/>
						}
					>
						<markdown document={props.document} color="toolOutput" />
					</Show>
				</scroll>
				<Show when={hiddenLines() > 0} fallback={<ExpandHint expanded={expanded} hasMore />}>
					<row gap={1}>
						<text color="dim">
							… {hiddenLines()} more line{hiddenLines() === 1 ? "" : "s"}
						</text>
						<ExpandHint expanded={expanded} hasMore />
					</row>
				</Show>
			</>
		);
	};

	const result = () => (
		<Show
			when={outputText().length > 0}
			fallback={
				<Show when={props.emptyState === "settled" && props.phase() === "settled"}>
					<text color="dim">(no output)</text>
				</Show>
			}
		>
			<Show when={parsedJson() !== undefined} fallback={textOutput()}>
				<JsonTree
					value={parsedJson()}
					maxDepth={props.expanded() ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED}
					maxLines={props.expanded() ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED}
					maxScalarLength={props.expanded() ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED}
					onResult={value => setJsonTruncated(value.truncated)}
				/>
				<Show when={props.expanded()} fallback={<ExpandHint hasMore />}>
					<Show when={jsonTruncated()}>
						<text color="dim">…</text>
					</Show>
				</Show>
			</Show>
		</Show>
	);

	return (
		<stack gap={0}>
			{result()}
			<For each={props.notices()}>{notice => <TruncationNotice text={notice.text} />}</For>
		</stack>
	);
}
