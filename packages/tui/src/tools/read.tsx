import type { SummaryResult } from "@oh-my-pi/pi-natives";
import { formatBytes, truncate } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { createDocument } from "../document/document";
import { getLanguageFromPath } from "../lang-from-path";
import { replaceTabs } from "../utils";
import { createEffect, createMemo, createSignal, Show, type Accessor, type JSX } from "../reactive";
import { formatMoreItems, getDomain, shortenPath } from "../render/render-utils";
import { Card } from "../view/card";
import { ToolCard } from "../view/tool-card";
import { ToolHeader } from "../view/tool-header";
import { ExpandHint } from "../view/expand-hint";
import { TruncationNotice } from "../view/truncation-notice";
import type { ToolUIStatus } from "../host/elements/status";
import { fileUriForTerminal } from "../render/hyperlink";
import { TERMINAL } from "../terminal-capabilities";
import { formatNumberedLine } from "./hashline-format";

import { LINE_RANGE_CHUNK_SOURCE, parseLineRanges } from "./line-ranges";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import type { TruncationResult } from "./streaming-output";
import { registerToolView } from "./registry";
import type { ActivitySummary, DeepReadonly, ToolViewDefinition, ToolViewProps } from "./view";

/** Read result metadata retains truncation statistics, not a second copy of the body. */
export type ReadTruncationStats = Omit<TruncationResult, "content">;

/** Display metadata for file and URL reads. */
export interface ReadToolDetails {
	kind?: "file" | "url" | string;
	meta?: OutputMeta;
	truncation?: ReadTruncationStats;
	resolvedPath?: string;
	displayTarget?: string;
	suffixResolution?: { from: string; to: string };
	conflictCount?: number;
	summary?: { lines?: number; elidedSpans: number; elidedLines: number };
	contentType?: string;
	displayContent?: {
		readonly text: string;
		readonly lineNumbers?: readonly (number | null)[];
		readonly startLine?: number;
	};
	fileSize?: number;
	totalLines?: number;
	isDirectory?: boolean;
	displayReadTargets?: string[];
	displayReadTargetLinks?: Array<string | null>;
	url?: string;
	finalUrl?: string;
	method?: string;
	truncated?: boolean;
	notes?: string[];
}

export interface ReadRenderArgs {
	path?: unknown;
	file_path?: unknown;
	offset?: number;
	limit?: number;
	raw?: boolean;
}

const RANGE_SELECTOR_CHUNK = `${LINE_RANGE_CHUNK_SOURCE}(?<=[\\d.-])`;
const RANGE_LIST_SRC = `${RANGE_SELECTOR_CHUNK}(?:,${RANGE_SELECTOR_CHUNK})*`;
const TAIL_CHUNK_SRC = String.raw`-\d+`;
const FILE_LINE_RANGE_ONLY_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|${TAIL_CHUNK_SRC})$`, "i");
const FILE_RAW_ONLY_RE = /^raw$/i;
const INTERNAL_URL_SELECTOR_PART_RE = new RegExp(
	String.raw`^(?:raw|conflicts|img|${RANGE_LIST_SRC}|-\d+(?:[-+]\d+)?)$`,
	"i",
);

const INTERNAL_SCHEMES_WITH_SELECTORS: Record<string, true> = {
	local: true,
	artifact: true,
	ssh: true,
	conflict: true,
	db: true,
	agent: true,
	history: true,
	issue: true,
	memory: true,
	omp: true,
	pr: true,
	rule: true,
	skill: true,
	vault: true,
};

const OPAQUE_RESOURCE_SCHEMES: Record<string, true> = { mcp: true };
const INTERNAL_URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/** Split a filesystem path from its trailing read selector. */
export function splitPathAndSel(rawPath: string): { path: string; sel?: string } {
	const colon = rawPath.lastIndexOf(":");
	if (colon === -1) return { path: rawPath };

	const candidate = rawPath.slice(colon + 1);
	const isRange = FILE_LINE_RANGE_ONLY_RE.test(candidate);
	const isRaw = FILE_RAW_ONLY_RE.test(candidate);
	const isSpecial = candidate.toLowerCase() === "conflicts" || candidate.toLowerCase() === "img";
	if (!isRange && !isRaw && !isSpecial) return { path: rawPath };

	let basePath = rawPath.slice(0, colon);
	let sel = candidate;

	const innerColon = basePath.lastIndexOf(":");
	if (innerColon > 0) {
		const innerCandidate = basePath.slice(innerColon + 1);
		const innerIsRaw = FILE_RAW_ONLY_RE.test(innerCandidate);
		const outerIsRaw = FILE_RAW_ONLY_RE.test(candidate);
		const innerIsRange = FILE_LINE_RANGE_ONLY_RE.test(innerCandidate);
		const outerIsRange = FILE_LINE_RANGE_ONLY_RE.test(candidate);
		if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
			sel = `${innerCandidate}:${candidate}`;
			basePath = basePath.slice(0, innerColon);
		}
	}

	return { path: basePath, sel };
}

/**
 * Variant of {@link splitPathAndSel} for internal URLs (`scheme://...`).
 */
