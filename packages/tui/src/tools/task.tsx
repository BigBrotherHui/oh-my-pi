import type { Usage } from "@oh-my-pi/pi-ai";
import { isRecord, sanitizeText, formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import {
	createMemo,
	createEffect,
	createStore,
	reconcile,
	For,
	Show,
	useClock,
	useViewport,
	type Accessor,
	type JSX,
} from "../reactive";
import type { Theme, ThemeColor } from "../theme/theme";
import { useTheme } from "../theme/reactive";
import type { ActivitySummary, DeepReadonly, ToolViewDefinition, ToolViewProps } from "./view";
import { registerToolView } from "./registry";

import { ToolCard } from "../view/tool-card";
import { ToolHeader } from "../view/tool-header";
import { AgentTreeRowView } from "./agent-tree";
import { Section } from "../view/section";
import { ExpandHint } from "../view/expand-hint";
import { JsonTree } from "../view/json-tree";
import type { ToolUIStatus } from "../view/status-icon";
import { repairDoubleEncodedJsonString } from "./task-repair-args";
import { assembleYieldResult } from "./task-yield-assembly";
import {
	formatMoreItems,
	previewLine,
	wrapTextWithAnsi,
	previewWindowRows,
	replaceTabs,
	shortenPath,
	type ConfiguredThinkingLevel,
} from "../render/render-utils";
import { createDocument } from "../document/document";
import { getSubprocessToolRenderer, type SubprocessToolRenderer } from "./subprocess";
import {
	formatOutputInline,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
} from "./json-tree";

export { repairDoubleEncodedJsonString, assembleYieldResult };

import { stripGeneratedOutputNotice, stripRawOutputArtifactNotice, stripTrailingNotice } from "./output-meta";

const MAX_NESTED_TASK_RENDER_DEPTH = 8;
const COLLAPSED_AGENT_LIMIT = 4;

const BASH_WALL_TIME_NOTICE_RE = /^Wall time: \d+(?:\.\d+)? seconds$/u;
const BASH_EXIT_CODE_NOTICE_RE = /^Command exited with code -?\d+$/u;

function sanitizeRecentOutput(output: string): string {
	let text = sanitizeText(output).trimEnd();
	while (text) {
		const withoutArtifactNotice = stripRawOutputArtifactNotice(text).text;
		if (withoutArtifactNotice !== text) {
			text = withoutArtifactNotice;
			continue;
		}
		const withoutOutputNotice = stripGeneratedOutputNotice(text);
		if (withoutOutputNotice !== text) {
			text = withoutOutputNotice;
			continue;
		}
		const withoutRuntimeNotice = stripTrailingNotice(
			text,
			line => BASH_WALL_TIME_NOTICE_RE.test(line) || BASH_EXIT_CODE_NOTICE_RE.test(line),
		);
		if (withoutRuntimeNotice !== text) {
			text = withoutRuntimeNotice;
			continue;
		}
		break;
	}
	return text;
}

/** Display cap for a normalized one-line label (roster line, registry `displayName`, prompt field). */
export const LABEL_MAX = 80;

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";

/** Execution schema strictness requested for this subagent call. */
export type StructuredSubagentSchemaMode = "permissive" | "strict";

/** Origin of the schema selected for a structured subagent invocation. */
export type StructuredSubagentSchemaSource = "caller" | "agent" | "session" | "none";

/** Final validation state of a structured subagent invocation. */
export type StructuredSubagentValidationStatus = "valid" | "invalid" | "unavailable";

/** Parsed structured completion and validation metadata retained for display. */
export interface StructuredSubagentOutput {
	source: StructuredSubagentSchemaSource;
	mode: StructuredSubagentSchemaMode;
	status: StructuredSubagentValidationStatus;
	data?: unknown;
	error?: string;
}

/** Single task item. Fields are optional defensively: args stream in token by token. */
export interface TaskItem {
	name?: string;
	agent?: string;
	task?: string;
	tools?: string[];
	context?: string;
	label?: string;
	description?: string;
	advisor?: boolean;
	skills?: string[];
	model?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	effort?: "lo" | "med" | "hi";
	outputSchema?: unknown;
	schemaMode?: StructuredSubagentSchemaMode;
	cwd?: string;
	isolated?: boolean;
	apply?: boolean;
	merge?: "branch" | "commit";
}

/** Parameters accepted by the task tool. */
export interface TaskParams {
	name?: string;
	agent?: string;
	task?: string;
	tasks?: TaskItem[];
	tools?: string[];
	context?: string;
	label?: string;
	description?: string;
	advisor?: boolean;
	skills?: string[];
	model?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	effort?: "lo" | "med" | "hi";
	outputSchema?: unknown;
	schemaMode?: StructuredSubagentSchemaMode;
	cwd?: string;
	isolated?: boolean;
	apply?: boolean;
	merge?: "branch" | "commit";
}

/** Formats sanitized task identifiers as hierarchy breadcrumbs. */
export function formatTaskId(id: string): string {
	const sanitizedId = sanitizeText(id);
	const segments = sanitizedId.split(".");
	return segments.length < 2 ? sanitizedId : segments.join(">");
}

/** Dim `⟨agent⟩` badge for a non-default agent type; empty for the generic worker. */
export function agentTypeBadge(agent: string | undefined, theme?: Theme): string {
	const trimmed = agent?.trim();
	if (!trimmed || trimmed === "task") return "";
	const left = theme?.format.bracketLeft ?? "⟨";
	const right = theme?.format.bracketRight ?? "⟩";
	return `${left}${trimmed}${right}`;
}

function taskFirstLine(task: string | undefined): string {
	if (!task) return "";
	const first = task.split("\n").find(line => line.trim().length > 0) ?? "";
	return previewLine(sanitizeText(replaceTabs(first)).trim(), 64);
}

function orderProgressForDisplay(progress: readonly DeepReadonly<AgentProgress>[]): DeepReadonly<AgentProgress>[] {
	const finished: DeepReadonly<AgentProgress>[] = [];
	const unfinished: DeepReadonly<AgentProgress>[] = [];
	for (const p of progress) {
		(p.status === "pending" || p.status === "running" ? unfinished : finished).push(p);
	}
	finished.sort((a, b) => a.durationMs - b.durationMs || a.index - b.index);
	return finished.concat(unfinished);
}

function orderResultsForDisplay(results: readonly DeepReadonly<SingleResult>[]): DeepReadonly<SingleResult>[] {
	return [...results].sort((a, b) => a.durationMs - b.durationMs || a.index - b.index);
}

/** Normalizes free-form text to a bounded single-line label. */
export function oneLineLabel(text: string, max = LABEL_MAX): string {
	const oneLine = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	const codePoints = Array.from(oneLine);
	return codePoints.length > max ? `${codePoints.slice(0, Math.max(0, max - 1)).join("")}…` : oneLine;
}

/** A code review finding reported by the reviewer agent */
export interface ReviewFinding {
	title: string;
	body?: string;
	priority?: FindingPriority;
	file?: string;
	line?: number;
}

/** Review summary submitted by the reviewer agent */
export interface ReviewSummary {
	overall_correctness: "correct" | "incorrect";
	findings?: ReviewFinding[];
}

/** Structured review data extracted from reviewer agent */
export interface ReviewData {
	findings: ReviewFinding[];
	summary?: ReviewSummary;
}

/** Details extracted from a subagent `yield` tool call for final-result assembly and task rendering. */
export interface YieldItem {
	data?: unknown;
	error?: string;
	type?: string | string[];
	section?: string;
	schemaOverridden?: boolean;
	status?: string;
	useLastTurn?: boolean;
}

/** Progress tracking for a single agent */
export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	requests: number;
	tokens: number;
	contextTokens?: number;
	contextWindow?: number;
	cost: number;
	durationMs: number;
	modelOverride?: string | string[];
	modelRole?: string;
	resolvedModel?: string;
	resolvedModelIdentity?: string;
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	resolvedModelIsFallback?: boolean;
	advisor?: boolean;
	extractedToolData?: Record<string, unknown[]>;
	retryState?: {
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		errorMessage: string;
		startedAtMs: number;
	};
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
	inflightTaskDetails?: TaskToolDetails;
}

