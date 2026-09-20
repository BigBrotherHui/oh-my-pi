import { editInspect } from "@oh-my-pi/pi-natives";
import { documentFromSnapshots } from "../document/snapshots";
import { getLanguageFromPath } from "../lang-from-path";
import { createEffect, createMemo, For, Show, useTheme, useViewport, type JSX } from "../reactive";
import {
	formatExpandHint,
	getDiffStats,
	PREVIEW_LIMITS,
	previewWindowRows,
	replaceTabs,
	shortenPath,
	truncateDiffByHunk,
	wrapTextWithAnsi,
} from "../render/render-utils";
import type { ToolUIStatus } from "../host/elements/status";
import { ToolCard } from "../view/tool-card";
import type { SymbolKey } from "../theme/symbols";

import { decodeStreamingToolArgs } from "./argument-decoder";
import { HL_FILE_PREFIX, HL_FILE_SUFFIX, HL_MOVE_KEYWORD, HL_REM_KEYWORD } from "./hashline-format";
import type { FileDiagnosticsResult } from "./lsp";
import type { OutputMeta } from "./output-meta";
import { registerToolView } from "./registry";
import type { ActivitySummary, CallOutcome, CallPhase, ToolViewDefinition, ToolViewProps } from "./view";

/** Edit payload syntax selected by the caller. */
export type EditMode = "replace" | "patch" | "hashline" | "apply_patch" | "sloppy";

/** Filesystem operation represented by an edit. */
export type Operation = "create" | "delete" | "update";

/** Computed streaming diff or preview error for one file. */
export interface PerFileDiffPreview {
	path: string;
	diff?: string;
	firstChangedLine?: number;
	error?: string;
}

/** Result metadata for one edited file. */
export interface EditToolPerFileResult {
	path: string;
	diff: string;
	firstChangedLine?: number;
	diagnostics?: FileDiagnosticsResult;
	op?: Operation;
	move?: string;
	isError?: boolean;
	errorText?: string;
	displayErrorText?: string;
	meta?: OutputMeta;
	oldText?: string;
	newText?: string;
	snapshotsPruned?: boolean;
	sourcePath?: string;
}

/** Diff, diagnostics, and snapshots returned by an edit. */
export interface EditToolDetails {
	diff: string;
	firstChangedLine?: number;
	diagnostics?: FileDiagnosticsResult;
	op?: Operation;
	move?: string;
	meta?: OutputMeta;
	perFileResults?: EditToolPerFileResult[];
	path?: string;
	oldText?: string;
	newText?: string;
	snapshotsPruned?: boolean;
	sourcePath?: string;
}

interface EditRenderEntry {
	readonly path?: unknown;
	readonly rename?: unknown;
	readonly move?: unknown;
	readonly op?: Operation;
}

export interface EditRenderArgs {
	path?: unknown;
	file_path?: unknown;
	oldText?: string;
	newText?: string;
	old_string?: string;
	new_string?: string;
	patch?: string;
	input?: string;
	_input?: string;
	replace_all?: boolean;
	op?: Operation;
	rename?: unknown;
	diff?: string;
	previewDiff?: string;
	edits?: EditRenderEntry[];
}

/**
 * Typed call-phase presentation data produced by the edit executor. This
 * carries the live mode and previews that cannot be reconstructed safely from
 * incomplete JSON arguments.
 */
export interface EditPreview {
	readonly editMode?: EditMode;
	readonly editDiffPreview?:
		| { readonly diff: string; readonly firstChangedLine?: number }
		| { readonly error: string };
	readonly perFileDiffPreview?: readonly PerFileDiffPreview[];
	readonly editStreamingFallback?: string;
}

type EditViewProps = ToolViewProps<EditRenderArgs, EditToolDetails>;
type EditArgsView = EditViewProps["args"];
type EditFileView = NonNullable<NonNullable<EditViewProps["details"]>["perFileResults"]>[number];

const CALL_TEXT_PREVIEW_LINES = 6;
const MISSING_APPLY_PATCH_END_ERROR = "The last line of the patch must be '*** End Patch'";

