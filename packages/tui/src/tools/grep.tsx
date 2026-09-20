import * as path from "node:path";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { createMemo, For, Show, type JSX } from "../reactive";
import { fileUriForTerminal } from "../render/hyperlink";
import { PREVIEW_LIMITS, replaceTabs, toPathList } from "../render/render-utils";
import { TERMINAL } from "../terminal-capabilities";
import { ToolCard } from "../view/tool-card";
import { ToolHeader } from "../view/tool-header";
import type { ToolUIStatus } from "../host/elements/status";
import { classifyGroupedLines, groupLineIndicesByBlank, type GroupedFilesStructure } from "./grouped-file-output";

import type { OutputMeta } from "./output-meta";
import { registerToolView } from "./registry";
import type { TruncationResult } from "./streaming-output";
import type { ActivitySummary, ToolViewDefinition, ToolViewProps } from "./view";

/** Display metadata returned by grep. */
export interface GrepToolDetails {
	truncation?: TruncationResult;
	fileLimitReached?: number;
	perFileLimitReached?: number;
	linesTruncated?: boolean;
	meta?: OutputMeta;
	scopePath?: string;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	truncated?: boolean;
	error?: string;
	displayContent?: string;
	displayTargets?: Record<string, string>;
	searchPath?: string;
	cwd?: string;
	missingPaths?: string[];
	structure?: GroupedFilesStructure;
}

export interface GrepRenderArgs {
	pattern?: string;
	path?: string | string[];
	paths?: string | string[];
	case?: boolean;
	gitignore?: boolean;
	skip?: number;
}

const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;
const EXPANDED_TEXT_LIMIT = PREVIEW_LIMITS.EXPANDED_LINES * 2;
const SEARCH_CODE_FRAME_LINE_RE = /^\s*\*?(\d+)│/;
const SEARCH_MATCH_LINE_RE = /^\s*\*\d+(?:│|[:|])/;

function fileTargetUri(filePath: string, line?: number): string {
	try {
		return fileUriForTerminal(path.resolve(filePath), line === undefined ? undefined : { line }, TERMINAL.id);
	} catch {
		return filePath;
	}
}

function isSearchHeaderLine(line: string): boolean {
	return /^#+ /.test(line);
}

function isSearchMatchLine(line: string): boolean {
	return SEARCH_MATCH_LINE_RE.test(line);
}

function searchDisplayLineNumber(line: string): number | undefined {
	const match = SEARCH_CODE_FRAME_LINE_RE.exec(line);
	return match ? Number.parseInt(match[1]!, 10) : undefined;
}

interface GrepTruncationDetails {
	readonly truncated?: boolean;
	readonly truncation?: unknown;
	readonly meta?: {
		readonly truncation?: unknown;
		readonly limits?: { readonly columnTruncated?: unknown };
	};
	readonly linesTruncated?: boolean;
	readonly fileLimitReached?: number;
	readonly perFileLimitReached?: number;
}

function hasTruncatedOutput(details: GrepTruncationDetails | undefined): boolean {
	return Boolean(
		details?.truncated ||
		details?.truncation ||
		details?.meta?.truncation ||
		details?.meta?.limits?.columnTruncated ||
		details?.linesTruncated ||
		details?.fileLimitReached ||
		details?.perFileLimitReached,
	);
}

interface BudgetedLine {
	raw: string;
	kind: "dir" | "file" | "content";
	href?: string;
	headerColor?: "accent" | "dim";
}

interface BudgetedGroup {
	key: string;
	lines: BudgetedLine[];
}

const EMPTY_BUDGETED_GROUPS: readonly BudgetedGroup[] = [];

interface PreviewLines {
	lines: string[];
	summaryText?: string;
}

