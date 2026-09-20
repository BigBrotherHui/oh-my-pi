import { getProjectDir, isRecord } from "@oh-my-pi/pi-utils";
import {
	DEFAULT_TERMINAL_PREVIEW_LINES,
	formatToolWorkingDirectory,
	previewWindowRows,
	replaceTabs,
} from "../render/render-utils";
import { type OutputMeta } from "./output-meta";
import { decodeStreamingToolArgs } from "./argument-decoder";
import { ToolCard } from "../view/tool-card";
import { Notice } from "../view/notice";
import { TruncationNotice } from "../view/truncation-notice";
import type { ToolViewDefinition, ToolViewProps } from "./view";
import { registerToolView } from "./registry";
import { createEffect, createMemo, For, Show, useKeymap, useTheme, useViewport, type JSX } from "../reactive";
import type { ToolUIStatus } from "../host/elements/status";
import { createDocument } from "../document/document";

/** Default collapsed shell output preview height. */
export const BASH_DEFAULT_PREVIEW_LINES = DEFAULT_TERMINAL_PREVIEW_LINES;

/** LLM-facing footer appended when a tool call becomes a background job. */
export function formatBackgroundNotice(jobId: string): string {
	return `Backgrounded as job ${jobId}; result will be delivered automatically.`;
}

/** Shell execution metadata used by transcript rendering. */
export interface BashToolDetails {
	meta?: OutputMeta;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	timeoutDisabled?: boolean;
	wallTimeMs?: number;
	/** Exit code of a command that ran to completion but failed (non-zero). */
	exitCode?: number;
	/** True when the command was killed by its timeout deadline (not a failure). */
	timedOut?: boolean;
	/** Live ACP update only; completed results refer to released terminals. */
	terminalId?: string;
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "bash";
	};
}

function escapeBashEnvValueForDisplay(value: unknown): string {
	return String(value)
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("`", "\\`");
}

