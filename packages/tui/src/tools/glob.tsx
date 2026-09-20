import * as path from "node:path";
import { createMemo, For, Show, type JSX } from "../reactive";
import { PREVIEW_LIMITS, replaceTabs, toPathList } from "../render/render-utils";
import { FileList, type FileEntry } from "../view/file-list";
import { ToolCard } from "../view/tool-card";
import { ToolHeader } from "../view/tool-header";
import { TreeList } from "../view/tree-list";
import type { ToolUIStatus } from "../host/elements/status";

import type { OutputMeta } from "./output-meta";
import { formatFullOutputReference } from "./output-meta";
import { registerToolView } from "./registry";
import type { TruncationResult } from "./streaming-output";
import type { ActivitySummary, ToolViewDefinition, ToolViewProps } from "./view";

/** Display metadata for glob tool results. */
export interface GlobToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	meta?: OutputMeta;
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
	cwd?: string;
	missingPaths?: string[];
}

export interface GlobRenderArgs {
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string | string[];
	limit?: number;
}

type GlobPresentation = "call" | "result" | "empty" | "error" | "aborted";

interface HeaderMeta {
	readonly text: string;
	readonly color?: "warning";
}

export function GlobView(props: ToolViewProps<GlobRenderArgs, GlobToolDetails>): JSX.Element {
	const paths = createMemo(() =>
		toPathList(
			(props.args.path as string | string[] | undefined) ?? (props.args.paths as string | string[] | undefined),
		),
	);
	const renderPaths = createMemo(() => (paths().length > 0 ? paths().join(", ") : undefined));

	const rawText = createMemo(() => {
		props.output.version();
		return props.output.text() ?? "";
	});

	const fallbackFiles = createMemo(() => {
		const text = rawText();
		if (!text || /No files (?:matching|found)/.test(text)) return [];
		return text.split("\n").filter(line => line.trim().length > 0);
	});

	const isTruncated = createMemo(() => {
		const details = props.details;
		const truncation = details?.truncation ?? details?.meta?.truncation;
		const limits = details?.meta?.limits;
		return Boolean(details?.truncated || truncation || details?.resultLimitReached || limits?.resultLimit);
	});

	const hasDetailedData = createMemo(() => props.details?.fileCount !== undefined);
	const isResultVisible = createMemo(
		() => props.phase === "settled" || props.details !== undefined || rawText().length > 0,
	);
	const isAborted = createMemo(
		() => props.phase === "settled" && (props.outcome === "cancelled" || props.outcome === "skipped"),
	);
	const isError = createMemo(
		() =>
			!isAborted() &&
			(props.outcome === "failed" || Boolean(props.details?.error) || rawText().trimStart().startsWith("Error:")),
	);

	const presentation = createMemo<GlobPresentation>(() => {
		if (isAborted()) return "aborted";
		if (isError()) return "error";
		if (!isResultVisible()) return "call";
		if (!hasDetailedData() && fallbackFiles().length === 0) return "empty";
		return "result";
	});

	const callStatus = createMemo<ToolUIStatus>(() => {
		if (isAborted()) return "aborted";
		return "pending";
	});

	const resultMeta = createMemo<readonly HeaderMeta[]>(() => {
		const fileCount = props.details?.fileCount;
		if (fileCount === undefined) {
			const count = fallbackFiles().length;
			return count > 0 ? [{ text: `${count} file${count === 1 ? "" : "s"}` }] : [];
		}

		const meta: HeaderMeta[] = [{ text: `${fileCount} file${fileCount === 1 ? "" : "s"}` }];
		if (fileCount > 0 && props.details?.scopePath) meta.push({ text: `in ${props.details.scopePath}` });
		if (isTruncated()) meta.push({ text: fileCount === 0 ? "timed out" : "truncated", color: "warning" });
		return meta;
	});

	const resultStatus = createMemo<ToolUIStatus | undefined>(() => {
		if (hasDetailedData() && ((props.details?.fileCount ?? 1) === 0 || isTruncated())) return "warning";
		return undefined;
	});

	const callHeader = createMemo(() => (
		<ToolHeader
			status={callStatus()}
			labelOverflow="clip"
			label={
				<>
					<span color="toolTitle">Glob</span>
					<span>: </span>
					<span color="muted">{renderPaths() ?? "*"}</span>
				</>
			}
			meta={
				<Show when={props.args.limit !== undefined}>
					<span>limit:{props.args.limit}</span>
				</Show>
			}
		/>
	));

	const resultHeader = createMemo(() => (
		<ToolHeader
			status={resultStatus()}
			icon={resultStatus() === undefined ? "icon.search" : undefined}
			iconColor="toolTitle"
			labelOverflow="clip"
			wrap="none"
			label={
				<>
					<span color="toolTitle">Glob</span>
					<Show when={renderPaths()}>
						<span>: </span>
						<span color="muted">{renderPaths()}</span>
					</Show>
				</>
			}
			meta={<For each={resultMeta()}>{item => <span color={item.color}>{item.text}</span>}</For>}
		/>
	));

	const missingPaths = createMemo(() => props.details?.missingPaths ?? []);

	const truncationReasons = createMemo(() => {
		const details = props.details;
		const reasons: string[] = [];
		if (details?.resultLimitReached) reasons.push(`limit ${details.resultLimitReached} results`);
		const limits = details?.meta?.limits;
		if (limits?.resultLimit) reasons.push(`limit ${limits.resultLimit.reached} results`);
		const truncation = details?.truncation ?? details?.meta?.truncation;
		if (truncation) reasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		if (truncation && "artifactId" in truncation && truncation.artifactId) {
			reasons.push(formatFullOutputReference(truncation.artifactId));
		}
		return reasons;
	});

	const fileEntries = createMemo<FileEntry[]>(() => {
		const cwd = props.details?.cwd;
		const files = props.details?.files ?? fallbackFiles();
		return files.map(entry => ({
			path: entry,
			absPath: cwd && !entry.endsWith("/") ? path.resolve(cwd, entry) : undefined,
			isDirectory: entry.endsWith("/"),
		}));
	});

	const errorText = createMemo(() => {
		const raw = props.details?.error || rawText();
		const clean = replaceTabs(raw.replace(/^Error:\s*/, "").trim());
		return clean || "Unknown error";
	});

	return (
		<Show
			when={presentation() === "call" || presentation() === "aborted"}
			fallback={
				<Show
					when={presentation() === "empty"}
					fallback={
						<Show
							when={presentation() === "error"}
							fallback={
								<ToolCard
									phase={props.phase}
									outcome={props.outcome}
									framed={false}
									paddingX={1}
									tint={false}
									expanded={true}
									header={resultHeader()}
								>
									<Show
										when={hasDetailedData()}
										fallback={
											<TreeList
												items={fallbackFiles()}
												expanded={props.ui.expanded}
												maxCollapsed={PREVIEW_LIMITS.COLLAPSED_ITEMS}
												itemType="file"
												renderItem={file => (
													<text color="accent" wrap="none" overflow="clip">
														{file}
													</text>
												)}
											/>
										}
									>
										<Show
											when={(props.details?.fileCount ?? 0) > 0}
											fallback={
												<stack>
													<row gap={1}>
														<status value="warning" />
														<text color="dim">
															{isTruncated()
																? "No matches before timeout (scan incomplete)"
																: "No files found"}
														</text>
													</row>
													<Show when={missingPaths().length > 0}>
														<text color="warning">skipped missing: {missingPaths().join(", ")}</text>
													</Show>
												</stack>
											}
										>
											<stack>
												<FileList
													files={fileEntries()}
													expanded={props.ui.expanded}
													maxCollapsed={PREVIEW_LIMITS.COLLAPSED_ITEMS}
													fileIcon="language"
													pathOverflow="clip"
												/>

												<Show when={truncationReasons().length > 0}>
													<text color="warning">truncated: {truncationReasons().join(", ")}</text>
												</Show>

												<Show when={missingPaths().length > 0}>
													<text color="warning">skipped missing: {missingPaths().join(", ")}</text>
												</Show>
											</stack>
										</Show>
									</Show>
								</ToolCard>
							}
						>
							<ToolCard
								phase={props.phase}
								outcome={props.outcome}
								framed={false}
								paddingX={1}
								tint={false}
								expanded={true}
							>
								<text color="error">
									<status value="error" /> Error: {errorText()}
								</text>
							</ToolCard>
						</Show>
					}
				>
					<ToolCard
						phase={props.phase}
						outcome={props.outcome}
						framed={false}
						paddingX={1}
						tint={false}
						expanded={true}
					>
						<row gap={1}>
							<status value="warning" />
							<text color="dim">No files found</text>
						</row>
					</ToolCard>
				</Show>
			}
		>
			<ToolCard
				phase={props.phase}
				outcome={props.outcome}
				framed={false}
				paddingX={1}
				tint={false}
				expanded={true}
				header={callHeader()}
			/>
		</Show>
	);
}

