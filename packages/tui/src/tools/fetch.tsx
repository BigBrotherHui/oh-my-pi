import { isReadableUrlPath, readSelectorRangeStart } from "./read";
import { truncate } from "@oh-my-pi/pi-utils";
import { createMemo, For, Show, type JSX } from "../reactive";
import { getDomain, sanitizeDisplayLines } from "../render/render-utils";
import { ExpandHint } from "../view/expand-hint";
import { ToolCard } from "../view/tool-card";
import { ToolHeader } from "../view/tool-header";
import { UrlLink } from "../view/url-result";
import type { ToolUIStatus } from "../host/elements/status";

import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import { registerToolView } from "./registry";
import type { ActivitySummary, ToolViewDefinition, ToolViewProps } from "./view";

/** Display metadata for fetch tool results. */
export interface ReadUrlToolDetails {
	kind: "url";
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	truncated: boolean;
	notes: string[];
	meta?: OutputMeta;
}

export interface FetchArgs {
	path?: string;
	url?: string;
	raw?: boolean;
}

/** Restore the double slash in a collapsed HTTP URL scheme. */
export function repairCollapsedScheme(value: string): string {
	const match = value.match(/^(https?):\/(?!\/)/i);
	return match ? `${match[1]}://${value.slice(match[0].length)}` : value;
}

function isUrlSelectorToken(token: string): boolean {
	if (token.toLowerCase() === "raw") return true;
	if (/^-\d+$/.test(token)) return Number.parseInt(token.slice(1), 10) > 0;
	return readSelectorRangeStart(token) !== undefined;
}

/** Peel valid `:selector` suffixes from a URL. */
export function tryExtractEmbeddedUrlSelector(readPath: string): { path: string; sels: string[] } | null {
	let basePath = readPath;
	const sels: string[] = [];
	while (true) {
		const lastColonIndex = basePath.lastIndexOf(":");
		if (lastColonIndex <= 0) break;
		const candidate = basePath.slice(lastColonIndex + 1);
		const remainder = basePath.slice(0, lastColonIndex);
		if (!isReadableUrlPath(remainder) || !isUrlSelectorToken(candidate)) break;
		try {
			new URL(
				remainder.startsWith("http://") || remainder.startsWith("https://") ? remainder : `https://${remainder}`,
			);
		} catch {
			break;
		}
		sels.unshift(candidate);
		basePath = remainder;
	}
	return sels.length === 0 ? null : { path: basePath, sels };
}

export function readUrlLinkTarget(input: string): string {
	try {
		const repaired = repairCollapsedScheme(input);
		const embedded = tryExtractEmbeddedUrlSelector(repaired);
		if (embedded && embedded.sels.filter(token => token.toLowerCase() !== "raw").length > 1) return input;
		return embedded?.path ?? repaired;
	} catch {
		return input;
	}
}

export function formatReadUrlDescription(input: string): string {
	const target = readUrlLinkTarget(input);
	const displayUrl = target.match(/^www\./i) ? `https://${target}` : target;
	const domain = getDomain(displayUrl);
	const urlPath = truncate(displayUrl.replace(/^https?:\/\/[^/]+/, ""), 50, "…");
	return `${domain}${urlPath ? ` ${urlPath}` : ""}`.trim();
}

function countNonEmptyLines(text: string): number {
	return text.split("\n").filter(line => line.trim().length > 0).length;
}