function formatBashEnvAssignments(env: Readonly<Record<string, unknown>> | undefined): string {
	if (!env || Object.keys(env).length === 0) return "";
	return Object.entries(env)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}="${escapeBashEnvValueForDisplay(value)}"`)
		.join(" ");
}

function formatWallTimeSeconds(wallTimeMs: number): string {
	return (wallTimeMs / 1000).toFixed(2);
}

/** Formats the model-facing command duration notice. */
export function formatWallTimeNotice(wallTimeMs: number): string {
	return `Wall time: ${formatWallTimeSeconds(wallTimeMs)} seconds`;
}

/** Formats the model-facing command exit status notice. */
export function formatExitCodeNotice(exitCode: number): string {
	return `Command exited with code ${exitCode}`;
}

/** Shell arguments used to build a command preview. */
export interface BashRenderArgs {
	command?: string;
	env?: Record<string, unknown>;
	timeout?: number;
	cwd?: string;
	[key: string]: unknown;
}

/** Mutable transcript viewport state for shell output. */
export interface BashRenderContext {
	/** Raw output text */
	output?: string;
	/** Whether output came from artifact storage */
	isFullOutput?: boolean;
	/** Whether output is expanded */
	expanded?: boolean;
	/** Number of preview lines when collapsed */
	previewLines?: number;
	/** Timeout in seconds */
	timeout?: number;
}

interface BashRenderInput {
	readonly command?: string;
	readonly env?: Readonly<Record<string, unknown>>;
	readonly timeout?: number;
	readonly cwd?: string;
}

/** Selects the decoded raw snapshot when an argument stream is available. */
function bashArgsForDisplay(args: BashRenderInput, rawArgs?: string): BashRenderInput {
	if (rawArgs === undefined) return args;
	const decoded = decodeStreamingToolArgs(rawArgs);
	return {
		command: typeof decoded.command === "string" ? decoded.command : undefined,
		env: isRecord(decoded.env) ? decoded.env : undefined,
		timeout: typeof decoded.timeout === "number" ? decoded.timeout : undefined,
		cwd: typeof decoded.cwd === "string" ? decoded.cwd : undefined,
	};
}

/** Reads environment assignments from the current argument snapshot. */
export function getBashEnvForDisplay(
	args: BashRenderInput,
	rawArgs?: string,
): Readonly<Record<string, unknown>> | undefined {
	return bashArgsForDisplay(args, rawArgs).env;
}

interface BashCommandDisplay {
	readonly command: string;
	readonly prefix: string;
	readonly lines: readonly string[];
}

/** Normalizes raw tool arguments into a plain command document and prompt prefix. */
function bashCommandDisplay(args: BashRenderInput, rawArgs?: string): BashCommandDisplay {
	const displayArgs = bashArgsForDisplay(args, rawArgs);
	const command = replaceTabs(displayArgs.command || "…");
	const displayWorkdir = formatToolWorkingDirectory(displayArgs.cwd, getProjectDir());
	const envAssignments = formatBashEnvAssignments(displayArgs.env);
	const prefixParts = ["$"];
	if (displayWorkdir) prefixParts.push(`cd ${displayWorkdir} &&`);
	if (envAssignments) prefixParts.push(envAssignments);
	return { command, prefix: `${prefixParts.join(" ")} `, lines: command.split("\n") };
}

/**
 * Format a shell command as the prompt/workdir/env prefix followed by
 * command rows. Only the first command row carries the prompt prefix.
 */
export function formatBashCommandLines(args: BashRenderInput, rawArgs?: string): string[] {
	const display = bashCommandDisplay(args, rawArgs);
	return display.lines.map((line, index) => (index === 0 ? `${display.prefix}${line}` : line));
}

function statusFrom(phase: string, outcome: string | undefined): ToolUIStatus {
	if (phase === "running") return "running";
	if (phase === "queued" || phase === "receiving") return "pending";
	if (outcome === "failed") return "error";
	if (outcome === "timed_out") return "warning";
	if (outcome === "cancelled") return "aborted";
	if (outcome === "skipped") return "info";
	return "success";
}

interface BashContentProps {
	readonly view: ToolViewProps<BashRenderArgs, BashToolDetails>;
	readonly expanded: boolean;
}

/** One historical bash card body, bound to either the compact or expanded slot. */
function BashContent(props: BashContentProps): JSX.Element {
	const keymap = useKeymap();
	const theme = useTheme();
	const viewport = useViewport();
	const rowBudget = createMemo(() => previewWindowRows(viewport().rows));

	const command = createMemo(() => bashCommandDisplay(props.view.args, props.view.rawArgs));
	const commandStartLine = createMemo(() => {
		if (props.expanded || command().lines.length <= rowBudget()) return 0;
		return Math.max(0, command().lines.length - (rowBudget() - 1));
	});
	const commandHidden = createMemo(() => commandStartLine());
	const commandDocument = createDocument(command().command);

	createEffect(() => {
		commandDocument.apply({ kind: "reset", text: command().command });
	});

	const showsOutput = createMemo(() => props.view.hasResult || props.view.phase === "settled");
	const outputLimit = createMemo(() =>
		props.expanded
			? Number.MAX_SAFE_INTEGER
			: Math.min(
					props.view.ui.allocation > 0 ? props.view.ui.allocation : BASH_DEFAULT_PREVIEW_LINES,
					BASH_DEFAULT_PREVIEW_LINES,
				),
	);
	const outputHiddenLabel = (hidden: number, _unit: string, shown: number, total: number) => {
		const activeTheme = theme.theme();
		const hint = `${activeTheme.format.bracketLeft}${keymap.hint("app.tools.expand")}: Expand${activeTheme.format.bracketRight}`;
		return `… (${hidden} earlier lines, showing ${shown} of ${total}) ${hint}`;
	};

	const timeoutDisabled = createMemo(
		() => props.view.details?.timeoutDisabled === true || props.view.args.timeout === 0,
	);
	const timeoutSeconds = createMemo(() =>
		timeoutDisabled()
			? undefined
			: (props.view.details?.timeoutSeconds ??
				(typeof props.view.args.timeout === "number" ? props.view.args.timeout : undefined)),
	);
	const timeoutText = createMemo(() => {
		if (timeoutDisabled()) return "Timeout: disabled";
		const seconds = timeoutSeconds();
		if (typeof seconds !== "number") return undefined;
		const requested = props.view.details?.requestedTimeoutSeconds;
		return requested !== undefined && requested !== seconds
			? `Timeout: ${seconds}s (requested ${requested}s clamped)`
			: `Timeout: ${seconds}s`;
	});

	const rawArtifactId = createMemo(() => {
		if (props.view.details?.meta?.truncation?.artifactId) return props.view.details.meta.truncation.artifactId;
		for (const notice of props.view.notices) {
			const match = /raw output: artifact:\/\/([a-zA-Z0-9_-]+)/iu.exec(notice.text);
			if (match) return match[1];
		}
		props.view.output.version();
		const match = /raw output: artifact:\/\/([a-zA-Z0-9_-]+)/iu.exec(props.view.output.text());
		return match?.[1];
	});

	const stats = createMemo(() => {
		const parts: string[] = [];
		const details = props.view.details;
		if (details?.async?.state === "running") parts.push(`Backgrounded: ${details.async.jobId}`);
		if (details?.wallTimeMs !== undefined) parts.push(`Wall: ${formatWallTimeSeconds(details.wallTimeMs)}s`);
		const timeout = timeoutText();
		if (timeout) parts.push(timeout);
		if (props.view.outcome === "failed" && typeof details?.exitCode === "number")
			parts.push(`Exit: ${details.exitCode}`);
		const artifact = rawArtifactId();
		if (artifact) parts.push(`Artifact: ${artifact}`);
		return parts;
	});

	const visibleNotices = createMemo(() =>
		props.view.notices.filter(notice => {
			if (
				notice.kind === "background" ||
				notice.kind === "wall-time" ||
				notice.kind === "exit-code" ||
				notice.kind === "truncated"
			) {
				return false;
			}
			if (/^raw output: artifact:\/\//iu.test(notice.text)) return false;
			return notice.text !== "Timed out" && notice.text !== "Cancelled";
		}),
	);

	const showsTruncation = createMemo(
		() =>
			(props.view.details?.meta?.truncation !== undefined ||
				props.view.details?.meta?.artifactError !== undefined) &&
			!(props.expanded && props.view.output.capture() === "complete"),
	);

	return (
		<>
			<Show when={commandHidden() > 0}>
				<text color="dim">
					… {commandHidden()} earlier {commandHidden() === 1 ? "line" : "lines"}{" "}
					<badge>{keymap.hint("app.tools.expand")}: Expand</badge>
				</text>
			</Show>
			<code
				document={commandDocument}
				language="bash"
				startLine={commandStartLine()}
				firstLinePrefix={() => <span color="dim">{command().prefix}</span>}
				wrap
			/>
			<Show when={showsOutput()}>
				<hr variant="frame" label="Output" />
				<preview
					document={props.view.output}
					color="toolOutput"
					edge="tail"
					limit={outputLimit()}
					unit="rows"
					ansi
					preserveSixel
					trimEnd
					reserveSummary={false}
					summaryWrap
					hiddenLabel={outputHiddenLabel}
				/>
				<Show when={stats().length > 0}>
					<text color="dim">
						{theme.theme().format.bracketLeft}
						{stats().join(" | ")}
						{theme.theme().format.bracketRight}
					</text>
				</Show>
				<Show when={showsTruncation()}>
					<TruncationNotice
						truncation={props.view.details?.meta?.truncation}
						source={props.view.details?.meta?.source}
						artifactError={props.view.details?.meta?.artifactError}
					/>
				</Show>
				<For each={visibleNotices()}>
					{notice => {
						const noticeStyle: { severity: "warning" | "error" | "muted"; status: ToolUIStatus } =
							notice.kind === "warning" || notice.kind === "truncated"
								? { severity: "warning", status: "warning" }
								: notice.kind === "exit-code"
									? { severity: "error", status: "error" }
									: { severity: "muted", status: "info" };
						return (
							<Notice status={noticeStyle.status} severity={noticeStyle.severity}>
								{notice.text}
							</Notice>
						);
					}}
				</For>
			</Show>
		</>
	);
}

/** Reactive presentation view for bash tool calls. */
export function BashView(props: ToolViewProps<BashRenderArgs, BashToolDetails>): JSX.Element {
	return (
		<ToolCard
			phase={props.phase}
			outcome={props.outcome}
			framed={true}
			expanded={props.ui.expanded}
			recipe={props.outcome === "timed_out" ? "tool.card.queued" : undefined}
			borderColor={props.outcome === "timed_out" ? "warning" : undefined}
			summary={<BashContent view={props} expanded={false} />}
		>
			<BashContent view={props} expanded={true} />
		</ToolCard>
	);
}

/** Reactive presentation definition for the bash tool. */
export const bashToolView: ToolViewDefinition<BashRenderArgs, BashToolDetails> = {
	view: props => <BashView {...props} />,
	summary(props) {
		return {
			label: "Bash",
			detail: props.args.command ? replaceTabs(props.args.command).trim() : undefined,
			status: statusFrom(props.phase, props.outcome),
		};
	},
	framed: true,
};

registerToolView("bash", bashToolView);
