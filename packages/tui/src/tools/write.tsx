import { documentFromSnapshots } from "../document/snapshots";
import { getLanguageFromPath } from "../lang-from-path";
import { createEffect, createMemo, Show, type Accessor, type JSX } from "../reactive";
import { sanitizeDiagnosticDisplayText, shortenPath } from "../render/render-utils";
import { useTheme } from "../theme/reactive";
import type { ToolUIStatus } from "../host/elements/status";
import { ExpandHint } from "../view/expand-hint";
import { DiagnosticTree } from "../view/diagnostic-tree";
import { ToolCard } from "../view/tool-card";
import { ToolHeader } from "../view/tool-header";

import type { FileDiagnosticsResult } from "./lsp";
import type { OutputMeta } from "./output-meta";
import { registerToolView } from "./registry";
import type { ActivitySummary, ToolViewDefinition, ToolViewProps } from "./view";
import { couldBecomeXdUrl } from "./xd-url";
import type { XdevMountedRenderer, XdevRenderDispatch } from "./xdev";

/** Render context retained for callers that resolve mounted `xd://` tool views. */
export interface WriteRenderContext {
	resolveXdevMounted?: (name: string) => XdevMountedRenderer | undefined;
}

/** Details returned by the write tool for transcript rendering. */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
	meta?: OutputMeta;
	/** Set when the file was auto-chmod'd because content begins with a `#!` shebang. */
	madeExecutable?: boolean;
	/** Absolute filesystem path the write resolved to. */
	resolvedPath?: string;
	/** Set when the write dispatched an `xd://` tool device. */
	xdev?: XdevRenderDispatch;
}

export interface WriteRenderArgs {
	path?: unknown;
	file_path?: unknown;
	content?: unknown;
}

/** Settled writes show a compact six-line source preview. */
export const WRITE_PREVIEW_LINES = 6;
/** Live writes retain the historical twelve-line tail before their streaming status row. */
export const WRITE_STREAMING_PREVIEW_ROWS = 12;
const WRITE_GUTTER_MIN_WIDTH = 3;

function sanitizeText(text: string): string {
	return text.replace(/\r/g, "").replace(/\t/g, "    ");
}

function writePath(args: { readonly path?: unknown; readonly file_path?: unknown }): string {
	if (typeof args.file_path === "string") return args.file_path;
	return typeof args.path === "string" ? args.path : "";
}

