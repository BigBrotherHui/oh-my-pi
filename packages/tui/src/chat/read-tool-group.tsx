import type { Usage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { createDocument } from "../document/document";
import type { TextDocument } from "../document/types";
import { createImagePaintState } from "../components/image";
import { getLanguageFromPath } from "../lang-from-path";
import { createMemo, createSignal, For, Show, type Accessor, type JSX } from "../reactive";
import { useTheme } from "../theme/reactive";
import { fileUriForTerminal } from "../render/hyperlink";
import { shortenPath } from "../render/render-utils";
import { TERMINAL } from "../terminal-capabilities";
import type { ToolCallModel } from "../tools/model";
import { parseLineRanges } from "../tools/line-ranges";
import { splitPathAndSel } from "../tools/read";
import { XD_URL_PREFIX } from "../tools/xd-url";
import type { ToolUIStatus } from "../host/elements/status";
import { ExpandHint } from "../view/expand-hint";
import { ToolCard } from "../view/tool-card";
import { ToolHeader } from "../view/tool-header";
import { formatUsageRow } from "../overlays/usage-row";
import { chatTranscriptDisplayPreferences } from "./display-preferences";
import { internalReadTargetPredicate } from "./read-target";
import { canonicalizeMessage } from "./thinking-display";

/** A reactive read call in the compact consecutive-read transcript run. */
export interface ReadToolGroupToolItem {
	readonly kind: "tool";
	readonly model: ToolCallModel;
}

/** One completed model request nested below the read calls it settled. */
export interface ReadToolGroupUsageItem {
	readonly kind: "usage";
	readonly usage: Usage;
	readonly durationMs?: number;
	readonly ttftMs?: number;
	readonly timestamp?: number;
	readonly turnElapsed?: number;
}

/** Ordered transcript content for one uninterrupted grouped-read run. */
export type ReadToolGroupItem = ReadToolGroupToolItem | ReadToolGroupUsageItem;

export interface ReadToolGroupViewProps {
	/** Group-owned immutable updates keep the view live without replacing sibling transcript blocks. */
	readonly items: Accessor<readonly ReadToolGroupItem[]>;
	readonly expanded: Accessor<boolean>;
	/** Captured when the group is created, matching the persisted display preference. */
	readonly showContentPreview?: boolean;
}

/** Mutable lifecycle state shared by live and replay grouped-read ingress. */
export interface ReadToolGroupState {
	readonly items: Accessor<readonly ReadToolGroupItem[]>;
	readonly pending: ReadonlySet<string>;
	readonly toolCallIds: ReadonlySet<string>;
	/** All reads have returned, or the run was sealed; unretired groups can still accept new reads. */
	readonly settled: boolean;
	add(toolCallId: string, model: ToolCallModel, pending: boolean): void;
	settle(toolCallId: string): boolean;
	seal(): boolean;
	addUsage(item: ReadToolGroupUsageItem): void;
}

/** Create one identity-stable compact read run with immutable ordered item updates. */
export function createReadToolGroupState(): ReadToolGroupState {
	const [items, setItems] = createSignal<readonly ReadToolGroupItem[]>([]);
	const pending = new Set<string>();
	const toolCallIds = new Set<string>();
	let sealed = false;
	const settled = (): boolean => sealed || pending.size === 0;
	return {
		items,
		pending,
		toolCallIds,
		get settled() {
			return settled();
		},
		add(toolCallId, model, isPending) {
			toolCallIds.add(toolCallId);
			if (isPending) pending.add(toolCallId);
			setItems(current => [...current, { kind: "tool", model }]);
		},
		settle(toolCallId) {
			pending.delete(toolCallId);
			return settled();
		},
		seal() {
			sealed = true;
			return true;
		},
		addUsage(item) {
			setItems(current => [...current, item]);
		},
	};
}

type ReadToolSuffixResolution = {
	readonly from: string;
	readonly to: string;
};

type ReadDisplayPathSpec = {
	readonly path: string;
	readonly linkPath?: string;
};

type ReadDisplayContent = {
	readonly text: string;
	readonly startLine?: number;
	readonly lineNumbers?: readonly (number | null)[];
};

type ReadGroupDetails = {
	readonly suffixResolution?: ReadToolSuffixResolution;
	readonly displayPaths?: readonly ReadDisplayPathSpec[];
	readonly linkPath?: string;
	readonly conflictCount?: number;
	readonly displayContent?: ReadDisplayContent;
};

type ReadEntryStatus = "success" | "pending" | "warning" | "error";

type ReadGroupEntry = {
	readonly model: ToolCallModel;
	readonly path: string;
	readonly details: ReadGroupDetails;
	readonly status: ReadEntryStatus;
	readonly preview: boolean;
};

type ReadDisplayTarget = {
	readonly entry: ReadGroupEntry;
	readonly targetPath: string;
	readonly basePath: string;
	readonly linkPath?: string;
	readonly selector?: string;
};

type ReadSummaryRow = {
	readonly targetPath: string;
	readonly basePath: string;
	readonly targets: readonly ReadDisplayTarget[];
};

type ReadToolSpan = {
	readonly entries: readonly ReadGroupEntry[];
	readonly rows: readonly ReadSummaryRow[];
	readonly previews: readonly ReadGroupEntry[];
	readonly usages: readonly ReadToolGroupUsageItem[];
};

type ReadGroupLayout = {
	readonly rows: readonly ReadSummaryRow[];
	readonly spans: readonly ReadToolSpan[];
	readonly leadingUsages: readonly ReadToolGroupUsageItem[];
};

const COLLAPSED_PREVIEW_LINES = 3;
const URL_LIKE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

const READ_STATUS_RANK: Record<ReadEntryStatus, number> = {
	success: 0,
	pending: 1,
	warning: 2,
	error: 3,
};

/** Extract the read call's target path. `path` is canonical; `file_path` remains a tolerated legacy alias. */
function readArgsTarget(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	if (typeof args.file_path === "string") return args.file_path;
	return typeof args.path === "string" ? args.path : undefined;
}

export function readArgsHaveTarget(args: unknown): boolean {
	return readArgsTarget(args) !== undefined;
}

/**
 * A compact run contains filesystem, external URL, and xd-device reads. Other
 * internal resources remain standalone so their resolved content is visible.
 */
export function readArgsCollapseIntoGroup(args: unknown): boolean {
	const target = readArgsTarget(args);
	return target !== undefined && (target.startsWith(XD_URL_PREFIX) || !internalReadTargetPredicate?.(target));
}

type ReadUsageMessageContent = {
	readonly type: string;
	readonly id?: string;
	readonly name?: string;
	readonly arguments?: unknown;
	readonly text?: string;
	readonly thinking?: string;
};

/**
 * Return the compact read calls that can own a turn's usage row. A mixed-tool
 * turn or visible assistant content after a read retains a standalone row so
 * transcript ordering remains unambiguous.
 */
export function groupedReadUsageCallIds(message: {
	readonly content: readonly ReadUsageMessageContent[];
}): string[] | undefined {
	const toolCallIds: string[] = [];
	let sawToolCall = false;
	for (const content of message.content) {
		if (content.type === "toolCall") {
			if (!content.id || content.name !== "read" || !readArgsCollapseIntoGroup(content.arguments)) return undefined;
			sawToolCall = true;
			toolCallIds.push(content.id);
			continue;
		}
		if (
			sawToolCall &&
			(content.type === "image" ||
				(content.type === "text" && canonicalizeMessage(content.text)) ||
				(content.type === "thinking" && canonicalizeMessage(content.thinking)))
		) {
			return undefined;
		}
	}
	return toolCallIds.length > 0 ? toolCallIds : undefined;
}

function suffixResolution(value: unknown): ReadToolSuffixResolution | undefined {
	if (!isRecord(value) || typeof value.from !== "string" || typeof value.to !== "string") return undefined;
	return { from: value.from, to: value.to };
}

function displayPaths(details: Record<string, unknown>): readonly ReadDisplayPathSpec[] | undefined {
	if (!Array.isArray(details.displayReadTargets)) return undefined;
	const links = Array.isArray(details.displayReadTargetLinks) ? details.displayReadTargetLinks : [];
	const paths: ReadDisplayPathSpec[] = [];
	for (let index = 0; index < details.displayReadTargets.length; index++) {
		const raw = details.displayReadTargets[index];
		if (typeof raw !== "string") continue;
		const displayPath = raw.trim();
		if (!displayPath) continue;
		const link = links[index];
		paths.push({ path: displayPath, linkPath: typeof link === "string" && link.length > 0 ? link : undefined });
	}
	return paths.length > 0 ? paths : undefined;
}

function displayContent(value: unknown): ReadDisplayContent | undefined {
	if (!isRecord(value) || typeof value.text !== "string") return undefined;
	const lineNumbers = Array.isArray(value.lineNumbers)
		? value.lineNumbers.filter((line): line is number | null => typeof line === "number" || line === null)
		: undefined;
	return {
		text: value.text,
		startLine: typeof value.startLine === "number" && Number.isFinite(value.startLine) ? value.startLine : undefined,
		lineNumbers,
	};
}

function readDetails(model: ToolCallModel): ReadGroupDetails {
	const details = model.details;
	if (!isRecord(details)) return {};
	const source = isRecord(details.meta) && isRecord(details.meta.source) ? details.meta.source : undefined;
	const sourcePath = source?.type === "path" && typeof source.value === "string" ? source.value : undefined;
	const resolvedPath = typeof details.resolvedPath === "string" ? details.resolvedPath : undefined;
	const displayTarget = typeof details.displayTarget === "string" ? details.displayTarget : undefined;
	const conflicts =
		typeof details.conflictCount === "number" && details.conflictCount > 0 ? details.conflictCount : undefined;
	return {
		suffixResolution: suffixResolution(details.suffixResolution),
		displayPaths: displayPaths(details),
		linkPath: displayTarget ?? resolvedPath ?? sourcePath,
		conflictCount: conflicts,
		displayContent: displayContent(details.displayContent),
	};
}

function displayPathWithSuffixResolution(currentPath: string, resolution: ReadToolSuffixResolution): string {
	const currentSelector = splitPathAndSel(currentPath).sel;
	if (!currentSelector || splitPathAndSel(resolution.to).sel) return resolution.to;
	return `${resolution.to}:${currentSelector}`;
}

function readTargetLinkPath(basePath: string, entryLinkPath: string | undefined): string | undefined {
	return entryLinkPath ?? (path.isAbsolute(basePath) ? basePath : undefined);
}

function firstSelectorLine(selector: string | undefined): number | undefined {
	if (!selector) return undefined;
	for (const chunk of selector.split(":")) {
		if (chunk.toLowerCase() === "raw" || chunk.toLowerCase() === "conflicts") continue;
		try {
			const line = parseLineRanges(chunk)?.[0]?.startLine;
			if (line !== undefined && Number.isFinite(line)) return line;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function selectorChunkIsLineRangeList(chunk: string): boolean {
	try {
		return chunk.trim().length > 0 && parseLineRanges(chunk.trim()) !== null;
	} catch {
		return false;
	}
}

function nextTopLevelToken(input: string, start: number): string {
	let braceDepth = 0;
	for (let index = start; index < input.length; index++) {
		const ch = input[index];
		if (ch === "\\" && index + 1 < input.length) {
			index++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth === 0 && (ch === "," || ch === ";")) return input.slice(start, index);
	}
	return input.slice(start);
}

function commaContinuesLineRangeSelector(input: string, partStart: number, commaIndex: number): boolean {
	const currentPart = input.slice(partStart, commaIndex).trim();
	return (
		splitPathAndSel(currentPart).sel !== undefined &&
		selectorChunkIsLineRangeList(nextTopLevelToken(input, commaIndex + 1))
	);
}

function splitReadDisplayPathSpecs(rawPath: string): readonly string[] {
	const normalized = rawPath.trim();
	if (!normalized || URL_LIKE_RE.test(normalized)) return [rawPath];

	const parts: string[] = [];
	let braceDepth = 0;
	let partStart = 0;
	for (let index = 0; index < normalized.length; index++) {
		const ch = normalized[index];
		if (ch === "\\" && index + 1 < normalized.length) {
			index++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth !== 0 || (ch !== "," && ch !== ";")) continue;
		if (ch === "," && commaContinuesLineRangeSelector(normalized, partStart, index)) continue;
		parts.push(normalized.slice(partStart, index).trim());
		partStart = index + 1;
	}
	parts.push(normalized.slice(partStart).trim());
	const cleanParts = parts.filter(part => part.length > 0);
	return cleanParts.length > 1 && cleanParts.every(part => splitPathAndSel(part).sel !== undefined)
		? cleanParts
		: [rawPath];
}

function splitSelectorDisplayParts(selector: string | undefined): readonly (string | undefined)[] {
	if (!selector) return [undefined];
	const chunks = selector.split(":");
	if (chunks.length === 1) {
		if (!selectorChunkIsLineRangeList(selector) || !selector.includes(",")) return [selector];
		return selector
			.split(",")
			.map(chunk => chunk.trim())
			.filter(chunk => chunk.length > 0);
	}
	if (chunks.length === 2) {
		const left = chunks[0]!;
		const right = chunks[1]!;
		if (selectorChunkIsLineRangeList(left) && left.includes(",")) {
			return left
				.split(",")
				.map(chunk => chunk.trim())
				.filter(chunk => chunk.length > 0)
				.map(chunk => `${chunk}:${right}`);
		}
		if (selectorChunkIsLineRangeList(right) && right.includes(",")) {
			return right
				.split(",")
				.map(chunk => chunk.trim())
				.filter(chunk => chunk.length > 0)
				.map(chunk => `${left}:${chunk}`);
		}
	}
	return [selector];
}

function formatMergedSelectorParts(selectors: readonly string[]): string {
	if (selectors.length <= 3) return selectors.join(",");
	return `${selectors[0]},${selectors[1]},…,${selectors[selectors.length - 1]}`;
}

function entryFor(item: ReadToolGroupToolItem, showContentPreview: boolean): ReadGroupEntry {
	const details = readDetails(item.model);
	const originalPath = readArgsTarget(item.model.args) ?? "";
	const resolvedPath = details.suffixResolution
		? displayPathWithSuffixResolution(originalPath, details.suffixResolution)
		: originalPath;
	item.model.output.version();
	const hasTextPreview = details.displayContent !== undefined || item.model.output.text().length > 0;
	const hasVisibleImages = item.model.ui.showImages && item.model.images.length > 0;
	const status: ReadEntryStatus =
		item.model.phase !== "settled"
			? "pending"
			: item.model.outcome === "failed"
				? "error"
				: details.suffixResolution || (details.conflictCount ?? 0) > 0
					? "warning"
					: "success";
	return {
		model: item.model,
		path: resolvedPath,
		details,
		status,
		preview: (showContentPreview && hasTextPreview) || hasVisibleImages,
	};
}

function displayTargetsForEntries(entries: readonly ReadGroupEntry[]): readonly ReadDisplayTarget[] {
	const targets: ReadDisplayTarget[] = [];
	for (const entry of entries) {
		const paths: readonly ReadDisplayPathSpec[] =
			entry.details.displayPaths ??
			splitReadDisplayPathSpecs(entry.path).map(displayPath => ({ path: displayPath }));
		const useEntryLinkPath = paths.length === 1;
		for (const pathSpec of paths) {
			const split = splitPathAndSel(pathSpec.path);
			const linkPath = readTargetLinkPath(
				split.path,
				pathSpec.linkPath ?? (useEntryLinkPath ? entry.details.linkPath : undefined),
			);
			for (const selector of splitSelectorDisplayParts(split.sel)) {
				targets.push({
					entry,
					targetPath: selector ? `${split.path}:${selector}` : pathSpec.path,
					basePath: split.path,
					linkPath,
					selector,
				});
			}
		}
	}
	return targets;
}

function summaryRows(targets: readonly ReadDisplayTarget[]): readonly ReadSummaryRow[] {
	const selectorTargetsByBasePath = new Map<string, ReadDisplayTarget[]>();
	for (const target of targets) {
		if (!target.selector || !target.basePath) continue;
		const existing = selectorTargetsByBasePath.get(target.basePath);
		if (existing) existing.push(target);
		else selectorTargetsByBasePath.set(target.basePath, [target]);
	}

	const mergedTargets = new Map<ReadDisplayTarget, readonly ReadDisplayTarget[]>();
	for (const group of selectorTargetsByBasePath.values()) {
		if (group.length <= 1) continue;
		for (const target of group) mergedTargets.set(target, group);
	}

	const emitted = new Set<readonly ReadDisplayTarget[]>();
	const rows: ReadSummaryRow[] = [];
	for (const target of targets) {
		const merged = mergedTargets.get(target);
		if (merged) {
			if (!emitted.has(merged)) {
				rows.push({
					targetPath: `${target.basePath}:${formatMergedSelectorParts(
						merged.flatMap(candidate => (candidate.selector === undefined ? [] : [candidate.selector])),
					)}`,
					basePath: target.basePath,
					targets: merged,
				});
				emitted.add(merged);
			}
			continue;
		}
		rows.push({ targetPath: target.targetPath, basePath: target.basePath, targets: [target] });
	}
	return rows;
}

function buildLayout(items: readonly ReadToolGroupItem[], showContentPreview: boolean): ReadGroupLayout {
	const spans: ReadToolSpan[] = [];
	const leadingUsages: ReadToolGroupUsageItem[] = [];
	let tools: ReadToolGroupToolItem[] = [];
	let usages: ReadToolGroupUsageItem[] = [];

	const finishSpan = (): void => {
		if (tools.length === 0) return;
		const entries = tools.map(item => entryFor(item, showContentPreview));
		const rows = summaryRows(displayTargetsForEntries(entries));
		spans.push({ entries, rows, previews: entries.filter(entry => entry.preview), usages });
		tools = [];
		usages = [];
	};

	for (const item of items) {
		if (item.kind === "tool") {
			if (usages.length > 0) finishSpan();
			tools.push(item);
			continue;
		}
		if (tools.length === 0) leadingUsages.push(item);
		else usages.push(item);
	}
	finishSpan();
	return { rows: spans.flatMap(span => span.rows), spans, leadingUsages };
}

function statusForTargets(targets: readonly ReadDisplayTarget[]): ReadEntryStatus {
	let status: ReadEntryStatus = "success";
	for (const target of targets) {
		if (READ_STATUS_RANK[target.entry.status] > READ_STATUS_RANK[status]) status = target.entry.status;
	}
	return status;
}

function correctedFromForTargets(targets: readonly ReadDisplayTarget[]): string | undefined {
	for (const target of targets) {
		if (target.entry.details.suffixResolution) return target.entry.details.suffixResolution.from;
	}
	return undefined;
}

function conflictCountForTargets(targets: readonly ReadDisplayTarget[]): number | undefined {
	let conflicts = 0;
	for (const target of targets) conflicts = Math.max(conflicts, target.entry.details.conflictCount ?? 0);
	return conflicts > 0 ? conflicts : undefined;
}

function firstSelectorLineForTargets(targets: readonly ReadDisplayTarget[]): number | undefined {
	let line: number | undefined;
	for (const target of targets) {
		const candidate = firstSelectorLine(target.selector);
		if (candidate !== undefined && (line === undefined || candidate < line)) line = candidate;
	}
	return line;
}

function linkPathForTargets(targets: readonly ReadDisplayTarget[]): string | undefined {
	for (const target of targets) {
		if (target.linkPath) return target.linkPath;
	}
	return undefined;
}

function statusValue(status: ReadEntryStatus): ToolUIStatus {
	if (status === "error") return "error";
	if (status === "warning") return "warning";
	if (status === "pending") return "pending";
	return "success";
}

function ReadStatus(props: { readonly status: ReadEntryStatus }): JSX.Element {
	const { theme } = useTheme();
	return (
		<Show when={props.status !== "success"}>
			<span color={props.status === "error" ? "error" : props.status === "warning" ? "warning" : "dim"}>
				{props.status === "pending" ? theme().symbol("status.pending") : theme().status.error}
			</span>
		</Show>
	);
}

function ReadPathValue(props: {
	readonly value: string;
	readonly correctedFrom?: string;
	readonly conflictCount?: number;
	readonly line?: number;
	readonly linkPath?: string;
}): JSX.Element {
	const split = splitPathAndSel(props.value);
	const displayPath = shortenPath(split.sel ? split.path : props.value);
	const href = props.linkPath
		? fileUriForTerminal(props.linkPath, props.line === undefined ? undefined : { line: props.line }, TERMINAL.id)
		: undefined;
	return (
		<>
			<Show when={href} fallback={<span color={displayPath ? "accent" : "toolOutput"}>{displayPath || "…"}</span>}>
				<link href={href!}>
					<span color="accent">{displayPath || "…"}</span>
				</link>
			</Show>
			<Show when={split.sel}>
				<span color="accent">:{split.sel}</span>
			</Show>
			<Show when={props.correctedFrom}>
				<span color="dim"> (corrected from {shortenPath(props.correctedFrom!)})</span>
			</Show>
			<Show when={props.conflictCount && props.conflictCount > 0}>
				<span color="warning">
					{" "}
					(⚠ {props.conflictCount} conflict{props.conflictCount === 1 ? "" : "s"})
				</span>
			</Show>
		</>
	);
}

function ReadRowContent(props: { readonly row: ReadSummaryRow }): JSX.Element {
	return (
		<text grow={1} minWidth={1} wrap="word">
			<ReadPathValue
				value={props.row.targetPath}
				correctedFrom={correctedFromForTargets(props.row.targets)}
				conflictCount={conflictCountForTargets(props.row.targets)}
				line={firstSelectorLineForTargets(props.row.targets)}
				linkPath={linkPathForTargets(props.row.targets)}
			/>
		</text>
	);
}

function ReadUsage(props: {
	readonly item: ReadToolGroupUsageItem;
	readonly continuation?: boolean;
	readonly indent?: number;
}): JSX.Element {
	const { theme } = useTheme();
	const metrics = () =>
		formatUsageRow(
			props.item.usage,
			props.item.durationMs,
			props.item.ttftMs,
			props.item.timestamp,
			props.item.turnElapsed,
		);
	return (
		<Show
			when={props.continuation !== undefined}
			fallback={
				<text color="dim" wrap="word">
					{" ".repeat(props.indent ?? 6)}
					{metrics()}
				</text>
			}
		>
			<text color="dim" wrap="word">
				{" ".repeat(props.indent ?? 3)}
				{props.continuation ? theme().tree.vertical : " "}
				{"  "}
				{metrics()}
			</text>
		</Show>
	);
}

function ReadSummaryLine(props: {
	readonly row: ReadSummaryRow;
	readonly last: boolean;
	readonly usages?: readonly ReadToolGroupUsageItem[];
}): JSX.Element {
	const { theme } = useTheme();
	return (
		<stack>
			<row gap={1} wrap="continuation" continuationIndent={0}>
				<text shrink={0}>{"  "}</text>
				<text color="dim" shrink={0}>
					{props.last ? theme().tree.last : theme().tree.branch}
				</text>
				<Show when={statusForTargets(props.row.targets) !== "success"}>
					<text shrink={0}>
						<ReadStatus status={statusForTargets(props.row.targets)} />
					</text>
				</Show>
				<ReadRowContent row={props.row} />
			</row>
			<For each={props.usages}>{item => <ReadUsage item={item} continuation={!props.last} />}</For>
		</stack>
	);
}

function ReadCollapsedPreview(props: {
	readonly document: TextDocument;
	readonly language?: string;
	readonly lineNumbers?: boolean | readonly (number | null)[];
	readonly lineNumberStart?: number;
	readonly previewRows: Accessor<number>;
}): JSX.Element {
	const hiddenLines = createMemo(() => {
		props.document.version();
		return Math.max(0, props.document.lineCount() - props.previewRows());
	});
	return (
		<stack>
			<code
				document={props.document}
				language={props.language}
				lineNumbers={props.lineNumbers}
				lineNumberStart={props.lineNumberStart}
				endLine={props.previewRows()}
				wrap={false}
			/>
			<Show when={hiddenLines() > 0}>
				<row gap={1}>
					<text color="dim">{`… ${hiddenLines()} more line${hiddenLines() === 1 ? "" : "s"}`}</text>
					<ExpandHint hasMore />
				</row>
			</Show>
		</stack>
	);
}

function ReadResultImages(props: { readonly model: ToolCallModel }): JSX.Element {
	const { theme } = useTheme();
	return (
		<Show when={props.model.ui.showImages && props.model.images.length > 0}>
			<For each={props.model.images}>
				{image => (
					<image
						state={createImagePaintState({
							base64Data: image.data,
							mimeType: image.mimeType,
							theme: { fallbackStyle: theme().style("dim") },
							options: { imageKey: image.id ?? image.path ?? image.mimeType },
						})}
					/>
				)}
			</For>
		</Show>
	);
}

function ReadPreview(props: { readonly entry: ReadGroupEntry; readonly expanded: Accessor<boolean> }): JSX.Element {
	const details = createMemo(() => readDetails(props.entry.model));
	const content = createMemo(() => {
		const display = details().displayContent;
		if (display) return display.text;
		props.entry.model.output.version();
		return props.entry.model.output.text();
	});
	const document = createMemo(() => {
		const display = details().displayContent;
		return display ? createDocument(display.text) : props.entry.model.output;
	});
	const language = createMemo(() => getLanguageFromPath(splitPathAndSel(props.entry.path).path));
	const status = () => {
		const current = entryFor({ kind: "tool", model: props.entry.model }, true).status;
		return current === "success" ? "done" : statusValue(current);
	};
	const display = () => details().displayContent;
	const firstLine = createMemo(() => display()?.startLine);
	const lineNumbers = createMemo(() => display()?.lineNumbers ?? (firstLine() === undefined ? undefined : true));
	const isError = () => entryFor({ kind: "tool", model: props.entry.model }, true).status === "error";

	return (
		<ToolCard
			phase={props.entry.model.phase}
			outcome={props.entry.model.outcome}
			header={
				<ToolHeader
					status={status()}
					label={
						<>
							<span>Read </span>
							<ReadPathValue
								value={props.entry.path}
								correctedFrom={details().suffixResolution?.from}
								conflictCount={details().conflictCount}
								line={firstSelectorLine(splitPathAndSel(props.entry.path).sel)}
								linkPath={details().linkPath}
							/>
						</>
					}
				/>
			}
		>
			<stack gap={1}>
				<Show
					when={isError()}
					fallback={
						<Show
							when={props.expanded()}
							fallback={
								<ReadCollapsedPreview
									document={document()}
									language={language()}
									lineNumbers={lineNumbers()}
									lineNumberStart={firstLine()}
									previewRows={() =>
										props.entry.model.ui.allocation > 0
											? Math.min(COLLAPSED_PREVIEW_LINES, props.entry.model.ui.allocation)
											: COLLAPSED_PREVIEW_LINES
									}
								/>
							}
						>
							<code
								document={document()}
								language={language()}
								lineNumbers={lineNumbers()}
								lineNumberStart={firstLine()}
								wrap={false}
							/>
						</Show>
					}
				>
					<text color="error">{content() || "Unknown error"}</text>
				</Show>
				<ReadResultImages model={props.entry.model} />
			</stack>
		</ToolCard>
	);
}

function ReadSingleSummary(props: {
	readonly row: ReadSummaryRow;
	readonly usages: readonly ReadToolGroupUsageItem[];
}): JSX.Element {
	const { theme } = useTheme();
	const status = () => statusForTargets(props.row.targets);
	return (
		<stack>
			<text wrap="none" overflow="ellipsis">
				<span> </span>
				<Show when={status() !== "error"}>
					<span>{theme().format.bullet}</span>
					<span> </span>
				</Show>
				<ReadStatus status={status()} />
				<Show when={status() === "error"}>
					<span> </span>
				</Show>
				<span color="toolTitle">Read</span>
				<span> </span>
				<ReadPathValue
					value={props.row.targetPath}
					correctedFrom={correctedFromForTargets(props.row.targets)}
					conflictCount={conflictCountForTargets(props.row.targets)}
					line={firstSelectorLineForTargets(props.row.targets)}
					linkPath={linkPathForTargets(props.row.targets)}
				/>
			</text>
			<For each={props.usages}>{item => <ReadUsage item={item} />}</For>
		</stack>
	);
}

function ReadGroupHeader(props: { readonly count?: number }): JSX.Element {
	const { theme } = useTheme();
	return (
		<text wrap="none" overflow="ellipsis">
			<span> </span>
			<span>{theme().format.bullet}</span>
			<span> </span>
			<span color="toolTitle">Read</span>
			<Show when={props.count !== undefined && props.count > 1}>
				<span color="dim"> ({props.count})</span>
			</Show>
		</text>
	);
}

/**
 * One-row reactive read identity for a constrained transcript allocation.
 * Uses the grouped-read normalization path without previews, usage, or tree chrome.
 */
export function ReadToolGroupSummary(props: Pick<ReadToolGroupViewProps, "items">): JSX.Element {
	const layout = createMemo(() => buildLayout(props.items(), false));
	const rows = createMemo(() => layout().rows);
	const singleRow = createMemo(() => (rows().length === 1 ? rows()[0] : undefined));
	const status = createMemo(() =>
		rows().length === 0 ? "pending" : statusForTargets(rows().flatMap(row => row.targets)),
	);

	return (
		<row gap={1} recipe="tool.compact">
			<status value={statusValue(status())} />
			<text grow={1} minWidth={1} wrap="none" overflow="ellipsis">
				<span color="toolTitle">Read</span>
				<Show when={singleRow()}>
					<span> </span>
					<ReadPathValue
						value={singleRow()!.targetPath}
						correctedFrom={correctedFromForTargets(singleRow()!.targets)}
						conflictCount={conflictCountForTargets(singleRow()!.targets)}
						line={firstSelectorLineForTargets(singleRow()!.targets)}
						linkPath={linkPathForTargets(singleRow()!.targets)}
					/>
				</Show>
				<Show when={rows().length > 1}>
					<span color="dim"> ({rows().length})</span>
				</Show>
			</text>
		</row>
	);
}

/**
 * Consecutive file reads share one compact header and selector-aware tree;
 * only failed entries carry a status marker. Usage metrics follow the request that
 * settled them. Tool models and the ordered item accessor remain reactive, so
 * streamed paths, results, errors, and late usage rows update in place.
 */
export function ReadToolGroupView(props: ReadToolGroupViewProps): JSX.Element | null {
	const showContentPreview = () => props.showContentPreview ?? chatTranscriptDisplayPreferences.readToolResultPreview;
	const layout = createMemo(() => buildLayout(props.items(), showContentPreview()));
	const visibleRows = createMemo(() => layout().rows.filter(row => !row.targets.some(target => target.entry.preview)));
	const singleRow = createMemo(() => (layout().rows.length === 1 ? layout().rows[0] : undefined));
	const singleSpan = createMemo(() => (layout().spans.length === 1 ? layout().spans[0] : undefined));

	return (
		<Show when={layout().rows.length > 0} fallback={<ReadGroupHeader />}>
			<Show
				when={singleRow() && singleSpan() && singleSpan()!.previews.length === 0}
				fallback={
					<Show
						when={singleRow() && singleSpan() && singleSpan()!.previews.length > 0}
						fallback={
							<stack>
								<ReadGroupHeader count={layout().rows.length} />
								<For each={visibleRows()}>
									{(row, index) => {
										const span = () => layout().spans.find(candidate => candidate.rows.includes(row));
										const isLastInSpan = () =>
											span()
												?.rows.filter(candidate => !candidate.targets.some(target => target.entry.preview))
												.at(-1) === row;
										const usages = () =>
											isLastInSpan() && span()?.previews.length === 0 ? span()?.usages : undefined;
										return (
											<ReadSummaryLine
												row={row}
												last={index() === visibleRows().length - 1}
												usages={usages()}
											/>
										);
									}}
								</For>
								<For each={layout().spans}>
									{span => (
										<stack>
											<For each={span.previews}>
												{entry => <ReadPreview entry={entry} expanded={props.expanded} />}
											</For>
											<Show when={span.previews.length > 0}>
												<For each={span.usages}>{item => <ReadUsage item={item} />}</For>
											</Show>
										</stack>
									)}
								</For>
								<For each={layout().leadingUsages}>{item => <ReadUsage item={item} />}</For>
							</stack>
						}
					>
						<stack>
							<For each={singleSpan()!.previews}>
								{entry => <ReadPreview entry={entry} expanded={props.expanded} />}
							</For>
							<For each={singleSpan()!.usages}>{item => <ReadUsage item={item} />}</For>
						</stack>
					</Show>
				}
			>
				<ReadSingleSummary row={singleRow()!} usages={singleSpan()!.usages} />
			</Show>
		</Show>
	);
}
