import * as path from "node:path";
import * as url from "node:url";
import { createMemo, For, Show, type JSX } from "../reactive";
import {
	formatMoreItems,
	formatParseErrorsCountLabel,
	PARSE_ERRORS_LIMIT,
	PREVIEW_LIMITS,
	replaceTabs,
} from "../render/render-utils";
import type { ToolUIStatus } from "../host/elements/status";
import { Card } from "../view/card";
import { ToolHeader } from "../view/tool-header";

import { classifyGroupedLines, groupLineIndicesByBlank } from "./grouped-file-output";
import type { OutputMeta } from "./output-meta";
import { registerToolView } from "./registry";
import type { ActivitySummary, CallOutcome, CallPhase, ToolViewDefinition, ToolViewProps } from "./view";

/** Display metadata returned by ast-edit. */
export interface AstEditToolDetails {
	totalReplacements: number;
	filesTouched: number;
	filesSearched: number;
	applied: boolean;
	limitReached: boolean;
	parseErrors?: string[];
	parseErrorsTotal?: number;
	scopePath?: string;
	files?: string[];
	fileReplacements?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	displayContent?: string;
	searchPath?: string;
	cwd?: string;
}

export interface AstEditRenderArgs {
	ops?: Array<{ pat?: string; out?: string }>;
	paths?: string[];
}

export const COLLAPSED_CHANGE_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

type AstEditPresentation = "call" | "changes" | "empty" | "error" | "aborted";

interface AstEditMetaItem {
	readonly text: string;
	readonly color?: "warning";
}

interface AstEditDisplayLine {
	readonly display: string;
	readonly kind: "dir" | "file" | "content";
	readonly uri?: string;
	readonly color: "accent" | "dim" | "toolDiffAdded" | "toolDiffRemoved" | "toolOutput";
}

interface AstEditChangeGroup {
	readonly key: string;
	readonly lines: readonly AstEditDisplayLine[];
}

export function patternPreview(pattern: string | undefined): string | undefined {
	const collapsed = pattern?.replace(/\s+/g, " ").trim();
	return collapsed || undefined;
}

function fileTargetUri(filePath: string): string {
	try {
		return url.pathToFileURL(path.resolve(filePath)).href;
	} catch {
		return filePath;
	}
}

function formatErrorLines(text: string): string[] {
	const clean = replaceTabs(
		text
			.replace(/\r/g, "")
			.replace(/^Error:\s*/, "")
			.trim(),
	);
	return `  ${clean || "Unknown error"}`.split("\n");
}

function astEditStatus(
	phase: CallPhase,
	outcome: CallOutcome | undefined,
	totalReplacements: number,
	limitReached: boolean,
): ToolUIStatus {
	if (phase !== "settled") return "pending";
	if (outcome === "failed" || outcome === "timed_out") return "error";
	if (outcome === "cancelled" || outcome === "skipped") return "aborted";
	if (totalReplacements === 0 || limitReached) return "warning";
	return "success";
}

function AstEditChangeLine(props: { readonly line: AstEditDisplayLine }): JSX.Element {
	return (
		<text wrap="none">
			<Show when={props.line.uri} fallback={<span color={props.line.color}>{props.line.display}</span>}>
				<link href={props.line.uri!}>
					<span color={props.line.color}>{props.line.display}</span>
				</link>
			</Show>
		</text>
	);
}