export function globActivitySummary(props: ToolViewProps<GlobRenderArgs, GlobToolDetails>): ActivitySummary {
	const paths = toPathList(
		(props.args.path as string | string[] | undefined) ?? (props.args.paths as string | string[] | undefined),
	);
	const label = paths.length > 0 ? `Glob ${paths.join(", ")}` : "Glob";
	const fileCount = props.details?.fileCount;
	const detail = fileCount !== undefined ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : undefined;
	const truncation = props.details?.truncation ?? props.details?.meta?.truncation;
	const truncated = Boolean(
		props.details?.truncated ||
		truncation ||
		props.details?.resultLimitReached ||
		props.details?.meta?.limits?.resultLimit,
	);
	const status: ToolUIStatus =
		props.phase === "receiving" || props.phase === "queued"
			? "pending"
			: props.phase === "running"
				? "running"
				: props.outcome === "failed" || Boolean(props.details?.error)
					? "error"
					: props.outcome === "cancelled" || props.outcome === "skipped"
						? "aborted"
						: truncated || fileCount === 0
							? "warning"
							: "success";
	return { label, detail, status };
}

export const globToolView: ToolViewDefinition<GlobRenderArgs, GlobToolDetails> = {
	view: GlobView,
	summary: globActivitySummary,
	framed: false,
	tint: false,
};

registerToolView("glob", globToolView);