export function splitInternalUrlSel(rawPath: string): { path: string; sel?: string } {
	const schemeMatch = rawPath.match(INTERNAL_URL_SCHEME_RE);
	if (!schemeMatch) return { path: rawPath };
	const scheme = schemeMatch[1]!.toLowerCase();
	if (OPAQUE_RESOURCE_SCHEMES[scheme]) return { path: rawPath };
	if (!INTERNAL_SCHEMES_WITH_SELECTORS[scheme]) return { path: rawPath };

	const schemeEnd = schemeMatch[0].length;
	if (scheme === "ssh" && rawPath.indexOf("/", schemeEnd) === -1) {
		return { path: rawPath };
	}
	let currentPath = rawPath;
	const chunks: string[] = [];
	while (true) {
		const colon = currentPath.lastIndexOf(":");
		if (colon < schemeEnd) break;
		const tail = currentPath.slice(colon + 1);
		if (!INTERNAL_URL_SELECTOR_PART_RE.test(tail)) break;
		chunks.unshift(tail);
		currentPath = currentPath.slice(0, colon);
	}
	if (chunks.length === 0) return { path: rawPath };
	return { path: currentPath, sel: chunks.join(":") };
}

/** Recognize HTTP URLs and www-prefixed external read targets. */
export function isReadableUrlPath(value: string): boolean {
	return /^https?:\/\/?/i.test(value) || /^www\./i.test(value);
}

/** Return the first selected line when every range has valid one-based bounds. */
export function readSelectorRangeStart(selector: string): number | undefined {
	try {
		const start = parseLineRanges(selector)?.[0]?.startLine;
		return start !== undefined && Number.isFinite(start) ? start : undefined;
	} catch {
		return undefined;
	}
}

const INTERNAL_URL_LIKE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function splitReadRenderPath(rawPath: string): { path: string; sel?: string } {
	if (INTERNAL_URL_LIKE_RE.test(rawPath)) {
		const internal = splitInternalUrlSel(rawPath);
		if (internal.sel) return internal;
	}
	return splitPathAndSel(rawPath);
}

function firstReadSelectorLine(sel: string | undefined): number | undefined {
	if (!sel) return undefined;
	const range = sel.split(":").find(chunk => chunk.toLowerCase() !== "raw");
	return range ? readSelectorRangeStart(range) : undefined;
}

/** Absolute fs path the read result actually resolved to, used as the OSC 8 link target. */
export function readSourceFsPath(details: DeepReadonly<ReadToolDetails> | undefined): string | undefined {
	const source = details?.meta?.source;
	return source?.type === "path" && typeof source.value === "string" ? source.value : undefined;
}

interface ReadPathDisplay {
	label: string;
	suffix: string;
	target?: string;
	line?: number;
}