/** Result from a single agent execution */
export interface SingleResult {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;
	structuredOutput?: StructuredSubagentOutput;
	durationMs: number;
	tokens: number;
	requests: number;
	contextTokens?: number;
	contextWindow?: number;
	modelOverride?: string | string[];
	modelRole?: string;
	resolvedModel?: string;
	resolvedModelIdentity?: string;
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	resolvedModelIsFallback?: boolean;
	advisor?: boolean;
	error?: string;
	aborted?: boolean;
	abortReason?: string;
	usage?: Usage;
	outputPath?: string;
	isolated?: boolean;
	patchPath?: string;
	hasRootChanges?: boolean;
	branchName?: string;
	branchBaseSha?: string;
	nestedPatches?: NestedRepoPatch[];
	nestedPatchPaths?: string[];
	extractedToolData?: Record<string, unknown[]>;
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
	outputMeta?: { lineCount: number; charCount: number };
}

/** Tool details for TUI rendering */
export interface TaskToolDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
	totalDurationMs: number;
	usage?: Usage;
	outputPaths?: string[];
	progress?: AgentProgress[];
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "task";
	};
}

/** Patch and baseline metadata for an isolated nested repository. */
export interface NestedRepoPatch {
	relativePath: string;
	patch: string;
}

/** Severity level of a review finding. */
export type FindingPriority = "P0" | "P1" | "P2" | "P3";

/** Severity ordering, glyph, and color for a review finding. */
export interface FindingPriorityInfo {
	ord: 0 | 1 | 2 | 3;
	symbol: string;
	color: ThemeColor;
}

const PRIORITY_INFO: Record<FindingPriority, FindingPriorityInfo> = {
	P0: { ord: 0, symbol: "status.error", color: "error" },
	P1: { ord: 1, symbol: "status.warning", color: "warning" },
	P2: { ord: 2, symbol: "status.warning", color: "muted" },
	P3: { ord: 3, symbol: "status.info", color: "accent" },
};

/** Review severity levels in descending priority. */
export const PRIORITY_LABELS: FindingPriority[] = ["P0", "P1", "P2", "P3"];

/** Tests whether a value is a supported review severity. */
export function isFindingPriority(value: unknown): value is FindingPriority {
	return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

/** Returns display metadata for a review severity. */
export function getPriorityInfo(priority: FindingPriority): FindingPriorityInfo {
	return PRIORITY_INFO[priority] ?? { ord: 3, symbol: "status.info", color: "muted" };
}

/** Validated source location and content of a review finding. */
export interface FindingDetails {
	title: string;
	body?: string;
	priority: FindingPriority;
	file?: string;
	line?: number;
}

/** Validates and normalizes a persisted review finding. */
export function parseFindingDetails(value: unknown): FindingDetails | undefined {
	if (!isRecord(value)) return undefined;
	const title = typeof value.title === "string" ? value.title.trim() : "";
	if (!title) return undefined;

	const priority = isFindingPriority(value.priority)
		? value.priority
		: value.priority === 0
			? "P0"
			: value.priority === 1
				? "P1"
				: value.priority === 2
					? "P2"
					: value.priority === 3
						? "P3"
						: "P2";
	const body = typeof value.body === "string" ? value.body.trim() : undefined;
	const file =
		typeof value.file === "string"
			? value.file.trim()
			: typeof value.file_path === "string"
				? value.file_path.trim()
				: undefined;
	const line =
		typeof value.line === "number" && Number.isFinite(value.line)
			? value.line
			: typeof value.line_start === "number" && Number.isFinite(value.line_start)
				? value.line_start
				: undefined;
	return { title, body, priority, file, line };
}

/** SubmitReviewDetails - used for rendering review results from yield tool */
export interface SubmitReviewDetails {
	overall_correctness: "correct" | "incorrect";
	explanation?: string;
	confidence?: number;
	findings?: FindingDetails[];
}

/** Tests whether a persisted tool result carries a task snapshot. */
export function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	if (!isRecord(value)) return false;
	return Array.isArray(value.results) || Array.isArray(value.progress) || typeof value.totalDurationMs === "number";
}

/** Extracts agent identifiers from a task tool result or partial details snapshot. */
export function taskCardAgentIds(details: unknown): string[] {
	if (typeof details !== "object" || details === null) return [];
	const ids: string[] = [];
	const seen = new Set<unknown>();
	const pushId = (item: unknown): void => {
		if (typeof item !== "object" || item === null || !("id" in item)) return;
		const id = item.id;
		if (typeof id === "string" && id.length > 0 && !ids.includes(id)) ids.push(id);
	};
	const collectDetails = (value: unknown, depth: number): void => {
		if (typeof value !== "object" || value === null || depth > MAX_NESTED_TASK_RENDER_DEPTH) return;
		if (seen.has(value)) return;
		seen.add(value);
		if ("results" in value) collectList(value.results, depth);
		if ("progress" in value) collectList(value.progress, depth);
	};
	const collectList = (value: unknown, depth: number): void => {
		if (!Array.isArray(value)) return;
		for (const item of value) {
			pushId(item);
			if (typeof item !== "object" || item === null || seen.has(item)) continue;
			seen.add(item);
			if (
				"extractedToolData" in item &&
				item.extractedToolData &&
				typeof item.extractedToolData === "object" &&
				"task" in item.extractedToolData
			) {
				const tasks = item.extractedToolData.task;
				if (Array.isArray(tasks)) for (const task of tasks) collectDetails(task, depth + 1);
			}
			if ("inflightTaskDetails" in item && item.inflightTaskDetails) {
				collectDetails(item.inflightTaskDetails, depth + 1);
			}
		}
	};
	if ("progress" in details) collectList(details.progress, 0);
	if ("results" in details) collectList(details.results, 0);
	return ids;
}

export type TaskRow = string | JSX.Element;

export function TaskRows({ rows }: { rows: readonly TaskRow[]; theme?: Theme }): JSX.Element {
	return (
		<stack>
			<For each={rows}>{row => (typeof row === "string" ? <text>{row}</text> : row)}</For>
		</stack>
	);
}

function normalizeFindings(value: unknown): FindingDetails[] {
	if (!Array.isArray(value)) return [];
	const findings: FindingDetails[] = [];
	for (const item of value) {
		const finding = parseFindingDetails(item);
		if (finding) findings.push(finding);
	}
	return findings;
}

const MISSING_YIELD_WARNING_PREFIX = "SYSTEM WARNING: Subagent exited without calling yield tool";

/** Split the executor's missing-yield warning from the useful result text. */
function extractMissingYieldWarning(output: string): { warning?: string; rest: string } {
	const lines = sanitizeText(output).split("\n");
	const first = lines[0]?.trim() ?? "";
	if (!first.startsWith(MISSING_YIELD_WARNING_PREFIX)) return { rest: output };
	return {
		warning: first,
		rest: lines
			.slice(1)
			.join("\n")
			.replace(/^\s*\n+/u, ""),
	};
}