export function FetchView(props: ToolViewProps<FetchArgs, ReadUrlToolDetails>): JSX.Element {
	const isAborted = createMemo(
		() => props.phase === "settled" && (props.outcome === "cancelled" || props.outcome === "skipped"),
	);
	const isResultVisible = createMemo(() => props.details !== undefined || (props.phase === "settled" && !isAborted()));
	const isError = createMemo(
		() =>
			props.phase === "settled" &&
			!isAborted() &&
			(props.outcome === "failed" || props.outcome === "timed_out" || props.details === undefined),
	);
	const targetInput = createMemo(() => {
		if (props.details) return props.details.finalUrl ?? props.details.url ?? "";
		return isResultVisible() ? "" : (props.args.path ?? props.args.url ?? "");
	});
	const linkTarget = createMemo(() => {
		const target = readUrlLinkTarget(targetInput());
		const normalized = target.match(/^www\./i) ? `https://${target}` : target;
		try {
			const parsed = new URL(normalized);
			return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
		} catch {
			return undefined;
		}
	});
	const displayLabel = createMemo(() => formatReadUrlDescription(targetInput()));

	const isTruncated = createMemo(() => {
		const details = props.details;
		return Boolean(details?.truncated || details?.meta?.truncation);
	});

	const status = createMemo<ToolUIStatus>(() => {
		if (props.phase === "receiving" || props.phase === "queued") return "pending";
		if (props.phase === "running") return "pending";
		if (isAborted()) return "aborted";
		if (isError()) return "error";
		if (isTruncated()) return "warning";
		return "done";
	});

	const header = () => (
		<ToolHeader
			status={status()}
			label={
				<>
					<span color="accent">Read</span>
					<Show when={displayLabel()}>
						<span color="muted">: </span>
						<UrlLink href={linkTarget}>
							<span color="muted">{displayLabel()}</span>
						</UrlLink>
					</Show>
				</>
			}
			meta={props.phase !== "settled" && props.args.raw === true ? <span color="dim">raw</span> : undefined}
		/>
	);

	const details = createMemo(() => props.details);
	const finalUrlHref = createMemo(() => {
		const finalUrl = details()?.finalUrl;
		if (!finalUrl) return undefined;
		const normalized = finalUrl.match(/^www\./i) ? `https://${finalUrl}` : finalUrl;
		try {
			const parsed = new URL(normalized);
			return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
		} catch {
			return undefined;
		}
	});
	const hasRedirect = createMemo(() => Boolean(details() && details()!.url !== details()!.finalUrl));

	const contentText = createMemo(() => {
		props.output.version();
		const raw = props.output.text();
		if (!raw) return "";
		return raw.includes("---\n\n") ? raw.split("---\n\n").slice(1).join("---\n\n") : raw;
	});
	const contentLines = createMemo(() =>
		contentText()
			.split("\n")
			.filter(line => line.trim().length > 0),
	);
	const lineCount = createMemo(() => countNonEmptyLines(contentText()));

	const contentPreview = createMemo(() => {
		const lines = contentLines();
		const limit = props.ui.expanded ? 12 : 3;
		const preview = lines
			.slice(0, limit)
			.flatMap(line => sanitizeDisplayLines(line))
			.map(line => line.trimEnd());
		return {
			lines: preview.length > 0 ? preview : ["(no content)"],
			remaining: Math.max(0, lines.length - Math.min(lines.length, limit)),
		};
	});

	const errorLines = createMemo(() => {
		props.output.version();
		const errorText = (props.output.text() || "No response data").replace(/^Error:\s*/, "");
		return sanitizeDisplayLines(errorText);
	});

	return (
		<Show when={isResultVisible()} fallback={header()}>
			<ToolCard phase={props.phase} outcome={props.outcome} framed={true} expanded={true} header={header()}>
				<Show when={isError()}>
					<For each={errorLines()}>{line => <text color="error">{line}</text>}</For>
				</Show>

				<Show when={!isError() && details()}>
					<stack>
						<hr variant="frame" label="Metadata" />
						<stack>
							<text>
								<span color="muted">Content-Type:</span> {details()!.contentType || "unknown"}
							</text>
							<text>
								<span color="muted">Method:</span> {details()!.method}
							</text>
							<Show when={hasRedirect()}>
								<text>
									<span color="muted">Final URL:</span>{" "}
									<UrlLink href={finalUrlHref}>
										<span color="mdLinkUrl">{details()!.finalUrl}</span>
									</UrlLink>
								</text>
							</Show>
							<text>
								<span color="muted">Lines:</span> {lineCount()} line{lineCount() === 1 ? "" : "s"}
							</text>
							<text>
								<span color="muted">Chars:</span> {contentText().trim().length}
							</text>
							<Show when={isTruncated()}>
								<row gap={1}>
									<status value="warning" />
									<text color="warning">Output truncated</text>
								</row>
							</Show>
							<Show when={details()!.meta?.truncation?.artifactId}>
								<text color="warning">
									{formatFullOutputReference(details()!.meta!.truncation!.artifactId!)}
								</text>
							</Show>
							<Show when={details()!.notes.length > 0}>
								<text>
									<span color="muted">Notes:</span> {details()!.notes.join("; ")}
								</text>
							</Show>
						</stack>

						<hr variant="frame" label="Content Preview" />
						<For each={contentPreview().lines}>{line => <text color="dim">{line}</text>}</For>
						<Show when={contentPreview().remaining > 0}>
							<text color="muted">
								… {contentPreview().remaining} more lines <ExpandHint expanded={props.ui.expanded} hasMore />
							</text>
						</Show>
					</stack>
				</Show>
			</ToolCard>
		</Show>
	);
}

export function fetchActivitySummary(props: ToolViewProps<FetchArgs, ReadUrlToolDetails>): ActivitySummary {
	const url = props.details?.finalUrl ?? props.details?.url ?? props.args.path ?? props.args.url ?? "";
	const status: ToolUIStatus =
		props.phase === "receiving" || props.phase === "queued"
			? "pending"
			: props.phase === "running"
				? "running"
				: props.outcome === "cancelled" || props.outcome === "skipped"
					? "aborted"
					: props.outcome === "failed" || props.outcome === "timed_out" || props.details === undefined
						? "error"
						: props.details?.truncated || props.details?.meta?.truncation
							? "warning"
							: "success";
	return {
		label: "Read",
		detail: url ? formatReadUrlDescription(url) : undefined,
		status,
	};
}

export const fetchToolView: ToolViewDefinition<FetchArgs, ReadUrlToolDetails> = {
	view: FetchView,
	summary: fetchActivitySummary,
	framed: true,
};

registerToolView("fetch", fetchToolView);
