import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { decodeStreamingToolArgs } from "./argument-decoder";
import { createEffect, createMemo, createSignal, For, Show, type Accessor, type JSX } from "../reactive";
import {
	DEFAULT_TERMINAL_PREVIEW_LINES,
	cappedHeadLines,
	formatDuration,
	replaceTabs,
	shortenPath,
	type ConfiguredThinkingLevel,
} from "../render/render-utils";
import { useTheme } from "../theme/reactive";
import type { Theme } from "../theme/theme";
import type { SymbolKey } from "../theme/symbols";
import { createImagePaintState } from "../components/image";
import { AgentTreeRowView } from "./agent-tree";
import { ToolCard } from "../view/tool-card";
import { Section } from "../view/section";
import { JsonTree } from "../view/json-tree";
import { TruncationNotice } from "../view/truncation-notice";
import { createDocument } from "../document/document";
import { formatEvalCodeForDisplay } from "./eval-format/index";
import {
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
} from "./json-tree";
import type { OutputMeta } from "./output-meta";
import { stripOutputNotice } from "./output-meta";
import type { ToolUIStatus } from "../host/elements/status";
import type { ToolViewDefinition, ToolViewProps } from "./view";
import { registerToolView } from "./registry";

/** Runtime backend that an eval cell dispatches to. */
export type EvalLanguage = "python" | "js";

/** Status event emitted by eval prelude helpers for TUI rendering. */
export interface EvalStatusEvent {
	op: string;
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	[key: string]: unknown;
}

export function upsertStatusEvent(events: EvalStatusEvent[], event: EvalStatusEvent): void {
	if (event.op === "agent" && typeof event.id === "string") {
		const index = events.findIndex(existing => existing.op === "agent" && existing.id === event.id);
		if (index >= 0) {
			events[index] = event;
			return;
		}
	}
	events.push(event);
}

/** Per-cell execution result for transcript rendering. */
export interface EvalCellResult {
	index: number;
	title?: string;
	code: string;
	language?: EvalLanguage;
	output: string;
	status: "pending" | "running" | "complete" | "error";
	durationMs?: number;
	exitCode?: number;
	statusEvents?: EvalStatusEvent[];
	hasMarkdown?: boolean;
}

/** Tool result detail object surfaced to the UI/transcript. */
export interface EvalToolDetails {
	cells?: EvalCellResult[];
	jsonOutputs?: unknown[];
	images?: ImageContent[];
	statusEvents?: EvalStatusEvent[];
	isError?: boolean;
	meta?: OutputMeta;
	language?: EvalLanguage;
	languages?: EvalLanguage[];
	notice?: string;
	async?: { state: "running" | "completed" | "failed"; jobId: string; type: "eval" };
}

/** Default collapsed eval output preview height; consumed by chat/tool-execution. */
export const EVAL_DEFAULT_PREVIEW_LINES: number = DEFAULT_TERMINAL_PREVIEW_LINES;

export interface EvalRenderCellArg {
	language?: string;
	code?: string;
	title?: string;
	timeout?: number;
	reset?: boolean;
}

export interface EvalRenderArgs {
	language?: string;
	code?: string;
	title?: string;
	timeout?: number;
	reset?: boolean;
	cells?: EvalRenderCellArg[];
}

export interface EvalRenderCell {
	language: EvalLanguage;
	code: string;
	title?: string;
}

type AgentEventStatus = "pending" | "running" | "completed" | "failed" | "aborted";

const STATUS_EVENT_ICONS: Record<string, SymbolKey> = {
	browser: "cmd.globe",
	computer: "cmd.computer",
	read: "icon.file",
	write: "icon.file",
	cat: "icon.file",
	touch: "icon.file",
	ls: "icon.folder",
	cd: "icon.folder",
	pwd: "icon.folder",
	mkdir: "icon.folder",
	git_status: "icon.git",
	git_diff: "icon.git",
	git_log: "icon.git",
	git_show: "icon.git",
	git_branch: "icon.git",
	git_file_at: "icon.git",
	git_has_changes: "icon.git",
	run: "icon.package",
	sh: "icon.package",
	env: "icon.package",
	batch: "icon.package",
	completion: "icon.package",
	tool_define: "icon.package",
	workpool: "icon.package",
	log: "icon.package",
	phase: "icon.package",
};

