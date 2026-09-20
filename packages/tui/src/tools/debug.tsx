import { createMemo, For, Show, type JSX } from "../reactive";
import { Style } from "../core/style";
import { PREVIEW_LIMITS, replaceTabs } from "../render/render-utils";
import { ExpandHint } from "../view/expand-hint";
import type { ToolUIStatus } from "../host/elements/status";
import type { ToolViewDefinition, ToolViewProps } from "./view";
import { registerToolView } from "./registry";

/** Display fields captured from a debugger session. */
export interface DebugSessionSnapshot {
	id: string;
	adapter: string;
	status: string;
	cwd: string;
	program?: string;
	stopReason?: string;
	frameName?: string;
	instructionPointerReference?: string;
	source?: { path?: string };
	line?: number;
	column?: number;
	needsConfigurationDone: boolean;
	exitCode?: number;
}

/** Debug execution metadata consumed by the transcript. */
export interface DebugToolDetails {
	action: string;
	success: boolean;
	snapshot?: DebugSessionSnapshot;
}

/** Debug arguments used to describe a pending request. */
export interface DebugRenderArgs {
	action?: string;
	program?: string;
	file?: string;
	line?: number;
	function?: string;
	expression?: string;
	command?: string;
	memory_reference?: string;
	instruction_reference?: string;
	data_id?: string;
	name?: string;
}

/** Formats a debugger stop location as a source path and coordinates. */
export function formatLocation(snapshot: DebugSessionSnapshot | undefined): string | null {
	if (!snapshot?.source?.path || snapshot.line === undefined) return null;
	return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ""}`;
}

/** Formats the debugger session snapshot for model and terminal output. */
export function formatSessionSnapshot(snapshot: DebugSessionSnapshot): string[] {
	const lines = [
		`Session ${snapshot.id}`,
		`Adapter: ${snapshot.adapter}`,
		`Status: ${snapshot.status}`,
		`CWD: ${snapshot.cwd}`,
	];
	if (snapshot.program) lines.push(`Program: ${snapshot.program}`);
	if (snapshot.stopReason) lines.push(`Stop reason: ${snapshot.stopReason}`);
	if (snapshot.frameName) lines.push(`Frame: ${snapshot.frameName}`);
	if (snapshot.instructionPointerReference) lines.push(`Instruction pointer: ${snapshot.instructionPointerReference}`);
	const location = formatLocation(snapshot);
	if (location) lines.push(`Location: ${location}`);
	if (snapshot.needsConfigurationDone)
		lines.push("Configuration: pending configurationDone; set breakpoints, then continue.");
	if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`);
	return lines;
}

function summarizeDebugCall(args: DebugRenderArgs): string {
	const action = args.action ? args.action.replaceAll("_", " ") : "request";
	if (args.program) return `${action} ${args.program}`;
	if (args.file && args.line !== undefined) {
		return `${action} ${args.file}:${args.line}`;
	}
	if (args.function) return `${action} ${args.function}`;
	if (args.expression) return `${action} ${args.expression}`;
	if (args.command) return `${action} ${args.command}`;
	if (args.memory_reference) return `${action} ${args.memory_reference}`;
	if (args.instruction_reference) return `${action} ${args.instruction_reference}`;
	if (args.data_id) return `${action} ${args.data_id}`;
	if (args.name) return `${action} ${args.name}`;
	return action;
}

function statusForDebugCall(props: ToolViewProps<DebugRenderArgs, DebugToolDetails>): ToolUIStatus {
	if (props.phase === "running") return "running";
	if (props.phase === "receiving" || props.phase === "queued") return "pending";
	if (props.outcome === "failed" || props.details?.success === false) return "error";
	if (props.outcome === "cancelled" || props.outcome === "skipped") return "aborted";
	return "success";
}

function borderColorFor(status: ToolUIStatus): "accent" | "dim" | "error" {
	if (status === "running" || status === "pending") return "accent";
	if (status === "error") return "error";
	return "dim";
}