function readPathDisplay(
	rawPath: string,
	options: {
		resolvedPath?: string;
		sourcePath?: string;
		suffixResolution?: { from: string; to: string };
		offset?: number;
		fallbackLabel?: string;
	},
): ReadPathDisplay {
	const split = splitReadRenderPath(rawPath);
	const basePath = split.path || rawPath;
	const selectorSuffix = split.sel ? `:${split.sel}` : "";
	const plainDisplayPath = options.suffixResolution
		? shortenPath(options.suffixResolution.to)
		: shortenPath(basePath || options.resolvedPath || options.fallbackLabel || rawPath);
	const absoluteInputPath = path.isAbsolute(basePath) ? basePath : undefined;
	return {
		label: plainDisplayPath,
		suffix: selectorSuffix,
		target: options.resolvedPath ?? options.sourcePath ?? absoluteInputPath,
		line: firstReadSelectorLine(split.sel) ?? options.offset,
	};
}

function readRange(args: ReadRenderArgs | undefined): string | undefined {
	if (args?.offset === undefined && args?.limit === undefined) return undefined;
	const start = args.offset ?? 1;
	const end = args.limit !== undefined ? start + args.limit - 1 : undefined;
	return `:${start}${end !== undefined ? `-${end}` : ""}`;
}

function sanitizeText(text: string): string {
	return replaceTabs(text.replace(/\r/g, ""));
}

function repairCollapsedUrlScheme(value: string): string {
	const match = value.match(/^(https?):\/(?!\/)/i);
	return match ? `${match[1]}://${value.slice(match[0].length)}` : value;
}

function isUrlSelectorToken(token: string): boolean {
	if (token.toLowerCase() === "raw") return true;
	if (/^-\d+$/.test(token)) return Number.parseInt(token.slice(1), 10) > 0;
	return readSelectorRangeStart(token) !== undefined;
}

/** Remove read selectors from a URL only when the remaining value is still a valid URL. */
function readUrlLinkTarget(input: string): string {
	const repaired = repairCollapsedUrlScheme(input);
	let path = repaired;
	const selectors: string[] = [];
	while (true) {
		const colon = path.lastIndexOf(":");
		if (colon <= 0) break;
		const candidate = path.slice(colon + 1);
		const remainder = path.slice(0, colon);
		if (!isReadableUrlPath(remainder) || !isUrlSelectorToken(candidate)) break;
		try {
			new URL(
				remainder.startsWith("http://") || remainder.startsWith("https://") ? remainder : `https://${remainder}`,
			);
		} catch {
			break;
		}
		selectors.unshift(candidate);
		path = remainder;
	}
	if (selectors.filter(selector => selector.toLowerCase() !== "raw").length > 1) return repaired;
	return path;
}

function formatReadUrlDescription(input: string): { target: string; label: string } {
	const linked = readUrlLinkTarget(input);
	const target = linked.match(/^www\./i) ? `https://${linked}` : linked;
	const domain = getDomain(target);
	const urlPath = truncate(target.replace(/^https?:\/\/[^/]+/, ""), 50, "…");
	const label = `${domain}${urlPath ? ` ${urlPath}` : ""}`.trim();
	return { target, label };
}

function ReadWarnings(props: { readonly details?: DeepReadonly<ReadToolDetails> }): JSX.Element {
	const truncation = () => props.details?.meta?.truncation;
	const fallback = () => props.details?.truncation;
	const firstLineWarning = () => {
		if (truncation() && fallback()?.firstLineExceedsLimit) {
			let message = `First line exceeds ${formatBytes(fallback()!.outputBytes ?? fallback()!.totalBytes)} limit`;
			const artifactId = truncation()?.artifactId;
			if (artifactId) message += `. ${formatFullOutputReference(artifactId)}`;
			return message;
		}
		return undefined;
	};

	return (
		<stack>
			<Show when={props.details?.resolvedPath}>
				<text color="dim">[Resolved path: {props.details!.resolvedPath}]</text>
			</Show>
			<Show
				when={firstLineWarning()}
				fallback={
					<TruncationNotice
						truncation={truncation()}
						source={props.details?.meta?.source}
						artifactError={props.details?.meta?.artifactError}
					/>
				}
			>
				<TruncationNotice text={firstLineWarning()} />
			</Show>
		</stack>
	);
}