function normalizeLanguage(language: unknown): EvalLanguage {
	if (typeof language === "string") {
		const lower = language.trim().toLowerCase();
		if (lower === "python" || lower === "py") return "python";
		if (lower === "js" || lower === "javascript" || lower === "ts" || lower === "typescript") return "js";
	}
	return "python";
}

export function languageForHighlighter(language?: string): string {
	const normalized = language?.trim().toLowerCase();
	if (normalized === "js" || normalized === "javascript") return "javascript";
	if (normalized === "py" || normalized === "python") return "python";
	return normalized || "python";
}

function normalizeCell(raw: unknown): EvalRenderCell | undefined {
	if (!isRecord(raw) || typeof raw.code !== "string" || raw.code.length === 0) return undefined;
	return {
		language: normalizeLanguage(raw.language),
		code: raw.code,
		title: typeof raw.title === "string" ? raw.title : undefined,
	};
}

export function getRenderCells(args: unknown, rawArgs?: string): EvalRenderCell[] {
	const source = rawArgs === undefined ? args : decodeStreamingToolArgs(rawArgs);
	if (!isRecord(source)) return [];
	if (Array.isArray(source.cells) && source.cells.length > 0) {
		const normalized = source.cells.map(normalizeCell).filter((cell): cell is EvalRenderCell => cell !== undefined);
		if (normalized.length > 0) return normalized;
	}
	if (typeof source.code === "string" && source.code.length > 0) {
		return [
			{
				language: normalizeLanguage(source.language),
				code: source.code,
				title: typeof source.title === "string" ? source.title : undefined,
			},
		];
	}
	return [];
}