function plural(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

interface WriteHeaderProps {
	readonly status?: ToolUIStatus;
	readonly path: string;
	readonly target?: string;
	readonly languageIcon: string;
	readonly lines: number;
	readonly madeExecutable: boolean;
}

/** Historical inline write header: the successful write glyph replaces a generic checkmark. */
function WriteHeader(props: WriteHeaderProps): JSX.Element {
	return (
		<ToolHeader
			status={props.status}
			statusColor={props.status === "success" ? "accent" : undefined}
			successIcon="tool.write"
			labelOverflow="middle"
			label={
				<>
					<span color="accent">Write</span>
					<span>: </span>
					<span color="muted">{props.languageIcon}</span>{" "}
					<Show when={props.path.length > 0} fallback={<span color="toolOutput">…</span>}>
						<Show when={props.target} fallback={<span color="accent">{shortenPath(props.path)}</span>}>
							<path color="accent" value={shortenPath(props.path)} target={props.target} overflow="middle" />
						</Show>
					</Show>
					<Show when={props.lines > 0}>
						<span color="dim"> · {plural(props.lines, "line")}</span>
					</Show>
					<Show when={props.madeExecutable}>
						<span color="dim"> · </span>
						<span color="success">made executable!</span>
					</Show>
				</>
			}
		/>
	);
}

function WriteDiagnostics(props: {
	readonly diagnostics: FileDiagnosticsResult;
	readonly expanded: boolean;
}): JSX.Element {
	return (
		<stack gap={1}>
			<row gap={1}>
				<status value={props.diagnostics.errored ? "error" : "warning"} />
				<text color="accent">Diagnostics</text>
				<Show when={props.diagnostics.summary.length > 0}>
					<text color="dim">({sanitizeDiagnosticDisplayText(props.diagnostics.summary)})</text>
				</Show>
			</row>
			<DiagnosticTree messages={props.diagnostics.messages} expanded={props.expanded} />
		</stack>
	);
}

function WriteView(props: ToolViewProps<WriteRenderArgs, WriteToolDetails>): JSX.Element {
	const { theme } = useTheme();
	const hasPath = createMemo(() => props.args.path !== undefined || props.args.file_path !== undefined);
	const rawPath = createMemo(() => writePath(props.args));
	const isProvisionalDevicePath = createMemo(
		() => rawPath().length > 0 && couldBecomeXdUrl(rawPath()) && props.args.content === undefined,
	);
	const content = createMemo(() => {
		const value = props.args.content;
		if (typeof value === "string") return value.replace(/\r/g, "");
		if (value === undefined || value === null) return "";
		return String(value).replace(/\r/g, "");
	});
	const snapshots = documentFromSnapshots();
	createEffect(() => snapshots.push(content()));

	const language = createMemo(() => (rawPath().length > 0 ? getLanguageFromPath(rawPath()) : undefined));
	const languageIcon = createMemo(() => theme().getLangIcon(language()));
	const lines = createMemo(() => (content().length === 0 ? 0 : content().split("\n").length));
	const progress = createMemo(() => {
		props.output.version();
		return sanitizeText(props.output.text());
	});
	const isPartialResult = createMemo(
		() => props.phase === "running" && (progress().length > 0 || props.details !== undefined),
	);
	const isError = createMemo(
		() => props.phase === "settled" && (props.outcome === "failed" || props.outcome === "timed_out"),
	);
	const isAborted = createMemo(
		() => props.phase === "settled" && (props.outcome === "cancelled" || props.outcome === "skipped"),
	);
	const isSettledResult = createMemo(() => props.phase === "settled" && !isError());
	const resultStatus = createMemo<ToolUIStatus | undefined>(() => {
		if (isPartialResult()) return "running";
		if (!isSettledResult() && !isError()) return undefined;
		if (isError()) return "error";
		if (isAborted()) return "aborted";
		return "success";
	});
	const resultPreviewEnd = createMemo(() => (props.ui.expanded ? lines() : Math.min(lines(), WRITE_PREVIEW_LINES)));
	const resultHidden = createMemo(() => Math.max(0, lines() - resultPreviewEnd()));
	const streamingStart = createMemo(() =>
		props.ui.expanded ? 0 : Math.max(0, lines() - WRITE_STREAMING_PREVIEW_ROWS),
	);
	const streamingHidden = createMemo(() => streamingStart());
	const errorText = createMemo(() => (progress() || "Unknown error").replace(/^Error:\s*/, ""));
	const diagnostics = createMemo(() => props.details?.diagnostics);

	return (
		<Show when={hasPath() && !isProvisionalDevicePath()}>
			<ToolCard
				phase={props.phase}
				outcome={props.outcome}
				borderColor={isError() ? "error" : "borderMuted"}
				header={
					<WriteHeader
						status={resultStatus()}
						path={rawPath()}
						target={props.details?.resolvedPath}
						languageIcon={languageIcon()}
						lines={isPartialResult() || isSettledResult() ? lines() : 0}
						madeExecutable={
							props.phase === "settled" && !isError() && !isAborted() && props.details?.madeExecutable === true
						}
					/>
				}
			>
				<Show when={!isPartialResult() && props.phase !== "settled" && content().length > 0}>
					<stack>
						<Show when={streamingHidden() > 0}>
							<text color="dim">… ({plural(streamingHidden(), "earlier line")})</text>
						</Show>
						<code
							document={snapshots.doc}
							language={language()}
							lineNumbers={true}
							lineNumberMinWidth={WRITE_GUTTER_MIN_WIDTH}
							startLine={streamingStart()}
						/>
						<row gap={1}>
							<Show when={props.phase !== "running"}>
								<status value="running" />
							</Show>
							<text color="dim">… (streaming)</text>
						</row>
					</stack>
				</Show>
				<Show when={isPartialResult()}>
					<stack>
						<Show when={progress().length > 0}>
							<text color="muted" wrap="none" overflow="ellipsis">
								{progress()}
							</text>
						</Show>
						<Show when={content().length > 0}>
							<code
								document={snapshots.doc}
								language={language()}
								lineNumbers={true}
								lineNumberMinWidth={WRITE_GUTTER_MIN_WIDTH}
								endLine={resultPreviewEnd()}
							/>
							<Show when={resultHidden() > 0}>
								<row gap={1}>
									<text color="dim">… {plural(resultHidden(), "more line")}</text>
									<ExpandHint expanded={props.ui.expanded} hasMore />
								</row>
							</Show>
						</Show>
					</stack>
				</Show>
				<Show when={isError()}>
					<text color="error">
						{"  "}
						{errorText()}
					</text>
				</Show>
				<Show when={isSettledResult()}>
					<stack>
						<Show when={content().length > 0}>
							<code
								document={snapshots.doc}
								language={language()}
								lineNumbers={true}
								lineNumberMinWidth={WRITE_GUTTER_MIN_WIDTH}
								endLine={resultPreviewEnd()}
							/>
							<Show when={resultHidden() > 0}>
								<row gap={1}>
									<text color="dim">… {plural(resultHidden(), "more line")}</text>
									<ExpandHint expanded={props.ui.expanded} hasMore />
								</row>
							</Show>
						</Show>
						<Show when={diagnostics()}>
							{(detail: Accessor<FileDiagnosticsResult>) => (
								<Show when={detail().messages.length > 0}>
									<WriteDiagnostics diagnostics={detail()} expanded={props.ui.expanded} />
								</Show>
							)}
						</Show>
					</stack>
				</Show>
			</ToolCard>
		</Show>
	);
}

function writeSummary(props: ToolViewProps<WriteRenderArgs, WriteToolDetails>): ActivitySummary {
	const path = writePath(props.args);
	const status: ToolUIStatus =
		props.phase === "receiving" || props.phase === "queued"
			? "pending"
			: props.phase === "running"
				? "running"
				: props.outcome === "failed" || props.outcome === "timed_out"
					? "error"
					: props.outcome === "cancelled" || props.outcome === "skipped"
						? "aborted"
						: "success";
	return {
		label: "Write",
		detail: path ? shortenPath(path) : undefined,
		status,
	};
}

export const writeToolView: ToolViewDefinition<WriteRenderArgs, WriteToolDetails> = {
	view: WriteView,
	summary: writeSummary,
	framed: true,
};

registerToolView("write", writeToolView);