export function hasStreamingFallbackPayload(editMode: EditMode, args: unknown): boolean {
	if (editMode !== "replace" || args === null || typeof args !== "object" || Array.isArray(args)) return false;
	return (
		("new_string" in args && typeof args.new_string === "string") ||
		("newText" in args && typeof args.newText === "string")
	);
}

function sanitizeText(text: string): string {
	return text.replace(/\r/g, "").replace(/\t/g, "    ");
}

function cleanPath(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function operationTitle(op: Operation | undefined): "Create" | "Delete" | "Edit" {
	return op === "create" ? "Create" : op === "delete" ? "Delete" : "Edit";
}

function callStatus(
	phase: CallPhase,
	outcome: CallOutcome | undefined,
	diagnostics?: FileDiagnosticsResult,
): ToolUIStatus {
	if (phase === "running") return "running";
	if (phase === "queued" || phase === "receiving") return "pending";
	if (outcome === "failed") return "error";
	if (outcome === "cancelled" || outcome === "skipped") return "aborted";
	if (outcome === "timed_out" || diagnostics?.errored) return "warning";
	return "done";
}

function partialEditPath(rawArgs: string | undefined): string | undefined {
	return cleanPath(decodeStreamingToolArgs(rawArgs).path);
}

function countEditFiles(edits: readonly EditRenderEntry[]): number {
	const paths = new Set<string>();
	for (const edit of edits) {
		const path = cleanPath(edit.path);
		if (path) paths.add(path);
	}
	return paths.size;
}

function normalizeHashlineInputPreviewPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	const hashStart = /#[0-9a-fA-F]{4}$/u.exec(trimmed)?.index;
	const withoutHash = hashStart === undefined ? trimmed : trimmed.slice(0, hashStart);
	if (withoutHash.length < 2) return withoutHash;
	const first = withoutHash[0];
	const last = withoutHash[withoutHash.length - 1];
	return (first === '"' || first === "'") && first === last ? withoutHash.slice(1, -1) : withoutHash;
}

function parseHashlineInputPreviewHeader(line: string): string | undefined {
	const trimmed = line.trimEnd();
	if (!trimmed.startsWith(HL_FILE_PREFIX)) return undefined;
	const bodyEnd = trimmed.endsWith(HL_FILE_SUFFIX) ? trimmed.length - HL_FILE_SUFFIX.length : trimmed.length;
	const body = trimmed.slice(HL_FILE_PREFIX.length, bodyEnd).trim();
	const previewPath = normalizeHashlineInputPreviewPath(body);
	return previewPath || undefined;
}

interface ParsedInputEntry {
	readonly path: string;
	readonly op?: Operation;
	readonly rename?: string;
	readonly hasLineEdits?: boolean;
}

const HASHLINE_LINE_OPERATION = /^(?:PUT|CUT)\b/u;

function hashlineInputEntries(input: string): readonly ParsedInputEntry[] {
	const entries: ParsedInputEntry[] = [];
	let current: { path: string; op?: Operation; rename?: string; hasLineEdits?: boolean } | undefined;
	for (const raw of input.replace(/^\uFEFF/u, "").split("\n")) {
		const line = raw.replace(/\r$/u, "");
		const path = parseHashlineInputPreviewHeader(line);
		if (path) {
			current = { path };
			entries.push(current);
			continue;
		}
		if (!current) continue;
		const trimmed = line.trim();
		if (trimmed === HL_REM_KEYWORD) current.op = "delete";
		else if (trimmed.startsWith(`${HL_MOVE_KEYWORD} `)) {
			current.rename = normalizeHashlineInputPreviewPath(trimmed.slice(HL_MOVE_KEYWORD.length + 1));
		} else if (HASHLINE_LINE_OPERATION.test(trimmed)) current.hasLineEdits = true;
	}
	return entries;
}

function inspectedInputEntries(mode: "sloppy" | "apply_patch", input: string): readonly ParsedInputEntry[] {
	const inspection = editInspect(mode, JSON.stringify({ input }));
	const entries = new Map<string, { path: string; op?: Operation; rename?: string }>();
	for (const path of inspection.paths) entries.set(path, { path });
	for (const intent of inspection.fileOps) {
		const entry = entries.get(intent.path) ?? { path: intent.path };
		if (intent.kind === "delete") entry.op = "delete";
		if (intent.kind === "move") {
			entry.op = "update";
			entry.rename = intent.to;
		}
		entries.set(intent.path, entry);
	}
	return [...entries.values()];
}