function plural(count: unknown, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function statusEventDescription(event: Readonly<EvalStatusEvent>): string {
	const { op, ...data } = event;
	const parts: string[] = [];
	switch (op) {
		case "read":
			parts.push(`${data.chars ?? data.bytes ?? 0} chars`);
			if (data.path) parts.push(`from ${shortenPath(String(data.path))}`);
			break;
		case "write":
			parts.push(`${data.chars ?? data.bytes ?? 0} chars`);
			if (data.path) parts.push(`to ${shortenPath(String(data.path))}`);
			break;
		case "cat":
			parts.push(plural(data.files, "file"));
			parts.push(`${data.chars ?? 0} chars`);
			break;
		case "ls":
			parts.push(plural(data.count, "entry", "entries"));
			break;
		case "env":
			if (data.action === "set" || data.action === "get") {
				parts.push(`${data.action === "set" ? "set " : ""}${data.key}=${String(data.value ?? "").slice(0, 30)}`);
			} else {
				parts.push(plural(data.count, "variable"));
			}
			break;
		case "git_status": {
			if (data.clean) parts.push("clean");
			else {
				const values: string[] = [];
				if (data.staged) values.push(`${data.staged} staged`);
				if (data.modified) values.push(`${data.modified} modified`);
				if (data.untracked) values.push(`${data.untracked} untracked`);
				parts.push(values.join(", ") || "unknown");
			}
			if (data.branch) parts.push(`on ${data.branch}`);
			break;
		}
		case "git_log":
			parts.push(plural(data.commits, "commit"));
			break;
		case "git_diff":
			parts.push(plural(data.lines, "line"));
			if (data.staged) parts.push("(staged)");
			break;
		case "batch":
			parts.push(`${plural(data.files, "file")} processed`);
			break;
		case "completion":
			if (data.model) parts.push(String(data.model));
			if (data.tier && data.tier !== data.model) parts.push(`(${data.tier})`);
			parts.push(`${data.chars ?? 0} chars`);
			break;
		case "tool_define":
			parts.push(`${data.name}(${(Array.isArray(data.params) ? data.params : []).join(", ")})`);
			break;
		case "workpool":
			parts.push(`${data.action} ${data.pool}`);
			if (data.count !== undefined) parts.push(`${data.count} ${data.action === "create" ? "agent(s)" : "item(s)"}`);
			break;
		case "wc":
			parts.push(`${data.lines}L ${data.words}W ${data.chars}C`);
			break;
		case "cd":
		case "pwd":
		case "mkdir":
		case "touch":
			if (data.path) parts.push(shortenPath(String(data.path)));
			break;
		case "log":
			parts.push(String(data.message ?? ""));
			break;
		case "phase":
			parts.push(String(data.title ?? ""));
			break;
		default:
			if (data.detail !== undefined) parts.push(String(data.detail).slice(0, 80));
			if (data.count !== undefined) parts.push(String(data.count));
			if (data.path) parts.push(shortenPath(String(data.path)));
	}
	return parts.join(" · ");
}

function expandedStatusEventDetails(event: Readonly<EvalStatusEvent>): Array<{ text: string; color: "dim" | "text" }> {
	const { op, ...data } = event;
	const lines: Array<{ text: string; color: "dim" | "text" }> = [];
	const addItems = (items: unknown, max = 5, format = (value: unknown) => String(value)): void => {
		const values = Array.isArray(items) ? items : [];
		for (let index = 0; index < Math.min(values.length, max); index++)
			lines.push({ text: format(values[index]), color: "dim" });
		if (values.length > max) lines.push({ text: `… ${values.length - max} more`, color: "dim" });
	};
	const addPreview = (preview: unknown): void => {
		const bounded = cappedHeadLines(String(preview).split("\n"), 3);
		for (const line of bounded.lines) lines.push({ text: replaceTabs(line), color: "text" });
		if (bounded.hidden > 0) lines.push({ text: `… ${bounded.hidden} more lines`, color: "dim" });
	};
	if (op === "ls" && data.items) addItems(data.items);
	else if (op === "env" && data.keys) addItems(data.keys, 10);
	else if (op === "git_log" && data.entries) {
		addItems(data.entries, 5, entry => {
			if (!isRecord(entry)) return String(entry);
			return `${String(entry.sha ?? "")} ${String(entry.subject ?? "").slice(0, 50)}`.trimEnd();
		});
	} else if ((op === "git_status" || op === "git_branch") && (data.files || data.branches)) {
		addItems(data.files ?? data.branches);
	} else if (["read", "cat", "head", "tail", "git_diff", "sh"].includes(op) && data.preview) {
		addPreview(data.preview);
	}
	return lines;
}

function StatusEventLine(props: { event: Readonly<EvalStatusEvent>; last: boolean; theme: Theme }): JSX.Element {
	const dataError = props.event.error;
	const description = dataError ? String(dataError) : statusEventDescription(props.event);
	const branch = props.last ? props.theme.tree.last : props.theme.tree.branch;
	const iconKey = STATUS_EVENT_ICONS[props.event.op];
	const icon = iconKey ? props.theme.symbol(iconKey) : props.theme.symbol("icon.file");
	const separator = dataError ? ": " : description ? " " : "";
	return (
		<text wrap="none">
			<span color="dim">{branch} </span>
			<span color="muted">{icon} </span>
			<span color={dataError ? "warning" : "muted"}>{props.event.op}</span>
			{separator}
			{description ? <span color="dim">{description}</span> : null}
		</text>
	);
}

function StatusEventsView(props: {
	events: Accessor<readonly Readonly<EvalStatusEvent>[]>;
	expanded: Accessor<boolean>;
	previewRows: Accessor<number>;
	theme: Accessor<Theme>;
}): JSX.Element {
	const max = () => (props.expanded() ? Math.max(10, props.previewRows()) : 3);
	const hidden = () => Math.max(0, props.events().length - max());
	const visible = () => (hidden() > 0 ? props.events().slice(hidden()) : props.events());
	return (
		<Show when={props.events().length > 0}>
			<stack>
				<Show when={hidden() > 0}>
					<text color="dim">
						{props.theme().tree.branch} … {hidden()} earlier
					</text>
				</Show>
				<For each={visible()}>
					{(event, index) => {
						const last = () => index() === visible().length - 1;
						const details = expandedStatusEventDetails(event);
						return (
							<stack>
								<StatusEventLine event={event} last={last()} theme={props.theme()} />
								<Show when={props.expanded() && details.length > 0}>
									<For each={details}>
										{detail => (
											<text wrap="none">
												<span color="dim">{last() ? " " : props.theme().tree.vertical} </span>
												<span color={detail.color}>{detail.text}</span>
											</text>
										)}
									</For>
								</Show>
							</stack>
						);
					}}
				</For>
			</stack>
		</Show>
	);
}

function agentEventStatus(status: unknown): AgentEventStatus {
	if (status === "running") return "running";
	if (status === "completed") return "completed";
	if (status === "failed") return "failed";
	if (status === "aborted") return "aborted";
	return "pending";
}

function eventString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function EvalAgentRow(props: {
	event: Readonly<EvalStatusEvent>;
	last: boolean;
	theme: Theme;
	frozen: boolean;
}): JSX.Element {
	const status = agentEventStatus(props.event.status);
	const currentTool = eventString(props.event.currentTool);
	const lastIntent = eventString(props.event.lastIntent);
	const taskPreview = !currentTool && !lastIntent ? eventString(props.event.taskPreview) : undefined;
	const detail = lastIntent ?? eventString(props.event.currentToolArgs);
	const failed = status === "failed";
	const aborted = status === "aborted";
	const continuation = props.last ? "   " : `${props.theme.tree.vertical}  `;
	const id = sanitizeText(eventString(props.event.id) ?? "agent").replace(/\s+/g, " ");
	const durationMs =
		status === "completed" || status === "failed" || status === "aborted"
			? eventNumber(props.event.durationMs)
			: undefined;

	return (
		<stack>
			<AgentTreeRowView
				presentation="eval"
				status={status}
				prefix={props.last ? props.theme.tree.last : props.theme.tree.branch}
				continuationPrefix={continuation}
				id={id}
				model={eventString(props.event.resolvedModelIdentity ?? props.event.model ?? props.event.resolvedModel)}
				thinkingLevel={props.event.resolvedThinkingLevel}
				advisor={props.event.advisor === true}
				frozen={props.frozen}
				statusBadge={failed ? "failed" : aborted ? "aborted" : undefined}
				statusBadgeColor={failed ? "error" : aborted ? "warning" : undefined}
				detail={taskPreview ? replaceTabs(taskPreview) : undefined}
				stats={{
					toolCount: eventNumber(props.event.toolCount),
					contextTokens: eventNumber(props.event.contextTokens),
					contextWindow: eventNumber(props.event.contextWindow),
					cost: eventNumber(props.event.cost),
				}}
				durationMs={durationMs}
			/>
			<Show when={status === "running" && (currentTool || lastIntent)}>
				<rail
					prefix={
						<span color="dim">
							{continuation}
							{props.theme.tree.hook}{" "}
						</span>
					}
					rest={
						<span color="dim">
							{continuation}
							{props.theme.tree.hook}{" "}
						</span>
					}
				>
					<text wrap="none">
						<span color={currentTool ? "muted" : "dim"}>{currentTool ?? lastIntent}</span>
						<Show when={currentTool && detail}>
							<span>: </span>
							<span color="dim">{detail}</span>
						</Show>
					</text>
				</rail>
			</Show>
		</stack>
	);
}

function AgentProgressView(props: {
	events: Accessor<readonly Readonly<EvalStatusEvent>[]>;
	theme: Accessor<Theme>;
	frozen: Accessor<boolean>;
}): JSX.Element {
	return (
		<stack>
			<For each={props.events()}>
				{(event, index) => {
					const last = () => index() === props.events().length - 1;
					return <EvalAgentRow event={event} last={last()} theme={props.theme()} frozen={props.frozen()} />;
				}}
			</For>
		</stack>
	);
}

function statusForCall(
	phase: ToolViewProps<EvalRenderArgs, EvalToolDetails>["phase"],
	outcome: ToolViewProps<EvalRenderArgs, EvalToolDetails>["outcome"],
): ToolUIStatus {
	if (phase === "receiving" || phase === "queued" || phase === "running") return "running";
	if (outcome === "failed" || outcome === "timed_out") return "error";
	if (outcome === "cancelled" || outcome === "skipped") return "aborted";
	return "done";
}

function cellStatusToUI(status: EvalCellResult["status"], aborted: boolean): ToolUIStatus {
	if (aborted && status !== "complete") return "aborted";
	if (status === "complete") return "done";
	if (status === "error") return "error";
	if (status === "running") return "running";
	return "pending";
}

function cellPhase(status: ToolUIStatus): "queued" | "running" | "settled" {
	if (status === "pending") return "queued";
	if (status === "running") return "running";
	return "settled";
}

function cellOutcome(status: ToolUIStatus): "success" | "failed" | "cancelled" | undefined {
	if (status === "done") return "success";
	if (status === "error") return "failed";
	if (status === "aborted") return "cancelled";
	return undefined;
}

function OutputWindow(props: {
	expanded: Accessor<boolean>;
	rows: Accessor<number>;
	children: JSX.Element;
}): JSX.Element {
	const [viewport, setViewport] = createSignal({ offset: 0, totalRows: 0, height: 0, width: 0 });
	const hidden = () => Math.max(0, viewport().totalRows - viewport().height);

	return (
		<Show
			when={props.expanded()}
			fallback={
				<>
					<scroll
						height={Math.max(1, props.rows())}
						scrollbar="never"
						followTail
						shrinkToFit
						onViewport={next => setViewport(next)}
					>
						{props.children}
					</scroll>
					<Show when={hidden() > 0}>
						<text color="dim">… {hidden()} more lines (ctrl+o to expand)</text>
					</Show>
				</>
			}
		>
			{props.children}
		</Show>
	);
}

/** Shared preview owns ANSI filtering, sixel pass-through, and visual tail capping. */
function EvalOutput(props: {
	output: Accessor<string>;
	expanded: Accessor<boolean>;
	previewRows: Accessor<number>;
	error: Accessor<boolean>;
}): JSX.Element {
	const document = createDocument();

	createEffect(() => {
		const output = props.output();
		if (document.text() !== output) document.apply({ kind: "reset", text: output });
	});

	return (
		<Show
			when={props.expanded()}
			fallback={
				<preview
					document={document}
					edge="tail"
					limit={props.previewRows()}
					unit="rows"
					ansi
					preserveSixel
					trimEnd
					reserveSummary={false}
					color={props.error() ? "error" : "toolOutput"}
					hiddenLabel={hidden => `… ${hidden} more lines (ctrl+o to expand)`}
				/>
			}
		>
			<pre document={document} ansi color={props.error() ? "error" : "toolOutput"} wrap />
		</Show>
	);
}

function EvalMarkdownOutput(props: {
	output: Accessor<string>;
	expanded: Accessor<boolean>;
	previewRows: Accessor<number>;
}): JSX.Element {
	const document = createDocument();

	createEffect(() => {
		const output = props.output();
		if (document.text() !== output) document.apply({ kind: "reset", text: output });
	});

	return (
		<OutputWindow expanded={props.expanded} rows={props.previewRows}>
			<markdown document={document} />
		</OutputWindow>
	);
}

function EvalCellHeader(props: {
	language: Accessor<string>;
	title: Accessor<string | undefined>;
	index: Accessor<number | undefined>;
	total: Accessor<number | undefined>;
	status: Accessor<ToolUIStatus>;
	durationMs: Accessor<number | undefined>;
	theme: Accessor<Theme>;
}): JSX.Element {
	const live = () => props.status() === "pending" || props.status() === "running";
	const ordinal = () => {
		const total = props.total();
		const index = props.index();
		return total && total > 1 && index !== undefined ? `[${index + 1}/${total}]` : undefined;
	};
	return (
		<row gap={1}>
			<text shrink={0} style={props.theme().langIconStyle(props.language())}>
				{props.theme().getLangIcon(props.language())}
			</text>
			<status shrink={0} value={props.status()} />
			<Show when={live()}>
				<text shrink={0} color="muted">
					{props.status()}
				</text>
			</Show>
			<Show when={props.status() === "aborted"}>
				<text shrink={0} color="warning">
					aborted
				</text>
			</Show>
			<Show when={ordinal()}>
				<text shrink={0} color="accent">
					{ordinal()}
				</text>
			</Show>
			<text color="toolTitle" grow={0} shrink={1} minWidth={1} wrap="none" overflow="ellipsis">
				{props.title() ?? "Code"}
			</text>
			<Show when={props.durationMs() !== undefined}>
				<text shrink={0}>
					{"· "}
					<span color="dim">({formatDuration(props.durationMs()!)})</span>
				</text>
			</Show>
		</row>
	);
}

/** Render one eval code cell with its historical tail-window code preview. */
function EvalCodeCell(props: {
	code: Accessor<string>;
	language: Accessor<string>;
	index: Accessor<number | undefined>;
	total: Accessor<number | undefined>;
	title: Accessor<string | undefined>;
	status: Accessor<ToolUIStatus>;
	durationMs: Accessor<number | undefined>;
	expanded: Accessor<boolean>;
	previewRows: Accessor<number>;
	hasOutput: Accessor<boolean>;
	outputContent: Accessor<JSX.Element | undefined>;
	theme: Accessor<Theme>;
}): JSX.Element {
	const formatted = createMemo(() => formatEvalCodeForDisplay(props.code(), normalizeLanguage(props.language())));
	const hiddenCount = createMemo(() =>
		props.expanded() ? 0 : Math.max(0, formatted().split("\n").length - props.previewRows()),
	);
	const codeDocument = createDocument();

	createEffect(() => {
		const source = formatted();
		const hidden = hiddenCount();
		const next = hidden > 0 ? source.split("\n").slice(hidden).join("\n") : source;
		if (codeDocument.text() !== next) codeDocument.apply({ kind: "reset", text: next });
	});

	return (
		<ToolCard
			phase={cellPhase(props.status())}
			outcome={cellOutcome(props.status())}
			header={
				<EvalCellHeader
					language={props.language}
					index={props.index}
					total={props.total}
					title={props.title}
					status={props.status}
					durationMs={props.durationMs}
					theme={props.theme}
				/>
			}
		>
			<Show when={hiddenCount() > 0}>
				<text color="dim">
					… {hiddenCount()} earlier line{hiddenCount() === 1 ? "" : "s"} (ctrl+o to expand)
				</text>
			</Show>
			<code document={codeDocument} language={languageForHighlighter(props.language())} wrap />
			<Show when={props.hasOutput() && props.outputContent()}>{props.outputContent()}</Show>
		</ToolCard>
	);
}

interface EvalDisplayCell {
	readonly index: number;
	readonly title?: string;
	readonly code: string;
	readonly language?: EvalLanguage;
	readonly output: string;
	readonly status: EvalCellResult["status"];
	readonly durationMs?: number;
	readonly statusEvents?: readonly Readonly<EvalStatusEvent>[];
	readonly hasMarkdown?: boolean;
}

function CellOutputView(props: {
	cell: Accessor<EvalDisplayCell>;
	status: Accessor<ToolUIStatus>;
	events: Accessor<readonly Readonly<EvalStatusEvent>[]>;
	expanded: Accessor<boolean>;
	previewRows: Accessor<number>;
	theme: Accessor<Theme>;
}): JSX.Element {
	const hasMarkdown = () => props.cell().hasMarkdown && props.status() !== "error";

	return (
		<>
			<hr variant="frame" label="Output" />
			<Show
				when={hasMarkdown()}
				fallback={
					<EvalOutput
						output={() => props.cell().output}
						expanded={props.expanded}
						previewRows={props.previewRows}
						error={() => props.status() === "error"}
					/>
				}
			>
				<EvalMarkdownOutput
					output={() => props.cell().output}
					expanded={props.expanded}
					previewRows={props.previewRows}
				/>
			</Show>
			<Show when={props.events().length > 0}>
				<hr variant="frame" label="Status" />
				<StatusEventsView
					events={props.events}
					expanded={props.expanded}
					previewRows={props.previewRows}
					theme={props.theme}
				/>
			</Show>
		</>
	);
}

interface EvalImage {
	readonly data: string;
	readonly mimeType: string;
}

function EvalStreamingImages(props: { images: readonly EvalImage[]; showImages: boolean }): JSX.Element {
	const theme = useTheme();

	return (
		<Show when={props.showImages && props.images.length > 0}>
			<For each={props.images}>
				{image => (
					<image
						state={createImagePaintState({
							base64Data: image.data,
							mimeType: image.mimeType,
							theme: { fallbackStyle: theme.theme().style("dim") },
							options: { imageKey: `${image.mimeType}:${image.data.length}` },
						})}
					/>
				)}
			</For>
		</Show>
	);
}

function EvalView(props: ToolViewProps<EvalRenderArgs, EvalToolDetails>): JSX.Element {
	const themeAccess = useTheme();
	const currentTheme = () => themeAccess.theme();
	const cells = createMemo(() => props.details?.cells ?? []);
	const callCells = createMemo(() => getRenderCells(props.args, props.rawArgs));
	const jsonOutputs = createMemo(() => props.details?.jsonOutputs ?? []);
	const meta = createMemo(() => props.details?.meta);
	const notice = createMemo(() => props.details?.notice);
	const statusEvents = createMemo(() => props.details?.statusEvents ?? []);
	const streamingImages = createMemo(() => props.details?.images ?? []);
	const asyncJobId = createMemo(() =>
		props.details?.async?.state === "running" ? props.details.async.jobId : undefined,
	);
	const previewRows = createMemo(() =>
		props.ui.allocation > 0 ? Math.min(EVAL_DEFAULT_PREVIEW_LINES, props.ui.allocation) : EVAL_DEFAULT_PREVIEW_LINES,
	);
	const outcomeStatus = createMemo(() => statusForCall(props.phase, props.outcome));
	const isAborted = createMemo(() => props.outcome === "cancelled" || props.outcome === "skipped");
	const directOutput = createMemo(() => stripOutputNotice(props.output.text().trimEnd(), meta()).trimEnd());
	const directHasContent = createMemo(() => directOutput().length > 0 || statusEvents().length > 0);

	return (
		<stack>
			<Show
				when={cells().length > 0}
				fallback={
					<Show
						when={callCells().length > 0}
						fallback={
							<Show
								when={directHasContent()}
								fallback={
									<Show
										when={props.phase !== "settled"}
										fallback={
											<Show when={props.outcome === "cancelled" || props.outcome === "skipped"}>
												<text color="warning">(cancelled)</text>
											</Show>
										}
									>
										<text>
											<span color="accent">&gt;&gt;&gt; </span>
											<span color="toolTitle">…</span>
										</text>
									</Show>
								}
							>
								<stack>
									<Show when={directOutput().length > 0}>
										<EvalOutput
											output={directOutput}
											expanded={() => props.ui.expanded}
											previewRows={previewRows}
											error={() => outcomeStatus() === "error"}
										/>
									</Show>
									<Show when={statusEvents().length > 0}>
										<Section label="Status">
											<StatusEventsView
												events={statusEvents}
												expanded={() => props.ui.expanded}
												previewRows={previewRows}
												theme={currentTheme}
											/>
										</Section>
									</Show>
								</stack>
							</Show>
						}
					>
						<For each={callCells()}>
							{(cell, index) => (
								<EvalCodeCell
									code={() => cell.code}
									language={() => cell.language}
									index={index}
									total={() => callCells().length}
									title={() => cell.title}
									status={outcomeStatus}
									durationMs={() => undefined}
									expanded={() => props.ui.expanded}
									previewRows={previewRows}
									hasOutput={() => false}
									outputContent={() => undefined}
									theme={currentTheme}
								/>
							)}
						</For>
					</Show>
				}
			>
				<For each={cells()}>
					{(cell, index) => {
						const cellId = cell.index;
						const current = () => cells().find(candidate => candidate.index === cellId) ?? cell;
						const events = () => current().statusEvents ?? [];
						const agentEvents = () => events().filter(event => event.op === "agent");
						const otherEvents = () => {
							const agents = agentEvents();
							return agents.length > 0 ? events().filter(event => event.op !== "agent") : events();
						};
						const status = () => cellStatusToUI(current().status, isAborted());
						const output = (
							<CellOutputView
								cell={current}
								status={status}
								events={otherEvents}
								expanded={() => props.ui.expanded}
								previewRows={previewRows}
								theme={currentTheme}
							/>
						);

						return (
							<stack>
								<EvalCodeCell
									code={() => current().code}
									language={() => current().language ?? props.details?.language ?? "python"}
									index={index}
									total={() => cells().length}
									title={() => current().title}
									status={status}
									durationMs={() => current().durationMs}
									expanded={() => props.ui.expanded}
									previewRows={previewRows}
									hasOutput={() => current().output.length > 0 || otherEvents().length > 0}
									theme={currentTheme}
									outputContent={() => output}
								/>
								<Show when={agentEvents().length > 0}>
									<AgentProgressView
										events={agentEvents}
										theme={currentTheme}
										frozen={() => props.ui.frozenAt !== undefined}
									/>
								</Show>
							</stack>
						);
					}}
				</For>
			</Show>

			<Show when={streamingImages().length > 0 && (props.phase !== "settled" || props.images.length === 0)}>
				<EvalStreamingImages images={streamingImages()} showImages={props.ui.showImages} />
			</Show>

			<Show when={jsonOutputs().length > 0}>
				<For each={jsonOutputs()}>
					{(value, index) => (
						<stack>
							<Show when={jsonOutputs().length > 1}>
								<text color="dim">display[{index() + 1}]</text>
							</Show>
							<JsonTree
								value={value}
								maxDepth={props.ui.expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED}
								maxLines={props.ui.expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED}
								maxScalarLength={
									props.ui.expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED
								}
							/>
						</stack>
					)}
				</For>
			</Show>

			<Show when={props.phase === "settled" && typeof props.args.timeout === "number"}>
				<text color="dim">[Timeout: {props.args.timeout}s]</text>
			</Show>

			<Show when={notice()}>
				<text color="dim">[{notice()}]</text>
			</Show>

			<Show when={asyncJobId()}>
				<text color="dim">[Backgrounded: {asyncJobId()}]</text>
			</Show>

			<TruncationNotice
				truncation={meta()?.truncation}
				source={meta()?.source}
				artifactError={meta()?.artifactError}
			/>
		</stack>
	);
}

function evalSummary(props: ToolViewProps<EvalRenderArgs, EvalToolDetails>): {
	label: string;
	detail?: string;
	status: ToolUIStatus;
} {
	const cells = getRenderCells(props.args, props.rawArgs);
	const first = cells[0];
	const source = props.rawArgs === undefined ? props.args : decodeStreamingToolArgs(props.rawArgs);
	return {
		label: "eval",
		detail: first?.title ?? first?.language ?? normalizeLanguage(source.language),
		status: statusForCall(props.phase, props.outcome),
	};
}

export const evalToolView: ToolViewDefinition<EvalRenderArgs, EvalToolDetails> = {
	view: EvalView,
	summary: evalSummary,
	framed: true,
};

registerToolView("eval", evalToolView);