function parseOutputJson(text: string): unknown | undefined {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function normalizedTaskText(text: string | undefined): string {
	return sanitizeText(repairDoubleEncodedJsonString(text ?? "")).trim();
}

function taskLines(text: string | undefined): string[] {
	const normalized = normalizedTaskText(text);
	return normalized ? normalized.split("\n").map(replaceTabs) : [];
}

function nestedTaskDetails(value: unknown): readonly DeepReadonly<TaskToolDetails>[] {
	if (!Array.isArray(value)) return [];
	const details: DeepReadonly<TaskToolDetails>[] = [];
	for (const item of value) {
		if (isTaskToolDetails(item)) details.push(item);
	}
	return details;
}

function selectCollapsedAgentIds(
	ids: readonly string[],
	byId: Readonly<Record<string, NormalizedTaskAgent>>,
	hasFinalResults: boolean,
	limit: number,
): string[] {
	if (ids.length <= limit) return [...ids];
	if (!hasFinalResults) return ids.slice(Math.max(0, ids.length - limit));

	const selected = new Set<string>();
	for (const id of ids) {
		if (selected.size >= limit) break;
		const agent = byId[id];
		if (agent?.status === "error" || agent?.status === "warning" || agent?.status === "aborted") selected.add(id);
	}
	for (const id of ids) {
		if (selected.size >= limit) break;
		selected.add(id);
	}
	return ids.filter(id => selected.has(id));
}

function hiddenAgentSummary(ids: readonly string[], byId: Readonly<Record<string, NormalizedTaskAgent>>): string {
	let pending = 0;
	let running = 0;
	let done = 0;
	let failed = 0;
	let aborted = 0;
	for (const id of ids) {
		switch (byId[id]?.status) {
			case "pending":
				pending++;
				break;
			case "running":
				running++;
				break;
			case "done":
			case "success":
				done++;
				break;
			case "aborted":
				aborted++;
				break;
			case "error":
			case "warning":
				failed++;
				break;
		}
	}
	const parts: string[] = [];
	if (done > 0) parts.push(`${done} done`);
	if (running > 0) parts.push(`${running} running`);
	if (pending > 0) parts.push(`${pending} pending`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (aborted > 0) parts.push(`${aborted} aborted`);
	return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

/** Render static, but reactively updated, task/context markdown without recreating its document. */
function TaskMarkdown(props: { readonly text: string | undefined }): JSX.Element {
	const document = createDocument(normalizedTaskText(props.text));
	createEffect(() => {
		document.apply({ kind: "reset", text: normalizedTaskText(props.text) });
	});
	return <markdown document={document} color="muted" options={{ paddingX: 0 }} wrapAllowance={1} />;
}

function TaskOutput(props: {
	readonly output: string | undefined;
	readonly warning?: string;
	readonly expanded: boolean;
	readonly label?: string;
	readonly live?: boolean;
}): JSX.Element {
	const viewport = useViewport();
	const text = createMemo(() => sanitizeRecentOutput(props.output ?? "").trimEnd());
	const parsed = createMemo(() => parseOutputJson(text()));
	const lines = createMemo(() =>
		text()
			.split("\n")
			.map(line => previewLine(replaceTabs(line), 70)),
	);
	const limit = createMemo(() => (props.live ? previewWindowRows() : props.expanded ? 12 : 3));
	const shownLines = createMemo(() => lines().slice(0, limit()));
	const wrappedLines = createMemo(() =>
		shownLines().map(line => {
			const firstRows = wrapTextWithAnsi(line, Math.max(1, viewport().columns - 9));
			const [first = "", ...remaining] = firstRows;
			const rest = remaining.join(" ");
			return { first, remaining: rest ? wrapTextWithAnsi(rest, Math.max(1, viewport().columns - 5)) : [] };
		}),
	);

	return (
		<Show when={text().length > 0 || props.warning}>
			<stack gap={0}>
				<text>
					{"  "}
					<span color="dim">{props.label ?? "Output"}</span>
				</text>
				<stack gap={0}>
					<Show when={props.warning}>
						<row gap={1}>
							<status value="warning" />
							<text color="warning" wrap="none" overflow="ellipsis">
								{props.warning}
							</text>
						</row>
					</Show>
					<Show when={text().length > 0}>
						<Show
							when={parsed() !== undefined}
							fallback={
								<For each={wrappedLines()}>
									{line => (
										<stack gap={0}>
											<text>
												{"    "}
												<span color="dim">{line.first}</span>
											</text>
											<For each={line.remaining}>{remaining => <text color="dim">{remaining}</text>}</For>
										</stack>
									)}
								</For>
							}
						>
							<Show when={props.expanded} fallback={<text color="dim">{formatOutputInline(parsed())}</text>}>
								<JsonTree
									value={parsed()}
									maxDepth={JSON_TREE_MAX_DEPTH_EXPANDED}
									maxLines={JSON_TREE_MAX_LINES_EXPANDED}
									maxScalarLength={JSON_TREE_SCALAR_LEN_EXPANDED}
								/>
							</Show>
						</Show>
					</Show>
				</stack>
			</stack>
		</Show>
	);
}

/** Every historical child renderer remains responsible for its own rich PTY/image/document surface. */
function TaskCustomToolData(props: {
	readonly data: Readonly<Record<string, readonly unknown[]>> | undefined;
	readonly expanded: boolean;
	readonly settled: boolean;
}): JSX.Element {
	const theme = useTheme();
	const entries = createMemo(() => {
		const entries: Array<{
			name: string;
			values: readonly unknown[];
			renderer: SubprocessToolRenderer;
		}> = [];
		const data = props.data;
		if (!data) return entries;
		for (const name in data) {
			const values = data[name]!;
			if (name === "task" || name === "yield" || values.length === 0) continue;
			const renderer = getSubprocessToolRenderer(name);
			if (!renderer) continue;
			if (props.settled ? !renderer.renderFinal : !renderer.renderInline) continue;
			entries.push({ name, values, renderer });
		}
		return entries;
	});

	return (
		<For each={entries()}>
			{entry => {
				const shown = () => (props.expanded ? entry.values : entry.values.slice(-3));
				return (
					<stack gap={0}>
						<text color="dim">Tool: {entry.name}</text>
						<Show
							when={props.settled}
							fallback={<For each={shown()}>{value => entry.renderer.renderInline?.(value, theme.theme())}</For>}
						>
							{() => entry.renderer.renderFinal?.(Array.from(entry.values), theme.theme(), props.expanded)}
						</Show>
						<Show when={!props.settled && entry.values.length > shown().length}>
							<text color="dim">{formatMoreItems(entry.values.length - shown().length, "item")}</text>
						</Show>
					</stack>
				);
			}}
		</For>
	);
}

function hasCustomToolData(data: Readonly<Record<string, readonly unknown[]>> | undefined, settled: boolean): boolean {
	if (!data) return false;
	for (const name in data) {
		const values = data[name]!;
		if (name === "task" || name === "yield" || values.length === 0) continue;
		const renderer = getSubprocessToolRenderer(name);
		if (renderer && (settled ? renderer.renderFinal : renderer.renderInline)) return true;
	}
	return false;
}

interface TaskRetryState {
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly delayMs: number;
	readonly errorMessage: string;
	readonly startedAtMs: number;
}

interface TaskRetryFailure {
	readonly attempt: number;
	readonly errorMessage: string;
}

interface TaskReviewResultData {
	readonly summary: SubmitReviewDetails;
	readonly findings: readonly FindingDetails[];
}

interface TaskToolActivity {
	readonly name: string;
	readonly detail?: string;
	readonly startedAt?: number;
}
interface TaskFooterStats {
	readonly succeeded: number;
	readonly failed: number;
	readonly aborted: number;
	readonly mergeFailed: number;
	readonly requests: number;
	readonly durationMs: number;
}

/** Normalized agent entity for keyed reactive store. */
export interface NormalizedTaskAgent {
	readonly id: string;
	readonly index: number;
	readonly name: string;
	readonly agent: string;
	readonly status: ToolUIStatus;
	readonly task: string;
	readonly assignment?: string;
	readonly description?: string;
	readonly model?: string;
	readonly currentTool?: string;
	readonly currentToolArgs?: string;
	readonly currentToolStartMs?: number;
	readonly lastIntent?: string;
	readonly recentTools?: readonly { readonly tool: string; readonly args: string; readonly endMs: number }[];
	readonly recentOutput?: readonly string[];
	readonly toolCount?: number;
	readonly requests?: number;
	readonly tokens?: number;
	readonly contextTokens?: number;
	readonly contextWindow?: number;
	readonly cost?: number;
	readonly durationMs?: number;
	readonly thinkingLevel?: ConfiguredThinkingLevel;
	readonly advisor?: boolean;
	readonly error?: string;
	readonly aborted?: boolean;
	readonly abortReason?: string;
	readonly exitCode?: number;
	readonly output?: string;
	readonly truncated?: boolean;
	readonly retryState?: TaskRetryState;
	readonly retryFailure?: TaskRetryFailure;
	readonly nestedTasks?: readonly DeepReadonly<TaskToolDetails>[];
	readonly findings?: readonly FindingDetails[];
	readonly isolated?: boolean;
	readonly patchPath?: string;
	readonly hasRootChanges?: boolean;
	readonly branchName?: string;
	readonly nestedPatchPaths?: readonly string[];
	readonly reviewResult?: TaskReviewResultData;
	readonly yieldData?: unknown;
	readonly extractedToolData?: Readonly<Record<string, readonly unknown[]>>;
	readonly settled: boolean;
}

const REVIEWER_ARRAY_LABELS: ReadonlySet<string> = new Set(["findings"]);

interface RenderYieldItem {
	data?: unknown;
	type?: string | string[];
	status?: string;
	useLastTurn?: boolean;
}

function normalizeYieldData(value: unknown): RenderYieldItem[] {
	const source = Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
	const normalized: RenderYieldItem[] = [];
	for (const item of source) {
		if (!isRecord(item)) continue;
		const rawType = item.type;
		let type: string | string[] | undefined;
		if (typeof rawType === "string") {
			type = rawType;
		} else if (Array.isArray(rawType) && rawType.every(label => typeof label === "string")) {
			type = rawType;
		}
		normalized.push({
			data: item.data,
			type,
			status: typeof item.status === "string" ? item.status : undefined,
			useLastTurn: item.useLastTurn === true ? true : undefined,
		});
	}
	return normalized;
}

function getRenderYieldLabels(type: RenderYieldItem["type"]): string[] {
	if (typeof type === "string") return type.trim() ? [type.trim()] : [];
	if (!Array.isArray(type)) return [];
	return type.flatMap(label => (label.trim() ? [label.trim()] : []));
}

function formatYieldPreview(item: RenderYieldItem): string {
	if (item.data === undefined) return "last assistant turn";
	if (typeof item.data === "string") return previewLine(sanitizeText(item.data), 70);
	try {
		return previewLine(sanitizeText(JSON.stringify(item.data) ?? "null"), 70);
	} catch {
		return previewLine(sanitizeText(String(item.data)), 70);
	}
}

function renderTypedYieldSections(value: unknown, expanded: boolean): string[] {
	const typed = normalizeYieldData(value)
		.map(item => ({ item, labels: getRenderYieldLabels(item.type) }))
		.filter(({ labels }) => labels.length > 0);
	const displayCount = expanded ? typed.length : 3;
	const lines = typed.slice(-displayCount).map(({ item, labels }) => {
		const prefix = Array.isArray(item.type) ? "yield+" : "yield";
		return `${prefix}[${labels.join(", ")}]: ${formatYieldPreview(item)}`;
	});
	if (typed.length > displayCount) lines.push(formatMoreItems(typed.length - displayCount, "yield"));
	return lines;
}

function extractIncrementalReviewResult(
	items: readonly RenderYieldItem[],
): { summary: SubmitReviewDetails; findings: FindingDetails[] } | undefined {
	const assembled = assembleYieldResult(
		items.map(item => ({
			data: item.data,
			type: item.type,
			status: item.status === "aborted" ? "aborted" : item.status === "success" ? "success" : undefined,
			useLastTurn: item.useLastTurn,
		})),
		undefined,
		REVIEWER_ARRAY_LABELS,
	);
	if (!isRecord(assembled?.data)) return undefined;
	const correctness = assembled.data.overall_correctness;
	if (correctness !== "correct" && correctness !== "incorrect") return undefined;
	const explanation = typeof assembled.data.explanation === "string" ? assembled.data.explanation : undefined;
	const confidence = typeof assembled.data.confidence === "number" ? assembled.data.confidence : 1;
	return {
		summary: { overall_correctness: correctness, explanation, confidence },
		findings: normalizeFindings(assembled.data.findings),
	};
}

export function normalizeTaskAgents(
	args?: DeepReadonly<Partial<TaskParams>>,
	details?: DeepReadonly<Partial<TaskToolDetails>>,
): { ids: string[]; byId: Record<string, NormalizedTaskAgent> } {
	const ids: string[] = [];
	const byId: Record<string, NormalizedTaskAgent> = {};
	const addAgent = (agent: NormalizedTaskAgent): void => {
		if (!byId[agent.id]) ids.push(agent.id);
		byId[agent.id] = agent;
	};

	for (const result of orderResultsForDisplay(details?.results ?? [])) {
		const id = result.id || `agent-${result.index}`;
		const yields = normalizeYieldData(result.extractedToolData?.yield);
		const reviewResult = extractIncrementalReviewResult(yields);
		const findings = normalizeFindings(result.extractedToolData?.review);
		addAgent({
			id,
			index: result.index,
			name: id,
			agent: result.agent || "task",
			status: result.aborted ? "aborted" : result.exitCode !== 0 ? "error" : result.error ? "warning" : "done",
			task: result.task,
			assignment: result.assignment,
			description: result.description ? sanitizeText(result.description) : undefined,
			model:
				result.resolvedModelIdentity ??
				result.resolvedModel ??
				(typeof result.modelOverride === "string" ? result.modelOverride : undefined),
			lastIntent: result.lastIntent,
			requests: result.requests,
			tokens: result.tokens,
			contextTokens: result.contextTokens,
			contextWindow: result.contextWindow,
			cost: result.usage?.cost?.total,
			durationMs: result.durationMs,
			thinkingLevel: result.resolvedThinkingLevel,
			advisor: result.advisor,
			error: result.error,
			aborted: result.aborted,
			abortReason: result.abortReason ? sanitizeText(result.abortReason) : undefined,
			exitCode: result.exitCode,
			output: result.output,
			truncated: result.truncated,
			retryFailure: result.retryFailure,
			nestedTasks: nestedTaskDetails(result.extractedToolData?.task),
			findings: findings.length > 0 ? findings : reviewResult?.findings,
			isolated: result.isolated,
			patchPath: result.patchPath,
			hasRootChanges: result.hasRootChanges,
			branchName: result.branchName,
			nestedPatchPaths: result.nestedPatchPaths,
			reviewResult,
			yieldData: result.extractedToolData?.yield,
			extractedToolData: result.extractedToolData,
			settled: true,
		});
	}

	for (const progress of orderProgressForDisplay(details?.progress ?? [])) {
		const id = progress.id || `agent-${progress.index}`;
		if (byId[id]) continue;
		const yields = normalizeYieldData(progress.extractedToolData?.yield);
		const reviewResult = extractIncrementalReviewResult(yields);
		const nestedTasks = [
			...nestedTaskDetails(progress.extractedToolData?.task),
			...(progress.inflightTaskDetails ? [progress.inflightTaskDetails] : []),
		];
		addAgent({
			id,
			index: progress.index,
			name: id,
			agent: progress.agent || "task",
			status:
				progress.status === "completed"
					? "done"
					: progress.status === "failed"
						? "error"
						: progress.status === "aborted"
							? "aborted"
							: progress.status,
			task: progress.task,
			assignment: progress.assignment,
			description: progress.description ? sanitizeText(progress.description) : undefined,
			model:
				progress.resolvedModelIdentity ??
				progress.resolvedModel ??
				(typeof progress.modelOverride === "string" ? progress.modelOverride : undefined),
			currentTool: progress.currentTool,
			currentToolArgs: progress.currentToolArgs,
			currentToolStartMs: progress.currentToolStartMs,
			lastIntent: progress.lastIntent,
			recentTools: progress.recentTools,
			recentOutput: progress.recentOutput,
			toolCount: progress.toolCount,
			requests: progress.requests,
			tokens: progress.tokens,
			contextTokens: progress.contextTokens,
			contextWindow: progress.contextWindow,
			cost: progress.cost,
			durationMs: progress.durationMs,
			thinkingLevel: progress.resolvedThinkingLevel,
			advisor: progress.advisor,
			retryState: progress.retryState,
			retryFailure: progress.retryFailure,
			nestedTasks,
			reviewResult,
			yieldData: progress.extractedToolData?.yield,
			extractedToolData: progress.extractedToolData,
			settled: false,
		});
	}

	if (ids.length === 0 && args && (!details || (details.results === undefined && details.progress === undefined))) {
		if (Array.isArray(args.tasks) && args.tasks.length > 0) {
			args.tasks.forEach((item, index) => {
				const id = item.name || `task-${index + 1}`;
				addAgent({
					id,
					index,
					name: id,
					agent: item.agent || "task",
					status: "pending",
					task: item.task || "",
					assignment: item.task,
					description: item.description,
					model: item.model,
					settled: false,
				});
			});
		} else if (args.name || args.task) {
			const id = args.name || "task";
			addAgent({
				id,
				index: 0,
				name: id,
				agent: args.agent || "task",
				status: "pending",
				task: args.task || "",
				assignment: args.task,
				description: args.description,
				model: args.model,
				settled: false,
			});
		}
	}

	return { ids, byId };
}

function TaskReviewResult(props: { readonly review: TaskReviewResultData; readonly expanded: boolean }): JSX.Element {
	const review = () => props.review;
	const correct = () => review().summary.overall_correctness === "correct";
	const orderedFindings = createMemo(() =>
		props.expanded
			? [...review().findings]
			: [...review().findings].sort(
					(left, right) => getPriorityInfo(left.priority).ord - getPriorityInfo(right.priority).ord,
				),
	);
	const shownFindings = createMemo(() => (props.expanded ? orderedFindings() : orderedFindings().slice(0, 3)));
	const findingCounts = createMemo(() => {
		const counts: Record<FindingPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
		for (const finding of review().findings) counts[finding.priority]++;
		return counts;
	});

	return (
		<stack gap={0}>
			<row gap={1}>
				<status value={correct() ? "success" : "error"} />
				<text color={correct() ? "success" : "error"}>Patch is {review().summary.overall_correctness}</text>
				<text color="dim">({((review().summary.confidence ?? 1) * 100).toFixed(0)}% confidence)</text>
			</row>
			<Show when={review().summary.explanation}>
				<Show
					when={props.expanded}
					fallback={<text color="dim">{previewLine(review().summary.explanation ?? "", 100)}</text>}
				>
					<Section label="Summary">
						<text color="dim">{replaceTabs(sanitizeText(review().summary.explanation ?? ""))}</text>
					</Section>
				</Show>
			</Show>
			<row gap={1}>
				<text color="dim">Findings:</text>
				<For each={PRIORITY_LABELS}>
					{priority => (
						<text color={getPriorityInfo(priority).color}>
							{priority}:{findingCounts()[priority]}
						</text>
					)}
				</For>
			</row>
			<Show when={shownFindings().length > 0}>
				<tree guides={true}>
					<For each={shownFindings()}>
						{finding => (
							<stack gap={0}>
								<row gap={1}>
									<badge color={getPriorityInfo(finding.priority).color}>{finding.priority}</badge>
									<text grow={1} minWidth={1} wrap="none" overflow="ellipsis">
										{sanitizeText(finding.title).replace(/^\[P\d\]\s*/u, "")}
									</text>
									<Show when={finding.file}>
										<text color="dim">
											{finding.file?.split("/").at(-1)}
											{finding.line ? `:${finding.line}` : ""}
										</text>
									</Show>
								</row>
								<Show when={props.expanded && finding.body}>
									<text color="dim">{replaceTabs(sanitizeText(finding.body ?? ""))}</text>
								</Show>
							</stack>
						)}
					</For>
				</tree>
				<Show when={review().findings.length > shownFindings().length}>
					<text color="dim">{formatMoreItems(review().findings.length - shownFindings().length, "finding")}</text>
				</Show>
			</Show>
		</stack>
	);
}

function TaskYieldRows(props: { readonly data: unknown; readonly expanded: boolean }): JSX.Element {
	const lines = createMemo(() => renderTypedYieldSections(props.data, props.expanded));
	return (
		<For each={lines()}>
			{line => (
				<row gap={1}>
					<text color="dim">{line}</text>
				</row>
			)}
		</For>
	);
}

/** Single agent card / row within the task card. */
export function TaskAgentCard(props: {
	readonly agent: NormalizedTaskAgent;
	readonly expanded?: boolean;
	readonly nowMs?: () => number;
	readonly depth?: number;
	readonly seen?: WeakSet<object>;
}): JSX.Element {
	const theme = useTheme();
	const viewport = useViewport();
	const agent = () => props.agent;
	const expanded = () => props.expanded ?? false;
	const compact = () => viewport().columns < 60;
	const fullDescription = createMemo(() => {
		const description = agent().description;
		return description ? replaceTabs(sanitizeText(description)).trim() : undefined;
	});
	const detail = createMemo(() => fullDescription() ?? taskFirstLine(agent().assignment ?? agent().task));
	const retryState = () => agent().retryState;
	const retryFailure = () => agent().retryFailure;
	const currentTool = createMemo<TaskToolActivity | undefined>(() => {
		const current = agent().currentTool;
		if (current)
			return {
				name: sanitizeText(current),
				detail: agent().lastIntent ?? agent().currentToolArgs,
				startedAt: agent().currentToolStartMs,
			};
		const recent = agent().recentTools?.[0];
		return recent ? { name: sanitizeText(recent.tool), detail: agent().lastIntent ?? recent.args } : undefined;
	});
	const missingYield = createMemo(() => extractMissingYieldWarning(agent().output ?? ""));
	const hasCustomData = createMemo(() => hasCustomToolData(agent().extractedToolData, agent().settled));
	const findings = createMemo(() => agent().findings ?? []);
	const recentOutput = createMemo(() => agent().recentOutput ?? []);
	const nestedTasks = createMemo(() => agent().nestedTasks ?? []);
	const errorText = createMemo(() => {
		const error = agent().error;
		return error && (!agent().aborted || error !== agent().abortReason)
			? previewLine(sanitizeText(error), 70)
			: undefined;
	});
	const taskPreviewRows = createMemo(() => {
		const preview = previewLine(taskLines(agent().assignment ?? agent().task).join(" "), 70);
		if (!preview) return { first: "", remaining: [] as string[] };
		if (!compact()) return { first: preview, remaining: [] as string[] };
		const [first = "", ...remaining] = preview.split(" ");
		return { first, remaining: wrapTextWithAnsi(remaining.join(" "), Math.max(1, viewport().columns - 4)) };
	});

	return (
		<box>
			<AgentTreeRowView
				presentation="task"
				overflow="clip"
				status={agent().status}
				id={formatTaskId(agent().id)}
				model={agent().model}
				thinkingLevel={agent().thinkingLevel}
				advisor={agent().advisor}
				role={agent().agent === "task" ? undefined : agent().agent}
				statusBadge={
					agent().status === "done"
						? "done"
						: agent().status === "warning"
							? "merge failed"
							: agent().status === "error"
								? "failed"
								: agent().status === "aborted"
									? "aborted"
									: retryState()
										? "retrying"
										: retryFailure()
											? "rate-limited"
											: undefined
				}
				statusBadgeColor={
					agent().status === "done"
						? "success"
						: agent().status === "warning"
							? "warning"
							: agent().status === "error" || agent().status === "aborted" || retryFailure()
								? "error"
								: retryState()
									? "warning"
									: undefined
				}
				description={compact() ? undefined : detail()}
				stats={{
					toolCount: agent().toolCount,
					requests: agent().requests,
					contextTokens: agent().contextTokens,
					contextWindow: agent().contextWindow,
					cost: compact() ? undefined : agent().cost,
				}}
				durationMs={compact() ? undefined : agent().durationMs}
			/>
			<Show when={compact() && detail()}>
				<text color="dim">
					{"  "}
					{detail()}
				</text>
			</Show>

			<Show when={expanded() && taskLines(agent().assignment ?? agent().task).length > 0}>
				<Section label="  Task">
					<Show
						when={compact()}
						fallback={
							<box padding={{ left: 4 }}>
								<preview
									items={taskLines(agent().assignment ?? agent().task).map(line => previewLine(line, 70))}
									edge="head"
									limit={20}
									unit="lines"
									color="dim"
								/>
							</box>
						}
					>
						<stack gap={0}>
							<text>
								{"    "}
								<span color="dim">{taskPreviewRows().first}</span>
							</text>
							<For each={taskPreviewRows().remaining}>{line => <text color="dim">{line}</text>}</For>
						</stack>
					</Show>
				</Section>
			</Show>

			<Show when={agent().status === "running" && currentTool()}>
				{(tool: Accessor<TaskToolActivity>) => {
					const activity = tool();
					const elapsed = () =>
						activity.startedAt && props.nowMs !== undefined
							? Math.max(0, props.nowMs() - activity.startedAt)
							: undefined;
					return (
						<row gap={1}>
							<text color="dim">{theme.theme().tree.hook}</text>
							<text color="muted" shrink={1} minWidth={1} wrap="none" overflow="ellipsis">
								{activity.name}
								{activity.detail ? `: ${previewLine(sanitizeText(activity.detail), 40)}` : ""}
							</text>
							<Show when={(elapsed() ?? 0) > 5000}>
								<text color="warning">{formatDuration(elapsed() ?? 0)}</text>
							</Show>
						</row>
					);
				}}
			</Show>
			<Show when={retryState() && agent().status === "running"}>
				{(state: Accessor<TaskRetryState>) => {
					const retry = state();
					const remaining = () => Math.max(0, retry.startedAtMs + retry.delayMs - (props.nowMs?.() ?? 0));
					return (
						<row gap={1}>
							<text color="dim">{theme.theme().tree.hook}</text>
							<text color="warning" shrink={1} minWidth={1} wrap="none" overflow="ellipsis">
								retrying {retry.attempt}/{retry.maxAttempts}{" "}
								{remaining() > 0 ? `in ${formatDuration(remaining())}` : "now"}:{" "}
								{previewLine(sanitizeText(retry.errorMessage), 60)}
							</text>
						</row>
					);
				}}
			</Show>
			<Show when={retryFailure() && agent().status !== "running"}>
				{(failure: Accessor<TaskRetryFailure>) => {
					const retry = failure();
					return (
						<row gap={1}>
							<text color="dim">{theme.theme().tree.hook}</text>
							<text color="error" shrink={1} minWidth={1} wrap="none" overflow="ellipsis">
								auto-retry gave up after {retry.attempt} attempt{retry.attempt === 1 ? "" : "s"}:{" "}
								{previewLine(sanitizeText(retry.errorMessage), 80)}
							</text>
						</row>
					);
				}}
			</Show>

			<Show
				when={agent().reviewResult}
				fallback={
					<>
						<Show when={agent().yieldData !== undefined}>
							<TaskYieldRows data={agent().yieldData} expanded={expanded()} />
						</Show>
						<Show when={findings().length > 0}>
							<Section label={`Findings: ${findings().length}`}>
								<tree guides={true}>
									<For each={expanded() ? findings() : findings().slice(0, 3)}>
										{finding => (
											<stack gap={0}>
												<row gap={1}>
													<badge color={getPriorityInfo(finding.priority).color}>{finding.priority}</badge>
													<text grow={1} minWidth={1} wrap="none" overflow="ellipsis">
														{sanitizeText(finding.title).replace(/^\[P\d\]\s*/u, "")}
													</text>
													<Show when={finding.file}>
														<text color="dim">
															{finding.file?.split("/").at(-1)}
															{finding.line ? `:${finding.line}` : ""}
														</text>
													</Show>
												</row>
												<Show when={expanded() && finding.body}>
													<text color="dim">{replaceTabs(sanitizeText(finding.body ?? ""))}</text>
												</Show>
											</stack>
										)}
									</For>
								</tree>
								<Show when={!expanded() && findings().length > 3}>
									<text color="dim">{formatMoreItems(findings().length - 3, "finding")}</text>
								</Show>
							</Section>
						</Show>
						<Show when={agent().extractedToolData && hasCustomData()}>
							<TaskCustomToolData
								data={agent().extractedToolData}
								expanded={expanded()}
								settled={agent().settled}
							/>
						</Show>
						<Show when={hasCustomData() && missingYield().warning}>
							<row gap={1}>
								<status value="warning" />
								<text color="warning" wrap="none" overflow="ellipsis">
									{missingYield().warning}
								</text>
							</row>
						</Show>
						<Show when={agent().settled && !hasCustomData()}>
							<TaskOutput output={missingYield().rest} warning={missingYield().warning} expanded={expanded()} />
						</Show>
						<Show when={!agent().settled && expanded() && recentOutput().length > 0}>
							<TaskOutput
								output={[...recentOutput()].reverse().join("\n")}
								expanded={expanded()}
								label="Recent output"
								live
							/>
						</Show>
						<Show when={nestedTasks().length > 0}>
							<tree guides={true}>
								<For each={nestedTasks()}>
									{details => (
										<NestedTaskCard
											details={details}
											expanded={expanded()}
											nowMs={props.nowMs}
											depth={(props.depth ?? 0) + 1}
											seen={props.seen}
										/>
									)}
								</For>
							</tree>
						</Show>
						<Show when={agent().patchPath && agent().hasRootChanges !== false}>
							<text color="dim" wrap="none" overflow="ellipsis">
								Patch: {shortenPath(replaceTabs(agent().patchPath ?? ""))}
							</text>
						</Show>
						<For each={agent().nestedPatchPaths ?? []}>
							{patch => (
								<text color="dim" wrap="none" overflow="ellipsis">
									Nested patch: {shortenPath(replaceTabs(patch))}
								</text>
							)}
						</For>
						<Show when={agent().branchName}>
							<text color="dim" wrap="none" overflow="ellipsis">
								Branch: {sanitizeText(agent().branchName ?? "")}
							</text>
						</Show>
						<Show when={agent().truncated}>
							<text color="warning">[truncated]</text>
						</Show>
						<Show when={agent().aborted && agent().abortReason}>
							<text color="error">{agent().abortReason}</text>
						</Show>
						<Show when={errorText()}>
							{(error: Accessor<string>) => (
								<text color={agent().exitCode === 0 ? "warning" : "error"} wrap="word">
									{"  "}
									{error()}
								</text>
							)}
						</Show>
					</>
				}
			>
				{(review: Accessor<TaskReviewResultData>) => <TaskReviewResult review={review()} expanded={expanded()} />}
			</Show>
		</box>
	);
}

function TaskCallRows(props: {
	readonly args: DeepReadonly<Partial<TaskParams>>;
	readonly expanded: boolean;
	readonly limit: number;
}): JSX.Element {
	const theme = useTheme();
	const sourceItems = createMemo(() => {
		if (Array.isArray(props.args.tasks) && props.args.tasks.length > 0) {
			return props.args.tasks.map((item, index) => ({
				id: item.name || `#${index + 1}`,
				agent: item.agent,
				task: item.task,
				isolated: item.isolated === true,
			}));
		}
		if (props.args.name || props.args.task) {
			return [
				{
					id: props.args.name || "agent",
					agent: props.args.agent,
					task: props.args.task,
					isolated: props.args.isolated === true,
				},
			];
		}
		return [];
	});
	const shown = createMemo(() => sourceItems().slice(0, props.expanded ? sourceItems().length : props.limit));

	return (
		<stack gap={0}>
			<For each={shown()}>
				{item => (
					<text wrap="word">
						<span color="dim">•</span> <span color="accent">{formatTaskId(item.id)}</span>
						<Show when={taskFirstLine(item.task)}>
							: <span color="muted">{taskFirstLine(item.task)}</span>
						</Show>
						<Show when={agentTypeBadge(item.agent, theme.theme())}>
							<span color="dim"> {agentTypeBadge(item.agent, theme.theme())}</span>
						</Show>
						<Show when={item.isolated}>
							<span color="dim"> [isolated]</span>
						</Show>
					</text>
				)}
			</For>
			<Show when={sourceItems().length > shown().length}>
				<text color="dim">{formatMoreItems(sourceItems().length - shown().length, "agent")}</text>
			</Show>
		</stack>
	);
}

/** Renders a nested TaskToolDetails node within a tree, with cycle/depth protection. */
export function NestedTaskCard(props: {
	readonly details: DeepReadonly<TaskToolDetails>;
	readonly expanded?: boolean;
	readonly nowMs?: () => number;
	readonly depth?: number;
	readonly seen?: WeakSet<object>;
}): JSX.Element {
	const depth = () => props.depth ?? 1;
	const seen = props.seen ?? new WeakSet<object>();
	if (seen.has(props.details)) return <text color="dim">… nested task progress already shown</text>;
	if (depth() >= MAX_NESTED_TASK_RENDER_DEPTH) return <text color="dim">… nested task depth limit reached</text>;
	seen.add(props.details);

	const normalized = createMemo(() => normalizeTaskAgents(undefined, props.details));
	const finalResults = createMemo(() => (props.details.results?.length ?? 0) > 0);
	const visibleIds = createMemo(() =>
		props.expanded
			? normalized().ids
			: selectCollapsedAgentIds(normalized().ids, normalized().byId, finalResults(), COLLAPSED_AGENT_LIMIT),
	);
	const hidden = createMemo(() => normalized().ids.slice(0, normalized().ids.length - visibleIds().length));

	return (
		<>
			<For each={visibleIds()}>
				{id => {
					const agent = normalized().byId[id];
					return agent ? (
						<TaskAgentCard
							agent={agent}
							expanded={props.expanded}
							nowMs={props.nowMs}
							depth={depth()}
							seen={seen}
						/>
					) : null;
				}}
			</For>
			<Show when={hidden().length > 0}>
				<text color="dim">
					{formatMoreItems(hidden().length, "agent")}
					{finalResults() ? "" : hiddenAgentSummary(hidden(), normalized().byId)}
				</text>
			</Show>
		</>
	);
}

/** Main reactive view for the task tool. */
export function TaskToolView(props: ToolViewProps<TaskParams, TaskToolDetails>): JSX.Element {
	const theme = useTheme();
	const [agentStore, setAgentStore] = createStore<{
		ids: string[];
		byId: Record<string, NormalizedTaskAgent>;
	}>({ ids: [], byId: {} });

	createEffect(() => {
		const normalized = normalizeTaskAgents(props.args, props.details);
		setAgentStore("ids", reconcile(normalized.ids));
		setAgentStore("byId", reconcile(normalized.byId));
	});

	const secondClock = useClock("second");
	const nowMs = createMemo(() => props.ui.frozenAt ?? secondClock());
	const hasFinalResults = createMemo(() => (props.details?.results?.length ?? 0) > 0);
	const hasExecutionSnapshot = createMemo(
		() => props.details?.results !== undefined || props.details?.progress !== undefined,
	);
	const collapsedLimit = createMemo(() => {
		const allocation = props.ui.allocation;
		if (allocation <= 0) return COLLAPSED_AGENT_LIMIT;
		return Math.max(1, Math.min(COLLAPSED_AGENT_LIMIT, allocation));
	});
	const visibleIds = createMemo(() =>
		props.ui.expanded
			? agentStore.ids
			: selectCollapsedAgentIds(agentStore.ids, agentStore.byId, hasFinalResults(), collapsedLimit()),
	);
	const hiddenIds = createMemo(() => agentStore.ids.slice(0, agentStore.ids.length - visibleIds().length));
	const headerStatus = createMemo<ToolUIStatus | undefined>(() => {
		if (props.phase === "receiving" || props.phase === "queued") return "pending";
		if (props.phase === "running") return undefined;
		if (props.outcome === "cancelled") return "aborted";
		if (props.outcome === "failed" || props.outcome === "timed_out") return "error";
		if (hasFinalResults()) {
			let mergeFailed = false;
			for (const result of props.details?.results ?? []) {
				if (result.aborted || result.exitCode !== 0) return "error";
				if (result.error) mergeFailed = true;
			}
			if (mergeFailed) return "warning";
		}
		return "done";
	});
	const footerStats = createMemo(() => {
		const results = props.details?.results;
		if (props.phase !== "settled" || !results || results.length === 0) return undefined;
		let succeeded = 0;
		let failed = 0;
		let aborted = 0;
		let mergeFailed = 0;
		let requests = 0;
		for (const result of results) {
			requests += result.requests ?? 0;
			if (result.aborted) aborted++;
			else if (result.exitCode !== 0) failed++;
			else if (result.error) mergeFailed++;
			else succeeded++;
		}
		return { succeeded, failed, aborted, mergeFailed, requests, durationMs: props.details?.totalDurationMs ?? 0 };
	});

	const content = (expanded: boolean): JSX.Element => {
		const noAgents = () => agentStore.ids.length === 0;
		const hasCallArguments = () =>
			Boolean(props.args.task) || Boolean(props.args.name) || Boolean(props.args.tasks?.length);
		const showCallRows = () => hasCallArguments() && (!hasExecutionSnapshot() || noAgents());
		const sharedContext = () => props.args.context;
		const assignment = () => (props.args.tasks?.length ? undefined : props.args.task);
		const nestedSeen = new WeakSet<object>();
		return (
			<stack gap={0}>
				<Show when={sharedContext()}>
					<Section label="Context">
						<TaskMarkdown text={sharedContext()} />
					</Section>
				</Show>
				<Show when={assignment()}>
					<TaskMarkdown text={assignment()} />
				</Show>
				<Show when={assignment() && (showCallRows() || visibleIds().length > 0)}>
					<hr variant="frame" />
				</Show>
				<Show when={showCallRows()}>
					<TaskCallRows args={props.args} expanded={expanded} limit={collapsedLimit()} />
				</Show>
				<Show when={!showCallRows() && hiddenIds().length > 0}>
					<stack gap={0}>
						<text color="dim">
							{formatMoreItems(hiddenIds().length, "agent")}
							{hasFinalResults() ? "" : hiddenAgentSummary(hiddenIds(), agentStore.byId)}
						</text>
						<ExpandHint expanded={expanded} hasMore={true} />
					</stack>
				</Show>
				<For each={showCallRows() ? [] : visibleIds()}>
					{id => {
						const agent = agentStore.byId[id];
						return agent ? (
							<TaskAgentCard agent={agent} expanded={expanded} nowMs={nowMs} seen={nestedSeen} />
						) : null;
					}}
				</For>
				<Show when={noAgents() && props.output.text().length > 0}>
					<TaskOutput
						output={props.output.text()}
						expanded={expanded}
						label={props.outcome === "failed" ? "Error" : "Output"}
					/>
				</Show>
				<Show
					when={
						noAgents() && !showCallRows() && !sharedContext() && !assignment() && props.output.text().length === 0
					}
				>
					<text color="dim">No active agents</text>
				</Show>
				<Show when={footerStats()}>
					{(footer: Accessor<TaskFooterStats>) => (
						<text>
							<span color="dim">{theme.theme().format.bracketLeft}</span>
							<Show when={footer().aborted > 0}>
								<span color="error">{footer().aborted} aborted</span>
								<span color="dim"> · </span>
							</Show>
							<Show when={footer().succeeded > 0}>
								<span color="success">{footer().succeeded} succeeded</span>
								<span color="dim"> · </span>
							</Show>
							<Show when={footer().mergeFailed > 0}>
								<span color="warning">{footer().mergeFailed} merge failed</span>
								<span color="dim"> · </span>
							</Show>
							<Show when={footer().failed > 0}>
								<span color="error">{footer().failed} failed</span>
								<span color="dim"> · </span>
							</Show>
							<Show when={footer().requests > 0}>
								<span color="dim">{formatNumber(footer().requests)} req · </span>
							</Show>
							<span color="dim">
								{formatDuration(footer().durationMs)}
								{theme.theme().format.bracketRight}
							</span>
						</text>
					)}
				</Show>
			</stack>
		);
	};

	return (
		<ToolCard
			phase={props.phase}
			outcome={props.outcome}
			framed={true}
			borderColor={headerStatus() === "error" ? "error" : "borderMuted"}
			expanded={props.ui.expanded}
			header={
				<ToolHeader
					status={hasExecutionSnapshot() ? undefined : props.phase === "settled" ? headerStatus() : undefined}
					label={
						hasExecutionSnapshot() ? (
							<>
								<status
									value={headerStatus() === "error" ? "error" : "done"}
									color={headerStatus() === "done" ? "accent" : undefined}
								/>{" "}
								<span color="accent">Task</span>
								<Show when={agentStore.ids.length > 0}>
									{" "}
									<span color="dim">
										{agentStore.ids.length} {agentStore.ids.length === 1 ? "agent" : "agents"}
									</span>
								</Show>
							</>
						) : (
							<>
								<icon name="tool.task" color="accent" /> <span color="accent">Task</span>:{" "}
								<span color="muted">{props.args.agent ?? "task"}</span>
							</>
						)
					}
				/>
			}
			summary={content(false)}
		>
			{content(true)}
		</ToolCard>
	);
}

/** Pure semantic activity summary for task tool. */
export function taskActivitySummary(props: ToolViewProps<TaskParams, TaskToolDetails>): ActivitySummary {
	const count = props.details?.results?.length ?? props.details?.progress?.length ?? props.args.tasks?.length ?? 1;
	let status: ToolUIStatus;
	if (props.phase !== "settled") {
		status = props.phase === "running" ? "running" : "pending";
	} else if (props.outcome === "cancelled") {
		status = "aborted";
	} else if (props.outcome === "failed" || props.outcome === "timed_out") {
		status = "error";
	} else {
		status = "done";
		for (const result of props.details?.results ?? []) {
			if (result.aborted || result.exitCode !== 0) {
				status = "error";
				break;
			}
			if (result.error) status = "warning";
		}
	}
	return {
		label: props.label || "Task",
		detail: `${count} agent${count === 1 ? "" : "s"}`,
		status,
	};
}

/** Renders settled child-task snapshots with bounded recursion and cycle detection. */
export function renderNestedTaskResults(
	detailsList: TaskToolDetails[],
	expanded = false,
	_theme?: Theme,
	seen: WeakSet<object> = new WeakSet<object>(),
	depth = 0,
): string[] {
	const lines: string[] = [];
	for (const details of detailsList) {
		if (seen.has(details)) {
			lines.push("… nested task progress already shown");
			continue;
		}
		if (depth >= MAX_NESTED_TASK_RENDER_DEPTH) {
			lines.push("… nested task depth limit reached");
			continue;
		}
		seen.add(details);
		const ordered = orderResultsForDisplay(details.results ?? []);
		const visible = expanded
			? ordered
			: ordered.filter((result, index) => index >= Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
		for (const result of visible) {
			const status = result.aborted ? "aborted" : result.exitCode !== 0 || result.error ? "failed" : "done";
			const role = agentTypeBadge(result.agent, _theme);
			lines.push(
				`• ${formatTaskId(result.id)}: ${taskFirstLine(result.description ?? result.task)}${role ? ` ${role}` : ""} [${status}]`,
			);
			if (Array.isArray(result.extractedToolData?.task)) {
				lines.push(
					...renderNestedTaskResults(
						result.extractedToolData.task.filter(isTaskToolDetails),
						expanded,
						_theme,
						seen,
						depth + 1,
					),
				);
			}
		}
		if (visible.length < ordered.length) lines.push(formatMoreItems(ordered.length - visible.length, "agent"));
		seen.delete(details);
	}
	return lines;
}

export function NestedTaskResultsView(props: {
	readonly detailsList: TaskToolDetails[];
	readonly expanded?: boolean;
}): JSX.Element {
	return (
		<tree guides={true}>
			<For each={props.detailsList}>{details => <NestedTaskCard details={details} expanded={props.expanded} />}</For>
		</tree>
	);
}

/** Reactive presentation definition for the task tool. */
export const taskToolView: ToolViewDefinition<TaskParams, TaskToolDetails> = {
	view: props => <TaskToolView {...props} />,
	summary: taskActivitySummary,
	framed: true,
};

registerToolView("task", taskToolView);