export function GrepView(props: ToolViewProps<GrepRenderArgs, GrepToolDetails>): JSX.Element {
	const pattern = createMemo(() => props.args.pattern ?? "");
	const paths = createMemo(() => {
		const input = props.args.path ?? props.args.paths;
		if (typeof input === "string") return toPathList(input);
		return input === undefined ? [] : [...input];
	});
	const hasDetailedData = createMemo(
		() => props.details?.matchCount !== undefined || props.details?.fileCount !== undefined,
	);
	const isAborted = createMemo(
		() => props.phase === "settled" && (props.outcome === "cancelled" || props.outcome === "skipped"),
	);
	const isError = createMemo(
		() =>
			!isAborted() &&
			(props.outcome === "failed" || props.outcome === "timed_out" || props.details?.error !== undefined),
	);
	const isTruncated = createMemo(() => hasTruncatedOutput(props.details));
	const missingPaths = createMemo(() => props.details?.missingPaths ?? []);

	const rawText = createMemo(() => {
		props.output.version();
		return props.details?.displayContent ?? props.output.text() ?? "";
	});
	const allLines = createMemo(() => {
		const text = rawText();
		return text ? text.split("\n") : [];
	});
	const fallbackLines = createMemo(() => allLines().filter(line => line.trim().length > 0));

	const callMeta = createMemo<string[]>(() => {
		const parts: string[] = [];
		if (paths().length > 0) parts.push(`in ${paths().join(", ")}`);
		if (props.args.case === false) parts.push("case:insensitive");
		if (props.args.gitignore === false) parts.push("gitignore:false");
		if (props.args.skip !== undefined && props.args.skip > 0) parts.push(`skip:${props.args.skip}`);
		return parts;
	});
	const settledMeta = createMemo<string[]>(() => {
		if (!hasDetailedData()) {
			const count = fallbackLines().length;
			return count > 0 ? [`${count} item${count === 1 ? "" : "s"}`] : [];
		}
		const parts: string[] = [];
		const matchCount = props.details?.matchCount;
		const fileCount = props.details?.fileCount;
		if (matchCount !== undefined) parts.push(`${matchCount} match${matchCount === 1 ? "" : "es"}`);
		if (fileCount !== undefined) parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
		return parts;
	});
	const headerMeta = createMemo(() => (props.phase === "settled" ? settledMeta() : callMeta()));
	const scopeUri = createMemo(() => {
		const target = props.details?.searchPath;
		return target ? fileTargetUri(target) : undefined;
	});
	const headerStatus = createMemo<ToolUIStatus | undefined>(() => {
		if (props.phase === "receiving" || props.phase === "queued") return "pending";
		if (props.phase === "running") return "pending";
		if (isAborted()) return "aborted";
		if (isError()) return "error";
		if (hasDetailedData() && (isTruncated() || props.details?.matchCount === 0)) return "warning";
		return undefined;
	});
	const headerIcon = createMemo<"icon.search" | undefined>(() => {
		if (props.phase !== "settled" || isAborted() || isError()) return undefined;
		if (hasDetailedData() && (isTruncated() || props.details?.matchCount === 0)) return undefined;
		return "icon.search";
	});
	const showPattern = createMemo(() => props.phase !== "settled" || pattern().length > 0);
	const headerPattern = createMemo(() => pattern() || "?");
	const header = createMemo(() => (
		<ToolHeader
			status={headerStatus()}
			icon={headerIcon()}
			iconColor="toolTitle"
			labelOverflow={props.phase === "settled" ? "clip" : "ellipsis"}
			wrap={props.phase === "settled" ? "none" : "word"}
			label={
				<>
					<span color="toolTitle">Grep</span>
					<Show when={showPattern()}>
						<span>: </span>
						<span color="muted">{headerPattern()}</span>
					</Show>
				</>
			}
			meta={
				<>
					<For each={headerMeta()}>{item => <span>{item}</span>}</For>
					<Show when={props.phase === "settled" && hasDetailedData() && props.details?.scopePath}>
						<span>
							in{" "}
							<Show when={scopeUri()} fallback={<span>{props.details?.scopePath}</span>}>
								<link href={scopeUri()!}>
									<span>{props.details?.scopePath}</span>
								</link>
							</Show>
						</span>
					</Show>
					<Show when={props.phase === "settled" && hasDetailedData() && isTruncated()}>
						<span color="warning">truncated</span>
					</Show>
				</>
			}
		/>
	));

	const simplePreview = createMemo<PreviewLines>(() => {
		const lines = fallbackLines();
		if (props.ui.expanded || lines.length <= COLLAPSED_TEXT_LIMIT) return { lines };
		const shown = Math.max(COLLAPSED_TEXT_LIMIT - 1, 0);
		const hidden = lines.length - shown;
		return {
			lines: lines.slice(0, shown),
			summaryText: hidden > 0 ? `… ${hidden} more item${hidden === 1 ? "" : "s"}` : undefined,
		};
	});

	const budgeted = createMemo(() => {
		const lines = allLines();
		if (lines.length === 0) return { groups: EMPTY_BUDGETED_GROUPS, summaryText: undefined };

		const maxLines =
			(props.ui.expanded ? EXPANDED_TEXT_LIMIT : COLLAPSED_TEXT_LIMIT) - (missingPaths().length > 0 ? 1 : 0);
		if (maxLines <= 0) return { groups: EMPTY_BUDGETED_GROUPS, summaryText: undefined };

		const headerBase = props.details?.cwd ?? props.details?.searchPath;
		const fileScope = props.details?.searchPath;
		const displayTargets = props.details?.displayTargets;
		const contexts = classifyGroupedLines(lines, headerBase, fileScope);
		let urlFile: string | undefined;

		const renderedLines: BudgetedLine[] = lines.map((line, index) => {
			const context = contexts[index]!;
			if (context.kind === "dir") {
				urlFile = undefined;
				return {
					raw: line,
					kind: context.kind,
					href: context.headerPath ? fileTargetUri(context.headerPath) : undefined,
					headerColor: "accent",
				};
			}
			if (context.kind === "file") {
				if (context.isUrl) {
					const target = line
						.replace(/^#+\s+/, "")
						.trimEnd()
						.replace(/\s+\([^)]*\)\s*$/, "");
					const resolved = displayTargets?.[target];
					urlFile = resolved;
					return {
						raw: line,
						kind: context.kind,
						href: resolved ? fileTargetUri(resolved) : target,
						headerColor: "accent",
					};
				}
				urlFile = undefined;
				return {
					raw: line,
					kind: context.kind,
					href: context.headerPath ? fileTargetUri(context.headerPath) : undefined,
					headerColor: context.depth === 1 ? "accent" : "dim",
				};
			}

			const target = context.filePath ?? urlFile;
			const lineNumber = searchDisplayLineNumber(line);
			return {
				raw: line,
				kind: context.kind,
				href: target && lineNumber !== undefined ? fileTargetUri(target, lineNumber) : undefined,
			};
		});

		const renderedGroups = groupLineIndicesByBlank(lines)
			.map(indices => indices.map(index => renderedLines[index]!))
			.map(group => {
				if (props.ui.expanded) return group;
				const compact = group.filter(line => isSearchHeaderLine(line.raw) || isSearchMatchLine(line.raw));
				return compact.length > 0 ? compact : group;
			})
			.filter(group => group.length > 0);

		let totalLines = 0;
		let totalMarkedMatches = 0;
		let totalFallbackMatches = 0;
		for (const group of renderedGroups) {
			totalLines += group.length;
			totalMarkedMatches += group.filter(line => isSearchMatchLine(line.raw)).length;
			totalFallbackMatches += group.filter(
				line => !isSearchHeaderLine(line.raw) && line.raw.trim().length > 0,
			).length;
		}

		const hasMarkedMatches = totalMarkedMatches > 0;
		const needsSummary = totalLines > maxLines;
		const contentBudget = needsSummary ? Math.max(maxLines - 1, 0) : maxLines;
		const groups: BudgetedGroup[] = [];
		let visibleLineCount = 0;
		let visibleMatches = 0;
		for (let groupIndex = 0; groupIndex < renderedGroups.length; groupIndex++) {
			if (visibleLineCount >= contentBudget) break;
			const group = renderedGroups[groupIndex]!;
			const visible = group.slice(0, contentBudget - visibleLineCount);
			if (visible.length === 0) break;
			groups.push({ key: `g:${groupIndex}`, lines: visible });
			visibleLineCount += visible.length;
			visibleMatches += visible.filter(line =>
				hasMarkedMatches
					? isSearchMatchLine(line.raw)
					: !isSearchHeaderLine(line.raw) && line.raw.trim().length > 0,
			).length;
		}

		const totalMatches = hasMarkedMatches
			? totalMarkedMatches
			: Math.max(props.details?.matchCount ?? 0, totalFallbackMatches);
		const hiddenMatches = Math.max(totalMatches - visibleMatches, 0);
		const hiddenLines = Math.max(totalLines - visibleLineCount, 0);
		let summaryText: string | undefined;
		if (needsSummary && (hiddenMatches > 0 || hiddenLines > 0)) {
			const hidden = hiddenMatches > 0 ? hiddenMatches : hiddenLines;
			const noun = hiddenMatches > 0 ? (hidden === 1 ? "match" : "matches") : hidden === 1 ? "line" : "lines";
			summaryText = `… ${hidden} more ${noun}`;
		}

		return { groups, summaryText };
	});

	const errorText = createMemo(() => {
		const message = props.details?.error || props.output.text() || "Unknown error";
		return (
			sanitizeText(message)
				.replace(/^Error:\s*/i, "")
				.trim() || "Unknown error"
		);
	});
	const isEmptyUndetailedResult = createMemo(
		() =>
			props.phase === "settled" &&
			!isAborted() &&
			!hasDetailedData() &&
			(rawText().length === 0 || rawText() === "No matches found"),
	);

	return (
		<Show
			when={isError()}
			fallback={
				<Show
					when={isEmptyUndetailedResult()}
					fallback={
						<ToolCard
							phase={props.phase}
							outcome={props.outcome}
							framed={false}
							paddingX={1}
							expanded={true}
							tint={false}
							header={header()}
						>
							<Show when={props.phase !== "settled" && simplePreview().lines.length > 0}>
								<tree guides={true} indent={3}>
									<For each={simplePreview().lines}>
										{line => (
											<text color="toolOutput" wrap="none">
												{replaceTabs(line)}
											</text>
										)}
									</For>
									<Show when={simplePreview().summaryText}>
										<text color="muted">{simplePreview().summaryText}</text>
									</Show>
								</tree>
							</Show>

							<Show when={props.phase === "settled" && !isAborted() && hasDetailedData()}>
								<Show
									when={(props.details?.matchCount ?? 0) > 0}
									fallback={
										<stack>
											<row gap={1}>
												<status value="warning" />
												<text color="muted">No matches found</text>
											</row>
											<Show when={missingPaths().length > 0}>
												<text color="warning">skipped missing: {missingPaths().join(", ")}</text>
											</Show>
										</stack>
									}
								>
									<stack>
										<tree guides={true} indent={3}>
											<For each={budgeted().groups}>
												{group => (
													<stack>
														<For each={group.lines}>
															{line => (
																<text wrap="none">
																	<Show
																		when={line.href}
																		fallback={
																			<span
																				color={
																					line.kind === "content" ? "toolOutput" : line.headerColor
																				}
																			>
																				{replaceTabs(line.raw)}
																			</span>
																		}
																	>
																		<link href={line.href!}>
																			<span
																				color={
																					line.kind === "content" ? "toolOutput" : line.headerColor
																				}
																			>
																				{replaceTabs(line.raw)}
																			</span>
																		</link>
																	</Show>
																</text>
															)}
														</For>
													</stack>
												)}
											</For>
											<Show when={budgeted().summaryText}>
												<text color="muted">{budgeted().summaryText}</text>
											</Show>
										</tree>
										<Show when={missingPaths().length > 0}>
											<text color="warning">skipped missing: {missingPaths().join(", ")}</text>
										</Show>
									</stack>
								</Show>
							</Show>

							<Show when={props.phase === "settled" && !isAborted() && !hasDetailedData()}>
								<tree guides={true} indent={3}>
									<For each={simplePreview().lines}>
										{line => (
											<text color="toolOutput" wrap="none">
												{replaceTabs(line)}
											</text>
										)}
									</For>
									<Show when={simplePreview().summaryText}>
										<text color="muted">{simplePreview().summaryText}</text>
									</Show>
								</tree>
							</Show>
						</ToolCard>
					}
				>
					<ToolCard
						phase={props.phase}
						outcome={props.outcome}
						framed={false}
						paddingX={1}
						expanded={true}
						tint={false}
					>
						<row gap={1}>
							<status value="warning" />
							<text color="muted">No matches found</text>
						</row>
					</ToolCard>
				</Show>
			}
		>
			<ToolCard phase={props.phase} outcome={props.outcome} framed={false} paddingX={1} expanded={true} tint={false}>
				<text color="error">
					<status value="error" /> Error: {errorText()}
				</text>
			</ToolCard>
		</Show>
	);
}

export function grepActivitySummary(props: ToolViewProps<GrepRenderArgs, GrepToolDetails>): ActivitySummary {
	const pattern = props.args.pattern ?? "";
	const matchCount = props.details?.matchCount;
	const detail = matchCount !== undefined ? `${matchCount} match${matchCount === 1 ? "" : "es"}` : undefined;
	const status: ToolUIStatus =
		props.phase === "receiving" || props.phase === "queued"
			? "pending"
			: props.phase === "running"
				? "running"
				: props.outcome === "cancelled" || props.outcome === "skipped"
					? "aborted"
					: props.outcome === "failed" || props.outcome === "timed_out" || props.details?.error !== undefined
						? "error"
						: hasTruncatedOutput(props.details) || matchCount === 0
							? "warning"
							: "success";
	return {
		label: pattern ? `Grep ${pattern}` : "Grep",
		detail,
		status,
	};
}

export const grepToolView: ToolViewDefinition<GrepRenderArgs, GrepToolDetails> = {
	view: GrepView,
	summary: grepActivitySummary,
	framed: false,
	tint: false,
};

registerToolView("grep", grepToolView);