function AstEditView(props: ToolViewProps<AstEditRenderArgs, AstEditToolDetails>): JSX.Element {
	const rewriteCount = createMemo(() => props.args?.ops?.length ?? 0);
	const replacements = createMemo(() => props.details?.totalReplacements ?? 0);
	const filesTouched = createMemo(() => props.details?.filesTouched ?? 0);
	const filesSearched = createMemo(() => props.details?.filesSearched ?? 0);
	const limitReached = createMemo(() => props.details?.limitReached ?? false);
	const parseErrors = createMemo(() => props.details?.parseErrors ?? []);
	const parseErrorsTotal = createMemo(() => props.details?.parseErrorsTotal ?? parseErrors().length);

	const outputText = createMemo(() => {
		props.output.version();
		return props.output.text();
	});

	const presentation = createMemo<AstEditPresentation>(() => {
		if (props.outcome === "failed" || props.outcome === "timed_out") return "error";
		if (props.outcome === "cancelled" || props.outcome === "skipped") return "aborted";
		if (props.phase !== "settled" && props.details === undefined && outputText().length === 0) return "call";
		return replacements() === 0 ? "empty" : "changes";
	});

	const status = createMemo(() => astEditStatus(props.phase, props.outcome, replacements(), limitReached()));

	const description = createMemo(() => {
		const kind = presentation();
		if (kind === "error" || kind === "aborted") return undefined;
		if (kind === "call") {
			if (rewriteCount() === 1) return patternPreview(props.args?.ops?.[0]?.pat);
			return rewriteCount() > 0 ? `${rewriteCount()} rewrites` : "?";
		}
		return rewriteCount() === 1 ? patternPreview(props.args?.ops?.[0]?.pat) : undefined;
	});

	const meta = createMemo(() => {
		const items: AstEditMetaItem[] = [];
		const kind = presentation();
		if (kind === "call") {
			if (props.args?.paths?.length) items.push({ text: `in ${props.args.paths.join(", ")}` });
			if (rewriteCount() > 1) items.push({ text: `${rewriteCount()} rewrites` });
			return items;
		}
		if (kind === "error" || kind === "aborted") return items;
		if (kind === "empty") {
			items.push({ text: "0 replacements" });
			if (props.details?.scopePath) items.push({ text: `in ${props.details.scopePath}` });
			if (filesSearched() > 0) items.push({ text: `searched ${filesSearched()}` });
			return items;
		}

		items.push({ text: `${replacements()} replacement${replacements() === 1 ? "" : "s"}` });
		items.push({ text: `${filesTouched()} file${filesTouched() === 1 ? "" : "s"}` });
		if (props.details?.scopePath) items.push({ text: `in ${props.details.scopePath}` });
		items.push({ text: `searched ${filesSearched()}` });
		if (limitReached()) items.push({ text: "limit reached", color: "warning" });
		return items;
	});

	const changeGroups = createMemo(() => {
		const text = props.details?.displayContent ?? outputText();
		if (!text) return { groups: [] as AstEditChangeGroup[], remainingGroups: 0 };

		const lines = text.split("\n");
		const contexts = classifyGroupedLines(
			lines,
			props.details?.cwd ?? props.details?.searchPath,
			props.details?.searchPath,
		);
		const displayLines: AstEditDisplayLine[] = lines.map((line, index) => {
			const context = contexts[index]!;
			const targetPath = context.kind === "dir" || context.kind === "file" ? context.headerPath : undefined;
			let color: AstEditDisplayLine["color"];
			if (context.kind === "dir") {
				color = "accent";
			} else if (context.kind === "file") {
				color = context.depth === 1 ? "accent" : "dim";
			} else if (line.startsWith("+")) {
				color = "toolDiffAdded";
			} else if (line.startsWith("-")) {
				color = "toolDiffRemoved";
			} else {
				color = "toolOutput";
			}
			return {
				display: replaceTabs(line.replace("│", " ")),
				kind: context.kind,
				uri: targetPath ? fileTargetUri(targetPath) : undefined,
				color,
			};
		});

		const allGroups = groupLineIndicesByBlank(lines)
			.filter(indices => {
				const first = lines[indices[0]!]!;
				return !first.startsWith("Safety cap reached") && !first.startsWith("Parse issues:");
			})
			.map((indices, index) => ({
				key: `change:${index}`,
				lines: indices.map(lineIndex => displayLines[lineIndex]!),
			}));

		if (props.ui.expanded) return { groups: allGroups, remainingGroups: 0 };

		let shown = 0;
		let rowCount = 0;
		for (let index = 0; index < allGroups.length; index++) {
			const group = allGroups[index]!;
			const separator = shown > 0 ? 1 : 0;
			const remainingAfter = allGroups.length - index - 1;
			const reservedSummary = remainingAfter > 0 ? 1 : 0;
			if (shown > 0 && rowCount + separator + group.lines.length + reservedSummary > COLLAPSED_CHANGE_LIMIT) break;
			rowCount += separator + group.lines.length;
			shown++;
		}
		return { groups: allGroups.slice(0, shown), remainingGroups: allGroups.length - shown };
	});

	const abortLines = createMemo(() => {
		const text = outputText();
		return text.length === 0 ? [] : text.split("\n").map(line => replaceTabs(line.replace(/\r/g, "")));
	});

	const isFramed = createMemo(() => {
		const kind = presentation();
		return (
			kind === "error" ||
			kind === "changes" ||
			(kind === "empty" && parseErrors().length > 0) ||
			(kind === "aborted" && abortLines().length > 0)
		);
	});

	const cardRecipe = createMemo(() => {
		const kind = presentation();
		if (kind === "error") return "tool.card.error";
		if (kind === "empty" && parseErrors().length > 0) return "tool.card.running";
		if (kind === "changes") return props.phase === "settled" ? "tool.card.success" : "tool.card.running";
		return undefined;
	});

	const borderColor = createMemo<"error" | "borderMuted" | undefined>(() => {
		if (presentation() === "error") return "error";
		return isFramed() ? "borderMuted" : undefined;
	});

	const proposed = createMemo(() => presentation() === "changes" && props.details?.applied !== true);

	const header = () => (
		<ToolHeader
			status={status()}
			labelOverflow="ellipsis"
			label={
				<>
					<span color="accent">AST Edit</span>
					<Show when={description()}>
						<span>: </span>
						<span color="muted">{description()}</span>
					</Show>
					<Show when={proposed()}>
						{" "}
						<badge color="warning">proposed</badge>
					</Show>
					<For each={meta()}>
						{(item, index) => (
							<>
								<span color="dim">{index() === 0 ? " " : " · "}</span>
								<span color={item.color ?? "dim"}>{item.text}</span>
							</>
						)}
					</For>
				</>
			}
		/>
	);

	return (
		<Show when={isFramed()} fallback={header()}>
			<Card title={header()} borderColor={borderColor()} backgroundBorder={true} recipe={cardRecipe()}>
				<stack>
					<Show when={presentation() === "error"}>
						<For each={formatErrorLines(outputText())}>{line => <text color="error">{line}</text>}</For>
					</Show>

					<Show when={presentation() === "aborted"}>
						<preview
							items={abortLines()}
							edge="head"
							limit={props.ui.expanded ? abortLines().length : COLLAPSED_CHANGE_LIMIT}
							unit="lines"
							color="dim"
						/>
					</Show>

					<Show when={presentation() === "empty" && parseErrors().length > 0}>
						<For each={parseErrors().slice(0, PARSE_ERRORS_LIMIT)}>
							{error => (
								<text color="warning" wrap="none">
									{" "}
									- {error}
								</text>
							)}
						</For>
						<Show when={parseErrorsTotal() > PARSE_ERRORS_LIMIT}>
							<text color="dim" wrap="none">
								… {parseErrorsTotal() - PARSE_ERRORS_LIMIT} more
							</text>
						</Show>
					</Show>

					<Show when={presentation() === "changes"}>
						<For each={changeGroups().groups}>
							{(group, index) => (
								<>
									<Show when={index() > 0}>
										<br />
									</Show>
									<For each={group.lines}>{line => <AstEditChangeLine line={line} />}</For>
								</>
							)}
						</For>
						<Show when={changeGroups().remainingGroups > 0}>
							<text color="muted" wrap="none">
								{formatMoreItems(changeGroups().remainingGroups, "change")}
							</text>
						</Show>
						<Show when={limitReached()}>
							<text color="warning" wrap="none">
								limit reached; narrow path
							</text>
						</Show>
						<Show when={parseErrors().length > 0}>
							<text color="warning" wrap="none">
								{formatParseErrorsCountLabel(parseErrors(), parseErrorsTotal())}
							</text>
						</Show>
					</Show>
				</stack>
			</Card>
		</Show>
	);
}

function astEditSummary(props: ToolViewProps<AstEditRenderArgs, AstEditToolDetails>): ActivitySummary {
	const rewriteCount = props.args?.ops?.length ?? 0;
	const detail = rewriteCount === 1 ? patternPreview(props.args?.ops?.[0]?.pat) : undefined;
	return {
		label: "AST Edit",
		detail,
		status: astEditStatus(
			props.phase,
			props.outcome,
			props.details?.totalReplacements ?? 0,
			props.details?.limitReached ?? false,
		),
	};
}

export const astEditToolView: ToolViewDefinition<AstEditRenderArgs, AstEditToolDetails> = {
	view: AstEditView,
	summary: astEditSummary,
	framed: true,
};

registerToolView("ast_edit", astEditToolView);