function ReadFileHeader(props: {
	readonly status: Accessor<ToolUIStatus>;
	readonly callHeader: boolean;
	readonly display: Accessor<ReadPathDisplay>;
	readonly href: Accessor<string | undefined>;
	readonly correction: Accessor<string | undefined>;
	readonly range: Accessor<string | undefined>;
	readonly summary: Accessor<string | undefined>;
	readonly conflicts: Accessor<number>;
}): JSX.Element {
	return (
		<ToolHeader
			status={props.status()}
			label={
				<>
					<span color={props.callHeader || props.status() === "error" ? "accent" : "toolTitle"}>Read</span>
					<Show when={props.display().label || (props.callHeader ? "…" : "")}>
						{(label: Accessor<string>) => (
							<>
								<span color={props.status() === "error" ? "accent" : undefined}>
									{props.callHeader ? ": " : " "}
								</span>
								<Show
									when={props.href()}
									fallback={
										<span
											color={
												props.callHeader ? "muted" : props.status() === "error" ? "accent" : "toolTitle"
											}
										>
											{label()}
										</span>
									}
								>
									{(href: Accessor<string>) => (
										<link href={href()}>
											<span
												color={
													props.callHeader ? "muted" : props.status() === "error" ? "accent" : "toolTitle"
												}
											>
												{label()}
											</span>
										</link>
									)}
								</Show>
							</>
						)}
					</Show>
					<Show when={props.display().suffix}>
						<span color={props.callHeader ? "muted" : props.status() === "error" ? "accent" : "toolTitle"}>
							{props.display().suffix}
						</span>
					</Show>
					<Show when={props.correction()}>
						<span color="dim"> (corrected from {props.correction()})</span>
					</Show>
					<Show when={props.range()}>
						<span color={props.callHeader ? "muted" : undefined}>{props.range()}</span>
					</Show>
					<Show when={props.summary()}>
						<span> ({props.summary()})</span>
					</Show>
					<Show when={props.conflicts() > 0}>
						<span color="warning">
							{" "}
							(⚠ {props.conflicts()} conflict{props.conflicts() === 1 ? "" : "s"})
						</span>
					</Show>
				</>
			}
		/>
	);
}