interface EditCallFacts {
	readonly rawPath: string;
	readonly rename?: string;
	readonly op?: Operation;
	readonly fileCount: number;
	readonly applyPatchError?: string;
	readonly hasHashlineLineEdits: boolean;
}

function applyPatchEntries(input: string, phase: CallPhase): { entries: readonly ParsedInputEntry[]; error?: string } {
	try {
		return { entries: inspectedInputEntries("apply_patch", input) ?? [] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return phase !== "settled" && message === MISSING_APPLY_PATCH_END_ERROR
			? { entries: [] }
			: { entries: [], error: message };
	}
}

const EDIT_FACTS_MIN_GROWTH = 512;

let lastFacts:
	| {
			readonly args: EditArgsView;
			readonly rawArgs?: string;
			readonly editMode?: EditMode;
			readonly phase: CallPhase;
			readonly payloadLength: number;
			readonly facts: EditCallFacts;
	  }
	| undefined;

function editPayloadLength(args: EditArgsView, rawArgs: string | undefined): number {
	const input = typeof args.input === "string" ? args.input : typeof args._input === "string" ? args._input : rawArgs;
	return typeof input === "string" ? input.length : (args.edits?.length ?? 0);
}

function resolveCallFacts(
	args: EditArgsView,
	rawArgs: string | undefined,
	phase: CallPhase,
	preview: EditPreview | undefined,
): EditCallFacts {
	const payloadLength = editPayloadLength(args, rawArgs);
	const cached = lastFacts;
	const extendsCachedRawArgs =
		cached?.rawArgs === undefined
			? rawArgs === undefined
			: rawArgs !== undefined && rawArgs.startsWith(cached.rawArgs);
	if (
		cached?.args === args &&
		extendsCachedRawArgs &&
		cached.editMode === preview?.editMode &&
		cached.phase === phase &&
		phase !== "settled" &&
		payloadLength >= cached.payloadLength &&
		payloadLength - cached.payloadLength < EDIT_FACTS_MIN_GROWTH
	) {
		return cached.facts;
	}
	const facts = resolveCallFactsUncached(args, rawArgs, phase, preview);
	lastFacts = { args, rawArgs, editMode: preview?.editMode, phase, payloadLength, facts };
	return facts;
}

function resolveCallFactsUncached(
	args: EditArgsView,
	rawArgs: string | undefined,
	phase: CallPhase,
	preview: EditPreview | undefined,
): EditCallFacts {
	const input =
		typeof args.input === "string" ? args.input : typeof args._input === "string" ? args._input : undefined;
	const editMode = preview?.editMode;
	const hashlineEntries = editMode === "hashline" && input ? hashlineInputEntries(input) : undefined;
	let sloppyEntries: readonly ParsedInputEntry[] | undefined;
	if (editMode === "sloppy" && input) {
		try {
			sloppyEntries = inspectedInputEntries("sloppy", input);
		} catch {
			sloppyEntries = undefined;
		}
	}
	const patchSummary =
		(editMode === undefined || editMode === "apply_patch") && typeof args.input === "string"
			? applyPatchEntries(args.input, phase)
			: undefined;
	const firstEdit = args.edits?.[0];
	const firstHashline = hashlineEntries?.[0];
	const firstSloppy = sloppyEntries?.[0];
	const firstPatch = patchSummary?.entries[0];
	const rawPath =
		rawArgs === undefined
			? (cleanPath(args.file_path) ??
				cleanPath(args.path) ??
				cleanPath(firstEdit?.path) ??
				firstHashline?.path ??
				firstSloppy?.path ??
				firstPatch?.path ??
				"")
			: (partialEditPath(rawArgs) ?? "");
	const rename =
		cleanPath(args.rename) ??
		cleanPath(firstEdit?.rename) ??
		cleanPath(firstEdit?.move) ??
		firstPatch?.rename ??
		firstHashline?.rename;
	const op = args.op ?? firstEdit?.op ?? firstPatch?.op ?? firstHashline?.op;
	const parsedCount = hashlineEntries?.length ?? sloppyEntries?.length ?? patchSummary?.entries.length ?? 0;
	return {
		rawPath,
		rename,
		op,
		fileCount: args.edits ? countEditFiles(args.edits) : parsedCount,
		applyPatchError: patchSummary?.error,
		hasHashlineLineEdits: firstHashline?.hasLineEdits === true,
	};
}

function hasCallPayload(args: EditArgsView, preview: EditPreview | undefined): boolean {
	if (preview?.perFileDiffPreview?.some(file => Boolean(file.diff || file.error))) return true;
	return Boolean(
		args.previewDiff ||
		args.diff ||
		args.newText ||
		args.new_string ||
		args.patch ||
		(args.edits && args.edits.length > 0) ||
		preview?.editStreamingFallback,
	);
}

interface CollapsedDiff {
	readonly text: string;
	readonly hiddenHunks: number;
	readonly hiddenLines: number;
}

function collapseDiff(diff: string): CollapsedDiff {
	return truncateDiffByHunk(diff, PREVIEW_LIMITS.DIFF_COLLAPSED_HUNKS, PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);
}

function DiffBody(props: {
	readonly diff: string;
	readonly filePath: string;
	readonly expanded: boolean;
}): JSX.Element {
	const { theme } = useTheme();
	const collapsed = createMemo(() => collapseDiff(props.diff));
	const snapshots = documentFromSnapshots();
	createEffect(() => snapshots.push(props.expanded ? props.diff : collapsed().text));
	const remainder = createMemo(() => {
		if (props.expanded) return undefined;
		const current = collapsed();
		if (current.hiddenHunks === 0 && current.hiddenLines === 0) return undefined;
		const parts: string[] = [];
		if (current.hiddenHunks > 0) parts.push(`${current.hiddenHunks} more hunks`);
		if (current.hiddenLines > 0) parts.push(`${current.hiddenLines} more lines`);
		return `… (${parts.join(", ")}) ${formatExpandHint(theme())}`;
	});

	return (
		<stack>
			<Show
				when={props.expanded}
				fallback={
					<scroll height={PREVIEW_LIMITS.DIFF_COLLAPSED_LINES} shrinkToFit scrollbar="never">
						<diff document={snapshots.doc} filePath={props.filePath} wrap />
					</scroll>
				}
			>
				<diff document={snapshots.doc} filePath={props.filePath} wrap />
			</Show>
			<Show when={remainder()}>
				<text color="toolOutput">{remainder() ?? ""}</text>
			</Show>
		</stack>
	);
}

interface StreamingDiffTail {
	readonly content: string;
	readonly hidden: boolean;
}

/** Preserve a newest-first streaming diff window within a physical-row budget. */
function streamingDiffTail(diff: string, budget: number, width: number): StreamingDiffTail {
	const lines = diff.replace(/\n+$/u, "").split("\n");
	let start = lines.length;
	let rows = 0;
	while (start > 0) {
		const line = lines[start - 1]!;
		const lineRows = Math.max(1, wrapTextWithAnsi(replaceTabs(line), width).length);
		if (rows > 0 && rows + lineRows > budget) break;
		rows += lineRows;
		start--;
	}
	return { content: lines.slice(start).join("\n"), hidden: start > 0 };
}

function StreamingDiff(props: {
	readonly diff: string;
	readonly filePath: string;
	readonly expanded: boolean;
	readonly label: "preview" | "streaming";
	readonly showSpinner?: boolean;
}): JSX.Element {
	const viewport = useViewport();
	const tail = createMemo(() => {
		const windowRows = previewWindowRows(viewport().rows);
		const budget = props.expanded ? windowRows : Math.min(PREVIEW_LIMITS.EXPANDED_LINES, windowRows);
		return streamingDiffTail(props.diff, budget, Math.max(1, viewport().columns - 2));
	});
	const snapshots = documentFromSnapshots();
	createEffect(() => snapshots.push(tail().content));
	return (
		<stack>
			<Show when={tail().hidden}>
				<text color="dim">… (content above)</text>
			</Show>
			<diff document={snapshots.doc} filePath={props.filePath} wrap />
			<Show when={props.showSpinner !== false || !(props.expanded && props.label === "preview")}>
				<row gap={1}>
					<Show when={props.showSpinner !== false}>
						<spinner />
					</Show>
					<Show when={!(props.expanded && props.label === "preview")}>
						<text color="dim">({props.label})</text>
					</Show>
				</row>
			</Show>
		</stack>
	);
}

function PlainTextPreview(props: { readonly text: string }): JSX.Element {
	const snapshots = documentFromSnapshots();
	createEffect(() => snapshots.push(sanitizeText(props.text)));
	return (
		<preview document={snapshots.doc} edge="head" limit={CALL_TEXT_PREVIEW_LINES} unit="lines" color="toolOutput" />
	);
}

interface CallPreview {
	readonly kind: "diff" | "text" | "error";
	readonly text: string;
	readonly label?: "preview" | "streaming";
	readonly path?: string;
}

function singleCallPreview(args: EditArgsView, preview: EditPreview | undefined): CallPreview | undefined {
	if (args.previewDiff) return { kind: "diff", text: args.previewDiff, label: "preview" };
	if (args.diff && args.op) return { kind: "diff", text: args.diff, label: "streaming" };
	if (args.diff) return { kind: "text", text: args.diff };
	const diffPreview = preview?.editDiffPreview;
	if (diffPreview && "error" in diffPreview) return { kind: "error", text: diffPreview.error };
	if (diffPreview) return { kind: "diff", text: diffPreview.diff, label: "preview" };
	if (args.newText || args.new_string || args.patch) {
		return { kind: "text", text: args.newText ?? args.new_string ?? args.patch ?? "" };
	}
	if (preview?.editStreamingFallback) return { kind: "text", text: preview.editStreamingFallback };
	return undefined;
}

function CallPreviewBody(props: {
	readonly args: EditArgsView;
	readonly facts: EditCallFacts;
	readonly preview?: EditPreview;
	readonly phase: CallPhase;
	readonly expanded: boolean;
}): JSX.Element {
	const previews = () => props.preview?.perFileDiffPreview ?? [];
	const hasMultiFilePreview = () => previews().length > 1 && previews().some(preview => preview.diff || preview.error);
	const singlePreview = () => singleCallPreview(props.args, props.preview);
	return (
		<Show
			when={hasMultiFilePreview()}
			fallback={
				<>
					<Show when={singlePreview()?.kind === "diff"}>
						<StreamingDiff
							diff={singlePreview()?.text ?? ""}
							filePath={singlePreview()?.path ?? props.facts.rawPath}
							expanded={props.expanded}
							label={singlePreview()?.label ?? "preview"}
							showSpinner={props.phase === "receiving"}
						/>
					</Show>
					<Show when={singlePreview()?.kind === "error"}>
						<text color="error">{sanitizeText(singlePreview()?.text ?? "")}</text>
					</Show>
					<Show when={singlePreview()?.kind === "text"}>
						<PlainTextPreview text={singlePreview()?.text ?? ""} />
					</Show>
				</>
			}
		>
			<stack gap={1}>
				<For each={previews()}>
					{(preview, index) => (
						<Show when={preview.diff || preview.error}>
							<stack>
								<text color="dim">── {shortenPath(preview.path)} ──</text>
								<Show
									when={preview.error}
									fallback={
										<Show when={preview.diff}>
											<StreamingDiff
												diff={preview.diff ?? ""}
												filePath={preview.path}
												expanded={props.expanded}
												label="preview"
												showSpinner={index() === previews().length - 1 && props.phase === "receiving"}
											/>
										</Show>
									}
								>
									<text color="error">{sanitizeText(preview.error ?? "")}</text>
								</Show>
							</stack>
						</Show>
					)}
				</For>
			</stack>
		</Show>
	);
}

function EditHeader(props: {
	readonly phase: CallPhase;
	readonly outcome?: CallOutcome;
	readonly diagnostics?: FileDiagnosticsResult;
	/** Framed streaming calls keep liveness on the volatile trailing row. */
	readonly showStatus?: boolean;
	/** Payload-less moves use the historical imperative action title. */
	readonly inlineAction?: boolean;
	readonly op?: Operation;
	readonly path: string;
	readonly sourcePath?: string;
	readonly rename?: string;
	readonly sourceTarget?: string;
	readonly destinationTarget?: string;
	readonly firstChangedLine?: number;
	readonly fileCount?: number;
	readonly diff?: string;
}): JSX.Element {
	const { theme } = useTheme();
	const source = () => props.sourcePath ?? props.path;
	const destination = () => props.rename ?? (props.sourcePath ? props.path : undefined);
	const stats = createMemo(() => getDiffStats(props.diff ?? ""));
	const languageIcon = createMemo(() => theme().getLangIcon(getLanguageFromPath(source())));
	const title = () => (props.inlineAction && (props.rename || props.sourcePath) ? "Move" : operationTitle(props.op));
	const status = createMemo(() =>
		props.inlineAction && props.phase !== "settled"
			? "pending"
			: callStatus(props.phase, props.outcome, props.diagnostics),
	);
	const visibleStatus = () => (props.showStatus === false || status() === "done" ? undefined : status());
	const icon = createMemo<SymbolKey | undefined>(() => {
		if (props.showStatus === false || visibleStatus() !== undefined) return undefined;
		if (props.op === "delete") return "tool.delete";
		return props.rename || props.sourcePath ? "tool.move" : "tool.edit";
	});
	return (
		<row gap={1} pad={false} equalGrow>
			<Show when={visibleStatus()}>
				<status value={visibleStatus()!} shrink={0} />
			</Show>
			<Show when={icon()}>
				<icon name={icon()!} color="accent" shrink={0} />
			</Show>
			<text shrink={0} wrap="none">
				<span color="accent">{title()}</span>:
			</text>
			<text color="muted" shrink={0} wrap="none">
				{languageIcon()}
			</text>
			<path
				color="accent"
				grow={1}
				minWidth={1}
				value={shortenPath(source() || "…")}
				target={props.sourceTarget}
				line={props.firstChangedLine}
				overflow="middle"
			/>
			<Show when={destination()}>
				<text color="dim" shrink={0}>
					→
				</text>
				<path
					color="accent"
					grow={1}
					minWidth={1}
					value={shortenPath(destination() ?? "")}
					target={props.destinationTarget}
					overflow="middle"
				/>
			</Show>
			<Show when={(props.fileCount ?? 0) > 1}>
				<text color="dim" shrink={0} wrap="none">
					(+{props.fileCount! - 1} more)
				</text>
			</Show>
			<Show when={stats().added > 0 || stats().removed > 0}>
				<text shrink={0} wrap="none">
					<span color="dim">{theme().format.bracketLeft}</span>
					<Show when={stats().added > 0}>
						<span color="toolDiffAdded">+{stats().added}</span>
					</Show>
					<Show when={stats().removed > 0}>
						<Show when={stats().added > 0}>
							<span color="dim">/</span>
						</Show>
						<span color="toolDiffRemoved">-{stats().removed}</span>
					</Show>
					<span color="dim">{theme().format.bracketRight}</span>
				</text>
			</Show>
			<Show when={props.inlineAction}>
				<text shrink={0}>{"      "}</text>
			</Show>
		</row>
	);
}

function Diagnostics(props: { readonly diagnostics?: FileDiagnosticsResult; readonly expanded: boolean }): JSX.Element {
	return (
		<Show when={props.diagnostics && props.diagnostics.messages.length > 0}>
			<stack>
				<text color={props.diagnostics!.errored ? "error" : "warning"}>{props.diagnostics!.summary}</text>
				<For each={props.expanded ? props.diagnostics!.messages : props.diagnostics!.messages.slice(0, 5)}>
					{message => <text color="dim">{sanitizeText(message)}</text>}
				</For>
			</stack>
		</Show>
	);
}

function outcomeError(props: EditViewProps, details?: EditViewProps["details"] | EditFileView): string {
	if (details && "displayErrorText" in details && typeof details.displayErrorText === "string") {
		return sanitizeText(details.displayErrorText);
	}
	if (details && "errorText" in details && typeof details.errorText === "string") {
		return sanitizeText(details.errorText);
	}
	return sanitizeText((props.output.text() || "Unknown error").replace(/^Error:\s*/u, ""));
}

function FileResultCard(props: { readonly parent: EditViewProps; readonly file: EditFileView }): JSX.Element {
	const isError = () => props.file.isError === true;
	const outcome = (): CallOutcome | undefined => (isError() ? "failed" : props.parent.outcome);
	const noBody = () =>
		!isError() &&
		!props.file.diff &&
		!props.file.diagnostics &&
		(props.file.op === "delete" || Boolean(props.file.move || props.file.sourcePath));
	return (
		<ToolCard
			phase={props.parent.phase}
			outcome={outcome()}
			framed={!noBody()}
			expanded={props.parent.ui.expanded}
			tint={noBody() ? false : undefined}
			paddingX={0}
			borderColor={isError() ? "error" : "borderMuted"}
			header={
				<EditHeader
					phase={props.parent.phase}
					outcome={outcome()}
					diagnostics={props.file.diagnostics}
					inlineAction={noBody()}
					op={props.file.op}
					path={props.file.path}
					sourcePath={props.file.sourcePath}
					rename={props.file.move}
					sourceTarget={props.file.path}
					destinationTarget={props.file.path}
					firstChangedLine={props.file.firstChangedLine}
					diff={props.file.diff}
				/>
			}
		>
			<Show when={isError()}>
				<text color="error">{outcomeError(props.parent, props.file)}</text>
			</Show>
			<Show when={!isError() && props.file.diff}>
				<DiffBody diff={props.file.diff} filePath={props.file.path} expanded={props.parent.ui.expanded} />
			</Show>
			<Show when={!isError() && !props.file.diff && !noBody() && !props.file.diagnostics}>
				<text color="dim">No changes were made to {shortenPath(props.file.path)}.</text>
			</Show>
			<Show when={!isError()}>
				<Diagnostics diagnostics={props.file.diagnostics} expanded={props.parent.ui.expanded} />
			</Show>
		</ToolCard>
	);
}

function SingleResultCard(props: { readonly parent: EditViewProps; readonly facts: EditCallFacts }): JSX.Element {
	const details = () => props.parent.details;
	const callPreview = () => props.parent.ui.edit?.editDiffPreview;
	const previewDiff = () => {
		const preview = callPreview();
		return preview && "diff" in preview ? preview.diff : "";
	};
	const previewError = () => {
		const preview = callPreview();
		return preview && "error" in preview ? preview.error : undefined;
	};
	const previewFirstChangedLine = () => {
		const preview = callPreview();
		return preview && "diff" in preview ? preview.firstChangedLine : undefined;
	};
	// The caller's authored path is the title; the resolved result path remains
	// the link target (and becomes the title only when no call path is known).
	const path = () => props.facts.rawPath || details()?.path || "";
	const source = () => details()?.sourcePath;
	const rename = () => props.facts.rename ?? details()?.move;
	const op = () => props.facts.op ?? details()?.op;
	const diff = () => details()?.diff || previewDiff();
	const isError = () => props.parent.outcome === "failed";
	const aborted = () => props.parent.outcome === "cancelled" || props.parent.outcome === "skipped";
	const inline = () =>
		!isError() &&
		!aborted() &&
		!diff() &&
		!previewError() &&
		!details()?.diagnostics &&
		(op() === "delete" || Boolean(rename() || source()));
	return (
		<ToolCard
			phase={props.parent.phase}
			outcome={props.parent.outcome}
			framed={!inline()}
			expanded={props.parent.ui.expanded}
			tint={inline() ? false : undefined}
			paddingX={0}
			borderColor={isError() ? "error" : "borderMuted"}
			header={
				<EditHeader
					phase={props.parent.phase}
					outcome={props.parent.outcome}
					diagnostics={details()?.diagnostics}
					inlineAction={inline()}
					op={op()}
					path={path()}
					sourcePath={source()}
					rename={rename()}
					sourceTarget={details()?.path}
					destinationTarget={details()?.path}
					firstChangedLine={details()?.firstChangedLine ?? previewFirstChangedLine()}
					diff={diff()}
				/>
			}
		>
			<Show when={isError()}>
				<text color="error">{outcomeError(props.parent, details())}</text>
			</Show>
			<Show when={aborted()}>
				<text color="warning">{props.parent.outcome === "skipped" ? "Edit skipped." : "Edit cancelled."}</text>
			</Show>
			<Show when={!isError() && !aborted() && previewError()}>
				<text color="error">{sanitizeText(previewError() ?? "")}</text>
			</Show>
			<Show when={!isError() && !aborted() && !previewError() && diff()}>
				<DiffBody diff={diff()} filePath={path()} expanded={props.parent.ui.expanded} />
			</Show>
			<Show when={!isError() && !aborted() && !previewError() && !diff() && !inline() && !details()?.diagnostics}>
				<text color="dim">No changes were made{path() ? ` to ${shortenPath(path())}` : ""}.</text>
			</Show>
			<Show when={!isError() && !aborted()}>
				<Diagnostics diagnostics={details()?.diagnostics} expanded={props.parent.ui.expanded} />
			</Show>
		</ToolCard>
	);
}

function PendingEdit(props: { readonly parent: EditViewProps; readonly facts: EditCallFacts }): JSX.Element {
	const inline = () =>
		props.facts.fileCount <= 1 &&
		!props.facts.applyPatchError &&
		!props.facts.hasHashlineLineEdits &&
		(props.facts.op === "delete" ||
			(props.facts.rename !== undefined && !hasCallPayload(props.parent.args, props.parent.ui.edit)));
	return (
		<ToolCard
			phase={props.parent.phase}
			outcome={props.parent.outcome}
			framed={!inline()}
			expanded={props.parent.ui.expanded}
			tint={inline() ? false : undefined}
			paddingX={0}
			borderColor={props.facts.applyPatchError ? "error" : "borderMuted"}
			header={
				<EditHeader
					phase={props.parent.phase}
					outcome={props.parent.outcome}
					showStatus={inline()}
					inlineAction={inline()}
					op={props.facts.op}
					path={props.facts.rawPath}
					rename={props.facts.rename}
					fileCount={props.facts.fileCount}
				/>
			}
		>
			<stack>
				<CallPreviewBody
					args={props.parent.args}
					facts={props.facts}
					preview={props.parent.ui.edit}
					phase={props.parent.phase}
					expanded={props.parent.ui.expanded}
				/>
				<Show when={props.facts.applyPatchError}>
					<text color="error">{sanitizeText(props.facts.applyPatchError ?? "")}</text>
				</Show>
			</stack>
		</ToolCard>
	);
}

function EditView(props: EditViewProps): JSX.Element {
	const facts = createMemo(() => resolveCallFacts(props.args, props.rawArgs, props.phase, props.ui.edit));
	const perFileResults = createMemo(() => props.details?.perFileResults ?? []);
	const totalFiles = createMemo(() => Math.max(facts().fileCount, perFileResults().length));
	const multiFile = createMemo(() => perFileResults().length > 1 || totalFiles() > 1);
	const remaining = createMemo(() => Math.max(0, totalFiles() - perFileResults().length));

	return (
		<Show when={props.phase === "settled"} fallback={<PendingEdit parent={props} facts={facts()} />}>
			<Show
				when={multiFile() && perFileResults().length > 0}
				fallback={<SingleResultCard parent={props} facts={facts()} />}
			>
				<stack gap={1}>
					<For each={perFileResults()}>{file => <FileResultCard parent={props} file={file} />}</For>
					<Show when={remaining() > 0}>
						<row gap={1}>
							<Show when={props.phase === "running"}>
								<spinner />
							</Show>
							<text color="dim">
								{remaining()} more file{remaining() === 1 ? "" : "s"} pending…
							</text>
						</row>
					</Show>
				</stack>
			</Show>
		</Show>
	);
}

function editSummary(props: EditViewProps): ActivitySummary {
	const facts = resolveCallFacts(props.args, props.rawArgs, props.phase, props.ui.edit);
	const detail = facts.rawPath
		? `${shortenPath(facts.rawPath)}${facts.rename ? ` → ${shortenPath(facts.rename)}` : ""}${
				facts.fileCount > 1 ? ` (+${facts.fileCount - 1} more)` : ""
			}`
		: undefined;
	return {
		label: operationTitle(facts.op),
		detail,
		status: callStatus(props.phase, props.outcome, props.details?.diagnostics),
	};
}

export const editToolView: ToolViewDefinition<EditRenderArgs, EditToolDetails> = {
	view: props => <EditView {...props} />,
	summary: props => editSummary(props),
	framed: true,
};

registerToolView("edit", editToolView);
registerToolView("apply_patch", editToolView);
