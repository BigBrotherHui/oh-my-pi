import * as path from "node:path";
import * as url from "node:url";
import { createMemo, For, Show, type Accessor, type JSX } from "../reactive";
import {
	formatMoreItems,
	formatParseErrorsCountLabel,
	PARSE_ERRORS_LIMIT,
	PREVIEW_LIMITS,
	replaceTabs,
	toPathList,
} from "../render/render-utils";
import type { ToolUIStatus } from "../host/elements/status";
import { ToolCard } from "../view/tool-card";
import { ToolHeader } from "../view/tool-header";
import { classifyGroupedLines, groupLineIndicesByBlank, type GroupedFilesStructure } from "./grouped-file-output";

import type { OutputMeta } from "./output-meta";
import { registerToolView } from "./registry";
import type { ActivitySummary, CallOutcome, CallPhase, ToolViewDefinition, ToolViewProps } from "./view";

/** Display metadata returned by ast-grep. */
export interface AstGrepToolDetails {
	matchCount: number;
	fileCount: number;
	filesSearched: number;
	limitReached: boolean;
	parseErrors?: string[];
	parseErrorsTotal?: number;
	scopePath?: string;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	displayContent?: string;
	searchPath?: string;
	cwd?: string;
	structure?: GroupedFilesStructure;
}

export interface AstGrepRenderArgs {
	pat?: string;
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string[];
	skip?: number;
}

const COLLAPSED_MATCH_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

type AstGrepPresentation = "call" | "matches" | "empty" | "error" | "aborted";

interface AstGrepMetaItem {
	readonly text: string;
	readonly color?: "warning";
}

interface AstDisplayLine {
	readonly display: string;
	readonly fileUri?: string;
	readonly color: "accent" | "dim" | "toolOutput";
}

interface AstGroup {
	readonly lines: readonly AstDisplayLine[];
}

function fileTargetUri(filePath: string): string {
	try {
		return url.pathToFileURL(path.resolve(filePath)).href;
	} catch {
		return filePath;
	}
}

function astGrepStatus(
	phase: CallPhase,
	outcome: CallOutcome | undefined,
	matchCount: number | undefined,
	limitReached: boolean,
): ToolUIStatus {
	if (phase !== "settled") return "pending";
	if (outcome === "failed" || outcome === "timed_out") return "error";
	if (outcome === "cancelled" || outcome === "skipped") return "aborted";
	if (matchCount === 0 || limitReached) return "warning";
	return "success";
}

function errorText(text: string): string {
	const clean = replaceTabs(text.replace(/^Error:\s*/, "").trim());
	return clean || "Unknown error";
}