function ReadView(props: ToolViewProps<ReadRenderArgs, ReadToolDetails>): JSX.Element {
	const rawPath = createMemo(() => {
		const value = props.args?.file_path ?? props.args?.path;
		return typeof value === "string" ? value : "";
	});
	const outputText = createMemo(() => {
		props.output.version();
		return sanitizeText(props.output.text());
	});
	const isUrl = createMemo(() => props.details?.kind === "url" || isReadableUrlPath(rawPath()));
	const isImage = createMemo(
		() => props.images.length > 0 || props.details?.contentType?.startsWith("image/") === true,
	);
	const status = createMemo<ToolUIStatus>(() => {
		if (props.phase === "running") return "pending";
		if (props.phase !== "settled") return "pending";
		if (props.outcome === "failed") return "error";
		if (props.outcome === "cancelled" || props.outcome === "skipped") return "aborted";
		if (props.outcome === "timed_out" || props.details?.suffixResolution || (props.details?.conflictCount ?? 0) > 0) {
			return "warning";
		}
		return "done";
	});
	const pathDisplay = createMemo(() =>
		readPathDisplay(rawPath(), {
			resolvedPath: props.details?.resolvedPath,
			sourcePath: props.details?.displayTarget ?? readSourceFsPath(props.details),
			suffixResolution: props.details?.suffixResolution,
			offset: props.args?.offset,
			fallbackLabel: isImage() ? "image" : undefined,
		}),
	);
	const pathHref = createMemo(() => {
		const display = pathDisplay();
		if (!display.target) return undefined;
		return fileUriForTerminal(
			display.target,
			display.line === undefined ? undefined : { line: display.line },
			TERMINAL.id,
		);
	});
	const renderPath = createMemo(() => splitReadRenderPath(rawPath()));
	const correction = createMemo(() =>
		props.details?.suffixResolution ? shortenPath(props.details.suffixResolution.from) : undefined,
	);
	const range = createMemo(() => readRange(props.args));
	const summaryText = createMemo(() =>
		props.details?.summary
			? `summary: ${props.details.summary.elidedSpans} elided span${props.details.summary.elidedSpans === 1 ? "" : "s"}`
			: undefined,
	);
	const conflicts = createMemo(() => props.details?.conflictCount ?? 0);
	const rawRequested = createMemo(
		() =>
			props.args?.raw === true ||
			renderPath()
				.sel?.split(":")
				.some(chunk => chunk.toLowerCase() === "raw") === true,
	);
	const isMarkdown = createMemo(() => props.details?.contentType === "text/markdown" && !rawRequested());
	const language = createMemo(() => getLanguageFromPath(renderPath().path));
	const contentText = createMemo(() => sanitizeText(props.details?.displayContent?.text ?? outputText()));
	const contentDocument = createDocument("");
	createEffect(() => {
		contentDocument.apply({ kind: "reset", text: contentText() });
	});
	const codeLineNumbers = createMemo(() => props.details?.displayContent?.lineNumbers);
	const codeLineStart = createMemo(() => props.details?.displayContent?.startLine);
	const contentLineCount = createMemo(() => contentText().split("\n").length);
	const collapsedContentLimit = createMemo(() => {
		const allocation = props.ui.allocation;
		if (allocation > 0 && allocation < 12) return Math.max(1, Math.trunc(allocation));
		return 12;
	});
	const hiddenCodeLines = createMemo(() =>
		props.ui.expanded ? 0 : Math.max(0, contentLineCount() - collapsedContentLimit()),
	);
	const [markdownRows, setMarkdownRows] = createSignal(0);
	const hiddenMarkdownRows = createMemo(() =>
		props.ui.expanded ? 0 : Math.max(0, markdownRows() - collapsedContentLimit()),
	);
	const hasWarnings = createMemo(
		() =>
			props.details?.resolvedPath !== undefined ||
			props.details?.meta?.truncation !== undefined ||
			props.details?.meta?.artifactError !== undefined,
	);
	const hasContent = createMemo(
		() => isImage() || props.details?.displayContent?.text !== undefined || outputText().length > 0,
	);
	const errorText = createMemo(() => (outputText() || "Unknown error").replace(/^Error:\s*/, ""));

	const urlInfo = createMemo(() => {
		const target = props.details?.finalUrl ?? props.details?.url ?? rawPath();
		return formatReadUrlDescription(target);
	});
	const urlContent = createMemo(() => {
		const text = outputText();
		return text.includes("---\n\n") ? text.split("---\n\n").slice(1).join("---\n\n") : text;
	});
	const urlLines = createMemo(() =>
		urlContent()
			.split("\n")
			.filter(line => line.trim().length > 0)
			.map(line => line.trimEnd()),
	);
	const urlPreviewLimit = createMemo(() => (props.ui.expanded ? 12 : Math.min(3, collapsedContentLimit())));
	const hiddenUrlLines = createMemo(() => Math.max(0, urlLines().length - urlPreviewLimit()));
	const visibleUrlLines = createMemo(() => {
		const lines = urlLines();
		return lines.length > 0 ? lines.slice(0, urlPreviewLimit()) : ["(no content)"];
	});
	const urlTruncated = createMemo(() => Boolean(props.details?.truncated || props.details?.meta?.truncation));
	const hasRedirect = createMemo(() => {
		const original = props.details?.url;
		const final = props.details?.finalUrl;
		return original !== undefined && final !== undefined && original !== final;
	});
	const urlError = createMemo(() => props.outcome === "failed" || !props.details);
	const shouldFrame = createMemo(
		() => props.phase === "settled" || (!isUrl() && props.phase === "running" && (hasContent() || hasWarnings())),
	);
	const FileBody = (): JSX.Element => {
		return (
			<Show when={props.phase === "running" || props.phase === "settled"}>
				<Show when={props.outcome === "failed"}>
					<text color="error">{errorText()}</text>
				</Show>
				<Show when={props.outcome !== "failed" && (hasContent() || hasWarnings())}>
					<Show
						when={isImage()}
						fallback={
							<Show
								when={isMarkdown()}
								fallback={
									<>
										<code
											document={contentDocument}
											language={language()}
											lineNumbers={codeLineNumbers() ?? codeLineStart() !== undefined}
											lineNumberStart={codeLineStart()}
											endLine={props.ui.expanded ? undefined : collapsedContentLimit()}
										/>
										<Show when={hiddenCodeLines() > 0}>
											<row gap={1}>
												<text color="dim">{formatMoreItems(hiddenCodeLines(), "line")}</text>
												<ExpandHint />
											</row>
										</Show>
										<Show when={hasWarnings()}>
											<hr variant="frame" label="Output" />
											<ReadWarnings details={props.details} />
										</Show>
									</>
								}
							>
								<>
									<Show
										when={props.ui.expanded}
										fallback={
											<scroll
												height={collapsedContentLimit()}
												scrollbar="never"
												shrinkToFit
												onViewport={viewport => setMarkdownRows(viewport.totalRows)}
											>
												<markdown document={contentDocument} />
											</scroll>
										}
									>
										<markdown document={contentDocument} />
									</Show>
									<Show when={hiddenMarkdownRows() > 0}>
										<row gap={1}>
											<text color="dim">{formatMoreItems(hiddenMarkdownRows(), "line")}</text>
											<ExpandHint />
										</row>
									</Show>
									<Show when={hasWarnings()}>
										<hr variant="frame" label="Output" />
										<ReadWarnings details={props.details} />
									</Show>
								</>
							</Show>
						}
					>
						<>
							<hr variant="frame" label="Details" />
							<Show when={contentText().length > 0} fallback={<text color="dim">(image)</text>}>
								<text color="toolOutput">{contentText()}</text>
							</Show>
							<Show when={hasWarnings()}>
								<ReadWarnings details={props.details} />
							</Show>
						</>
					</Show>
				</Show>
			</Show>
		);
	};

	return (
		<Show
			when={shouldFrame()}
			fallback={
				<Show
					when={isUrl()}
					fallback={
						<ReadFileHeader
							status={status}
							callHeader={true}
							display={pathDisplay}
							href={pathHref}
							correction={correction}
							range={range}
							summary={summaryText}
							conflicts={conflicts}
						/>
					}
				>
					<ToolHeader
						status={status()}
						label={
							<>
								<span color="accent">Read</span>
								<Show when={urlInfo().label}>
									<span color="muted">: </span>
									<link href={urlInfo().target}>
										<span color="muted">{urlInfo().label}</span>
									</link>
								</Show>
							</>
						}
					/>
				</Show>
			}
		>
			<Show
				when={isUrl()}
				fallback={
					<ToolCard
						phase={props.phase}
						outcome={props.outcome}
						framed={true}
						header={
							<ReadFileHeader
								status={status}
								callHeader={false}
								display={pathDisplay}
								href={pathHref}
								correction={correction}
								range={range}
								summary={summaryText}
								conflicts={conflicts}
							/>
						}
						expanded={props.ui.expanded}
						summary={<FileBody />}
					>
						<FileBody />
					</ToolCard>
				}
			>
				<Card
					title={
						<ToolHeader
							status={status()}
							label={
								<>
									<span color="accent">Read</span>
									<Show when={urlInfo().label}>
										<span color="muted">: </span>
										<link href={urlInfo().target}>
											<span color="muted">{urlInfo().label}</span>
										</link>
									</Show>
								</>
							}
						/>
					}
					borderColor={urlError() ? undefined : urlTruncated() ? "warning" : "dim"}
					backgroundBorder={urlError()}
					recipe={urlError() ? "tool.card.error" : undefined}
				>
					<Show when={props.phase === "settled" && (props.outcome === "failed" || !props.details)}>
						<text color="error">{props.outcome === "failed" ? errorText() : "No response data"}</text>
					</Show>
					<Show when={props.phase === "settled" && props.outcome !== "failed" && props.details}>
						<>
							<hr variant="frame" label="Metadata" />
							<stack>
								<text>
									<span color="muted">Content-Type:</span> {props.details!.contentType || "unknown"}
								</text>
								<text>
									<span color="muted">Method:</span> {props.details!.method ?? ""}
								</text>
								<Show when={hasRedirect()}>
									<text>
										<span color="muted">Final URL:</span>{" "}
										<link href={props.details!.finalUrl!}>
											<span color="mdLinkUrl">{props.details!.finalUrl}</span>
										</link>
									</text>
								</Show>
								<text>
									<span color="muted">Lines:</span> {urlLines().length} line
									{urlLines().length === 1 ? "" : "s"}
								</text>
								<text>
									<span color="muted">Chars:</span> {urlContent().trim().length}
								</text>
								<Show when={urlTruncated()}>
									<text color="warning">
										<status value="warning" /> Output truncated
									</text>
								</Show>
								<Show when={props.details!.meta?.truncation?.artifactId}>
									<text color="warning">
										{formatFullOutputReference(props.details!.meta!.truncation!.artifactId!)}
									</text>
								</Show>
								<Show when={(props.details!.notes ?? []).length > 0}>
									<text>
										<span color="muted">Notes:</span> {(props.details!.notes ?? []).join("; ")}
									</text>
								</Show>
							</stack>
							<hr variant="frame" label="Content Preview" />
							<preview
								items={visibleUrlLines()}
								edge="head"
								limit={urlPreviewLimit()}
								unit="items"
								color="dim"
							/>
							<Show when={hiddenUrlLines() > 0}>
								<row gap={1}>
									<text color="dim">{formatMoreItems(hiddenUrlLines(), "line")}</text>
									<ExpandHint expanded={props.ui.expanded} />
								</row>
							</Show>
						</>
					</Show>
				</Card>
			</Show>
		</Show>
	);
}