interface DebugHeaderProps {
	readonly action: string;
	readonly status: ToolUIStatus;
}

/** Historical header: a debug symbol only on success, a lifecycle glyph otherwise. */
function DebugHeader(props: DebugHeaderProps): JSX.Element {
	return (
		<row gap={1} bold={false}>
			<Show when={props.status === "success"} fallback={<status value={props.status} />}>
				<icon name="tool.debug" color="accent" />
			</Show>
			<text wrap="none" overflow="clip">
				Debug {props.action}
			</text>
		</row>
	);
}

interface DebugCallProps {
	readonly action: string;
	readonly status: ToolUIStatus;
	readonly summary: string;
}

/** The unframed request row shown until the debugger supplies a result snapshot. */
function DebugCall(props: DebugCallProps): JSX.Element {
	return (
		<row gap={1}>
			<status value="pending" />
			<text grow={1} shrink={1} minWidth={1} wrap="none" overflow="clip">
				<span color="accent">Debug</span>
				<span>: </span>
				<span color="muted">{props.summary}</span>
			</text>
		</row>
	);
}

interface DebugResultProps {
	readonly view: ToolViewProps<DebugRenderArgs, DebugToolDetails>;
	readonly action: string;
	readonly status: ToolUIStatus;
}

/** Historical debugger result frame, retained for streaming updates and PTY output. */
function DebugResult(props: DebugResultProps): JSX.Element {
	const summaryLines = createMemo(() => {
		const snapshot = props.view.details?.snapshot;
		return snapshot ? formatSessionSnapshot(snapshot).map(replaceTabs) : [];
	});
	const outputLines = createMemo(() => {
		props.view.output.version();
		const text = props.view.output.text() || "No output";
		const raw = replaceTabs(text).split("\n");
		const limit = props.view.ui.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
		const displayed = raw.slice(0, limit);
		return {
			displayed,
			remaining: raw.length - displayed.length,
		};
	});
	return (
		<frame
			title={<DebugHeader action={props.action} status={props.status} />}
			titleInset={3}
			titleColor="text"
			titleBold={false}
			borderColor={borderColorFor(props.status)}
			backgroundBorder={false}
			paddingY={0}
			style={Style.NONE}
		>
			<Show when={summaryLines().length > 0}>
				<hr variant="frame" label="Session" />
				<For each={summaryLines()}>{line => <text>{line}</text>}</For>
			</Show>
			<hr variant="frame" label="Output" />
			<Show when={props.view.output.text().length > 0} fallback={<text>No output</text>}>
				<preview
					document={props.view.output}
					edge="head"
					endLine={props.view.ui.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES}
					limit={Number.MAX_SAFE_INTEGER}
					unit="rows"
					ansi
					reserveSummary={false}
				/>
			</Show>
			<Show when={outputLines().remaining > 0}>
				<text color="muted">
					… {outputLines().remaining} more lines <ExpandHint expanded={props.view.ui.expanded} hasMore />
				</text>
			</Show>
		</frame>
	);
}

/** Reactive view definition for the debug tool. */
export const debugToolView: ToolViewDefinition<DebugRenderArgs, DebugToolDetails> = {
	view: (props: ToolViewProps<DebugRenderArgs, DebugToolDetails>): JSX.Element => {
		const action = createMemo(() => (props.args.action ?? props.details?.action ?? "debug").replaceAll("_", " "));
		const status = createMemo(() => statusForDebugCall(props));
		const summary = createMemo(() => summarizeDebugCall(props.args));

		return (
			<Show when={props.hasResult} fallback={<DebugCall action={action()} status={status()} summary={summary()} />}>
				<DebugResult view={props} action={action()} status={status()} />
			</Show>
		);
	},

	summary: props => ({
		label: "Debug",
		detail: summarizeDebugCall(props.args),
		status: statusForDebugCall(props),
	}),
	framed: true,
};

registerToolView("debug", debugToolView);