export function AstGrepView(props: ToolViewProps<AstGrepRenderArgs, AstGrepToolDetails>): JSX.Element {
	const paths = createMemo(() => {
		const input = props.args.path ?? props.args.paths;
		return typeof input === "string" ? toPathList(input) : (input ?? []);
	});
	const outputText = createMemo(() => {
		props.output.version();
		return props.output.text();
	});
	const displayText = createMemo(() => props.details?.displayContent ?? outputText());
	const parseErrors = createMemo(() => props.details?.parseErrors ?? []);
	const parseErrorsTotal = createMemo(() => props.details?.parseErrorsTotal ?? parseErrors().length);
	const matchCount = createMemo(() => props.details?.matchCount);
	const limitReached = createMemo(() => props.details?.limitReached ?? false);

	const presentation = createMemo<AstGrepPresentation>(() => {
		if (props.outcome === "failed" || props.outcome === "timed_out") return "error";
		if (props.outcome === "cancelled" || props.outcome === "skipped") return "aborted";
		if (props.phase !== "settled" && props.details === undefined && outputText().length === 0) return "call";
		if (matchCount() === 0 || (props.phase === "settled" && matchCount() === undefined)) return "empty";
		return "matches";
	});

	const status = createMemo(() => astGrepStatus(props.phase, props.outcome, matchCount(), limitReached()));

	const description = createMemo(() => {
		const kind = presentation();
		if (kind === "error" || kind === "aborted") return undefined;
		return kind === "call" ? (props.args.pat ?? "?") : props.args.pat;
	});

	const meta = createMemo<AstGrepMetaItem[]>(() => {
		const items: AstGrepMetaItem[] = [];
		const kind = presentation();
		if (kind === "call") {
			if (paths().length > 0) items.push({ text: `in ${paths().join(", ")}` });
			if (props.args.skip !== undefined && props.args.skip > 0) items.push({ text: `skip:${props.args.skip}` });
			return items;
		}
		if (kind === "error" || kind === "aborted") return items;
		if (kind === "empty") {
			const filesSearched = props.details?.filesSearched ?? 0;
			items.push({ text: "0 matches" });
			if (props.details?.scopePath) items.push({ text: `in ${props.details.scopePath}` });
			if (filesSearched > 0) items.push({ text: `searched ${filesSearched}` });
			return items;
		}

		const matches = matchCount();
		const files = props.details?.fileCount;
		const filesSearched = props.details?.filesSearched ?? 0;
		if (matches !== undefined) items.push({ text: `${matches} match${matches === 1 ? "" : "es"}` });
		if (files !== undefined) items.push({ text: `${files} file${files === 1 ? "" : "s"}` });
		if (props.details?.scopePath) items.push({ text: `in ${props.details.scopePath}` });
		items.push({ text: `searched ${filesSearched}` });
		if (limitReached()) items.push({ text: "limit reached", color: "warning" });
		return items;
	});

	const header = () => {
		const kind = presentation();
		const completedSearch = kind === "matches" && status() === "success";
		return (
			<ToolHeader
				status={completedSearch ? undefined : status()}
				labelOverflow={presentation() === "matches" ? "clip" : "ellipsis"}
				wrap={presentation() === "matches" ? "none" : "word"}
				label={
					<>
						<Show when={completedSearch}>
							<icon name="icon.search" color="accent" />{" "}
						</Show>
						<span color="accent">AST Grep</span>
						<Show when={description()}>
							<span>: </span>
							<span color="muted">{description()}</span>
						</Show>
					</>
				}
				meta={<For each={meta()}>{item => <span color={item.color}>{item.text}</span>}</For>}
			/>
		);
	};

	const budgeted = createMemo(() => {
		const text = displayText();
		if (!text) return { groups: [] as AstGroup[], remainingGroups: 0 };

		const lines = text.split("\n");
		const contexts = classifyGroupedLines(
			lines,
			props.details?.cwd ?? props.details?.searchPath,
			props.details?.searchPath,
		);
		const displayLines: AstDisplayLine[] = lines.map((line, index) => {
			const context = contexts[index]!;
			const targetPath = context.kind === "dir" || context.kind === "file" ? context.headerPath : undefined;
			const color: AstDisplayLine["color"] =
				context.kind === "dir"
					? "accent"
					: context.kind === "file"
						? context.depth === 1
							? "accent"
							: "dim"
						: line.startsWith("  meta:")
							? "dim"
							: "toolOutput";
			return {
				display: replaceTabs(line),
				fileUri: targetPath ? fileTargetUri(targetPath) : undefined,
				color,
			};
		});

		const groups = groupLineIndicesByBlank(lines)
			.filter(indices => {
				const first = lines[indices[0]!]!;
				return !first.startsWith("Result limit reached") && !first.startsWith("Parse issues:");
			})
			.map(indices => ({
				lines: indices.map(lineIndex => displayLines[lineIndex]!),
			}));

		if (props.ui.expanded) return { groups, remainingGroups: 0 };

		let shown = 0;
		let rowCount = 0;
		for (let index = 0; index < groups.length; index++) {
			const group = groups[index]!;
			const remainingAfter = groups.length - index - 1;
			const reservedSummary = remainingAfter > 0 ? 1 : 0;
			if (rowCount + group.lines.length + reservedSummary > COLLAPSED_MATCH_LIMIT) break;
			rowCount += group.lines.length;
			shown++;
		}
		return { groups: groups.slice(0, shown), remainingGroups: groups.length - shown };
	});

	const abortedLines = createMemo(() => {
		const text = outputText();
		return text.length === 0 ? [] : text.split("\n").map(line => replaceTabs(line.replace(/\r/g, "")));
	});

	const shownParseErrors = createMemo(() => parseErrors().slice(0, PARSE_ERRORS_LIMIT));

	return (
		<ToolCard
			phase={props.phase}
			outcome={props.outcome}
			framed={false}
			paddingX={0}
			tint={false}
			expanded={true}
			header={presentation() === "error" ? undefined : header()}
		>
			<Show when={presentation() === "error"}>
				<text color="error">
					<status value="error" /> Error: {errorText(outputText())}
				</text>
			</Show>

			<Show when={presentation() === "aborted" && abortedLines().length > 0}>
				<preview
					items={abortedLines()}
					edge="head"
					limit={props.ui.expanded ? abortedLines().length : COLLAPSED_MATCH_LIMIT}
					unit="lines"
					color="dim"
				/>
			</Show>

			<Show when={presentation() === "empty"}>
				<stack>
					<row gap={1}>
						<status value="warning" />
						<text color="muted">No matches found</text>
					</row>
					<Show when={parseErrors().length > 0}>
						<text color="warning">Query may be mis-scoped; narrow `path` before concluding absence</text>
						<For each={shownParseErrors()}>
							{error => (
								<text color="warning" wrap="none">
									{" "}
									- {error}
								</text>
							)}
						</For>
						<Show when={parseErrorsTotal() > shownParseErrors().length}>
							<text color="dim" wrap="none">
								{" "}
								… {parseErrorsTotal() - shownParseErrors().length} more
							</text>
						</Show>
					</Show>
				</stack>
			</Show>

			<Show when={presentation() === "matches"}>
				<stack>
					<tree guides={true}>
						<For each={budgeted().groups}>
							{group => (
								<stack>
									<For each={group.lines}>
										{line => (
											<text wrap="none">
												<Show when={line.fileUri} fallback={<span color={line.color}>{line.display}</span>}>
													{(fileUri: Accessor<string>) => (
														<link href={fileUri()}>
															<span color={line.color}>{line.display}</span>
														</link>
													)}
												</Show>
											</text>
										)}
									</For>
								</stack>
							)}
						</For>
						<Show when={budgeted().remainingGroups > 0}>
							<text color="muted" wrap="none">
								{formatMoreItems(budgeted().remainingGroups, "match")}
							</text>
						</Show>
					</tree>

					<Show when={limitReached()}>
						<text color="warning">limit reached; narrow path or increase limit</text>
					</Show>

					<Show when={parseErrors().length > 0}>
						<text color="warning">{formatParseErrorsCountLabel(parseErrors(), parseErrorsTotal())}</text>
					</Show>
				</stack>
			</Show>
		</ToolCard>
	);
}

export function astGrepActivitySummary(props: ToolViewProps<AstGrepRenderArgs, AstGrepToolDetails>): ActivitySummary {
	const pattern = props.args.pat ?? "";
	const matchCount = props.details?.matchCount;
	const detail = matchCount !== undefined ? `${matchCount} match${matchCount === 1 ? "" : "es"}` : undefined;
	return {
		label: pattern ? `AST Grep ${pattern}` : "AST Grep",
		detail,
		status: astGrepStatus(props.phase, props.outcome, matchCount, props.details?.limitReached ?? false),
	};
}

export const astGrepToolView: ToolViewDefinition<AstGrepRenderArgs, AstGrepToolDetails> = {
	view: AstGrepView,
	summary: astGrepActivitySummary,
	framed: false,
	tint: false,
};

registerToolView("ast_grep", astGrepToolView);
registerToolView("ast-grep", astGrepToolView);