function readSummary(props: ToolViewProps<ReadRenderArgs, ReadToolDetails>): ActivitySummary {
	const p = props.args?.file_path ?? props.args?.path;
	const rawPath = typeof p === "string" ? p : "";
	const status: ToolUIStatus =
		props.phase !== "settled"
			? props.phase === "running"
				? "running"
				: "pending"
			: props.outcome === "failed"
				? "error"
				: props.outcome === "cancelled" || props.outcome === "skipped"
					? "aborted"
					: props.outcome === "timed_out" ||
						  (props.details?.conflictCount ?? 0) > 0 ||
						  props.details?.suffixResolution
						? "warning"
						: "success";
	return {
		label: "Read",
		detail: rawPath ? shortenPath(rawPath) : undefined,
		status,
	};
}

export const readToolView: ToolViewDefinition<ReadRenderArgs, ReadToolDetails> = {
	view: ReadView,
	summary: readSummary,
	framed: true,
};

registerToolView("read", readToolView);

/** Inclusive line range describing one elided span in a structural summary. */
export interface ElidedRange {
	start: number;
	end: number;
}

const BRACE_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const BRACE_TAIL_TRAILING_RE = /^[;,)\]}]*$/;

/**
 * Decide whether the kept lines surrounding an elided range collapse to a
 * single brace-pair line in the rendered summary. Returns true when the head
 * line ends with `{` / `(` / `[` and the tail line is the matching closer
 * (optionally followed by terminating punctuation like `;`, `,`, or further
 * closers — e.g. `};`, `})`, `]);`).
 */
export function canMergeBracePair(headLine: string, tailLine: string): boolean {
	const head = headLine.trimEnd();
	const tail = tailLine.trim();
	const opener = head.slice(-1);
	const closer = BRACE_PAIRS[opener];
	if (!closer) return false;
	if (!tail.startsWith(closer)) return false;
	return BRACE_TAIL_TRAILING_RE.test(tail.slice(closer.length));
}

/** Format one summary line with the selected line-prefix mode. */
export function formatSingleLine(
	line: number,
	text: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatNumberedLine(line, text);
	if (shouldAddLineNumbers) return `${line}|${text}`;
	return text;
}

/** Format the boundary lines around an elided brace-pair body. */
export function formatMergedBraceLine(
	startLine: number,
	endLine: number,
	headText: string,
	tailText: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): { model: string; display: string } {
	const merged = `${headText.trimEnd()} … ${tailText.trim()}`;
	if (shouldAddHashLines) {
		return { model: `${startLine}-${endLine}:${merged}`, display: merged };
	}
	if (shouldAddLineNumbers) {
		return { model: `${startLine}-${endLine}|${merged}`, display: merged };
	}
	return { model: merged, display: merged };
}

/** Format a structural summary using the supplied file-display preferences. */
export function formatReadSummary(
	displayMode: { hashLines: boolean; lineNumbers: boolean },
	summary: SummaryResult,
): {
	text: string;
	displayText: string;
	elidedRanges: ElidedRange[];
	elidedLines: number;
} {
	const shouldAddHashLines = displayMode.hashLines;
	const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

	type Unit =
		| { kind: "line"; line: number; text: string }
		| { kind: "elided"; startLine: number; endLine: number }
		| {
				kind: "merged";
				startLine: number;
				endLine: number;
				headText: string;
				tailText: string;
		  };

	const raw: Unit[] = [];
	for (const segment of summary.segments) {
		if (segment.kind === "elided") {
			raw.push({ kind: "elided", startLine: segment.startLine, endLine: segment.endLine });
			continue;
		}
		const text = segment.text ?? "";
		if (text.length === 0) continue;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			raw.push({ kind: "line", line: segment.startLine + i, text: lines[i]! });
		}
	}

	const units: Unit[] = [];
	let i = 0;
	while (i < raw.length) {
		const cur = raw[i]!;
		if (cur.kind === "elided") {
			const prev = units.length > 0 ? units[units.length - 1] : null;
			const next = i + 1 < raw.length ? raw[i + 1] : null;
			if (prev?.kind === "line" && next?.kind === "line" && canMergeBracePair(prev.text, next.text)) {
				units.pop();
				units.push({
					kind: "merged",
					startLine: prev.line,
					endLine: next.line,
					headText: prev.text,
					tailText: next.text,
				});
				i += 2;
				continue;
			}
		}
		units.push(cur);
		i++;
	}

	const modelParts: string[] = [];
	const displayParts: string[] = [];
	const elidedRanges: ElidedRange[] = [];
	let elidedLines = 0;
	for (const unit of units) {
		if (unit.kind === "elided") {
			modelParts.push("…");
			displayParts.push("…");
			elidedRanges.push({ start: unit.startLine, end: unit.endLine });
			elidedLines += unit.endLine - unit.startLine + 1;
			continue;
		}
		if (unit.kind === "merged") {
			const formatted = formatMergedBraceLine(
				unit.startLine,
				unit.endLine,
				unit.headText,
				unit.tailText,
				shouldAddHashLines,
				shouldAddLineNumbers,
			);
			modelParts.push(formatted.model);
			displayParts.push(formatted.display);
			elidedRanges.push({ start: unit.startLine, end: unit.endLine });
			elidedLines += Math.max(0, unit.endLine - unit.startLine - 1);
			continue;
		}
		modelParts.push(formatSingleLine(unit.line, unit.text, shouldAddHashLines, shouldAddLineNumbers));
		displayParts.push(unit.text);
	}

	return { text: modelParts.join("\n"), displayText: displayParts.join("\n"), elidedRanges, elidedLines };
}
