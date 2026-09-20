import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { ToolUIStatus } from "../host/elements/status";
import { createMemo, createSignal, For, Show, useClock, type JSX } from "../reactive";
import { formatMoreItems, pluralize, PREVIEW_LIMITS, replaceTabs } from "../render/render-utils";
import { Card } from "../view/card";
import { ToolHeader } from "../view/tool-header";

import { registerToolView } from "./registry";
import type { ActivitySummary, ToolViewDefinition, ToolViewProps } from "./view";

// =============================================================================
// Types
// =============================================================================

/** Lifecycle state of a todo item. */
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

/** Operation names accepted by the todo tool and echoed in successful result details. */
export type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view";

/** A task displayed within a todo phase. */
export interface TodoItem {
	content: string;
	status: TodoStatus;
	blocker?: string;
	details?: string;
	notes?: string[];
}

/** A named group of todo tasks. */
export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

/** A task that became complete in the latest update. */
export interface TodoCompletionTransition {
	phase: string;
	content: string;
}

/** Todo snapshot and transitions displayed after an operation. */
export interface TodoToolDetails {
	op?: TodoOperation;
	phases: TodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
}

const TODO_DESCRIPTION_MIN_OVERLAP = 6;

function normalizeForTodoMatch(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** Report whether `content` likely names the same work as any entry in descriptions. */
export function todoMatchesAnyDescription(content: string, descriptions: readonly string[]): boolean {
	const target = normalizeForTodoMatch(content);
	if (!target) return false;
	for (const desc of descriptions) {
		const candidate = normalizeForTodoMatch(desc);
		if (!candidate) continue;
		if (target === candidate) return true;
		if (target.length >= TODO_DESCRIPTION_MIN_OVERLAP && candidate.includes(target)) return true;
		if (candidate.length >= TODO_DESCRIPTION_MIN_OVERLAP && target.includes(candidate)) return true;
	}
	return false;
}

/** Whether a todo is settled: completed or deliberately abandoned. */
export function isClosedTodo<T extends { status: TodoStatus }>(task: T): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

function isActiveTodo<T extends { status: TodoStatus }>(task: T, isMatched: (task: T) => boolean): boolean {
	return task.status === "in_progress" || (task.status === "pending" && isMatched(task));
}

export interface CollapsedTodoSelection<T> {
	items: readonly T[];
	summary: string;
}

const COLLAPSED_CLOSED_CONTEXT = 1;

function selectWithinCap<T extends { status: TodoStatus }>(
	base: readonly T[],
	isMatched: (task: T) => boolean,
	cap: number,
): CollapsedTodoSelection<T> {
	if (base.length <= cap) return { items: base, summary: "" };

	const active = base.filter(task => isActiveTodo(task, isMatched));
	if (active.length > cap) {
		const hiddenActive = active.length - cap;
		return {
			items: active.slice(0, cap),
			summary: `… ${hiddenActive} more active ${pluralize("todo", hiddenActive)}`,
		};
	}

	const firstActiveIdx = active.length > 0 ? base.indexOf(active[0]!) : 0;
	const fill: T[] = [];
	for (let i = firstActiveIdx; i < base.length && active.length + fill.length < cap; i++) {
		const task = base[i]!;
		if (isActiveTodo(task, isMatched)) continue;
		fill.push(task);
	}
	const items = [...active, ...fill];
	const hidden = base.length - items.length;
	return { items, summary: hidden > 0 ? formatMoreItems(hidden, "todo") : "" };
}

/** Walking-viewport selection for a phase's collapsed todo preview. */
export function selectCollapsedTodos<T extends { status: TodoStatus }>(
	tasks: readonly T[],
	isMatched: (task: T) => boolean,
	cap: number,
): CollapsedTodoSelection<T> {
	const open = tasks.filter(task => !isClosedTodo(task));
	if (open.length === 0) return selectWithinCap(tasks, isMatched, cap);
	const lead = tasks.filter(isClosedTodo).slice(-COLLAPSED_CLOSED_CONTEXT);
	const selected = selectWithinCap(open, isMatched, cap);
	return { items: [...lead, ...selected.items], summary: selected.summary };
}

export type TodoRenderOp = {
	op?: string;
	task?: string;
	phase?: string;
	items?: string[];
};

export type TodoRenderArgs = TodoRenderOp & {
	ops?: TodoRenderOp[];
};

function normalizeTodoRenderOp(value: unknown): TodoRenderOp | undefined {
	if (!isRecord(value)) return undefined;
	const items = Array.isArray(value.items)
		? value.items.filter((item): item is string => typeof item === "string")
		: undefined;
	return {
		op: typeof value.op === "string" ? value.op : undefined,
		task: typeof value.task === "string" ? value.task : undefined,
		phase: typeof value.phase === "string" ? value.phase : undefined,
		items,
	};
}

/**
 * Normalize streaming/legacy render args to a flat op list. Accepts both the
 * single-operation shape and historical `{ ops: [...] }` batches, including
 * partially parsed streaming values.
 */
export function normalizeTodoArg(args: unknown): TodoRenderOp[] {
	if (!isRecord(args)) return [];
	if (Array.isArray(args.ops)) {
		return args.ops.flatMap(entry => {
			const normalized = normalizeTodoRenderOp(entry);
			return normalized === undefined ? [] : [normalized];
		});
	}
	const normalized = normalizeTodoRenderOp(args);
	return normalized?.op === undefined ? [] : [normalized];
}

const ROMAN_PAIRS: Array<[number, string]> = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

/** One-based ASCII roman numeral for display (I, II, III, IV, …). */
export function phaseRomanNumeral(oneBasedIndex: number): string {
	if (oneBasedIndex <= 0) return "";
	let out = "";
	let rem = oneBasedIndex;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

function forDisplay(text: string): string {
	return replaceTabs(sanitizeText(text));
}

/** Display-only phase header: `I. Foundation`. */
export function formatPhaseDisplayName(name: string, oneBasedIndex: number): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${forDisplay(name)}`;
}

interface TodoItemForDisplay {
	readonly content: string;
	readonly status: TodoStatus;
	readonly blocker?: string;
}

interface TodoPhaseForDisplay {
	readonly name: string;
	readonly tasks: readonly TodoItemForDisplay[];
}

interface TodoCompletionForDisplay {
	readonly phase: string;
	readonly content: string;
}

const EMPTY_COMPLETION_KEYS: ReadonlySet<string> = new Set();
const EMPTY_ACTIVE_TODO_DESCRIPTIONS: readonly string[] = [];

/**
 * Phases whose full task list reflects the latest update. With no signal, the
 * full plan remains visible so manual expansion and transcript replay preserve
 * the legacy view.
 */
function computeTouchedPhases(
	args: unknown,
	phases: readonly TodoPhaseForDisplay[],
	completedTasks: readonly TodoCompletionForDisplay[],
): ReadonlySet<string> | undefined {
	const touched = new Set<string>();

	for (const phase of phases) {
		if (phase.tasks.some(task => task.status === "in_progress")) touched.add(phase.name);
	}
	for (const task of completedTasks) touched.add(task.phase);

	for (const operation of normalizeTodoArg(args)) {
		if (operation.op === "init") {
			for (const phase of phases) touched.add(phase.name);
			break;
		}
		if (operation.phase) {
			const phase = phases.find(candidate => candidate.name === operation.phase);
			if (phase) touched.add(phase.name);
		}
		if (operation.task) {
			const phase = phases.find(candidate => candidate.tasks.some(task => task.content === operation.task));
			if (phase) touched.add(phase.name);
		}
	}

	return touched.size > 0 ? touched : undefined;
}

function operationMetadata(operations: readonly TodoRenderOp[]): string {
	const rendered = operations.map(operation => {
		const parts = [forDisplay(operation.op ?? "update")];
		if (operation.task) parts.push(forDisplay(operation.task));
		if (operation.phase) parts.push(forDisplay(operation.phase));
		if (operation.items && operation.items.length > 0) {
			parts.push(`${operation.items.length} item${operation.items.length === 1 ? "" : "s"}`);
		}
		return parts.join(" ").replace(/\r\n?|\n/g, " ");
	});
	return rendered.length === 0 ? "update" : rendered.join(" · ");
}

function todoStatus(props: ToolViewProps<TodoRenderArgs, TodoToolDetails>): ToolUIStatus {
	if (props.phase === "receiving" || props.phase === "queued") return "pending";
	if (props.phase === "running") return "running";
	if (props.outcome === "failed" || props.outcome === "timed_out") return "error";
	if (props.outcome === "cancelled" || props.outcome === "skipped") return "aborted";
	return "success";
}

function todoErrorDetail(raw: string): string {
	const text = forDisplay(raw.replace(/^Error:\s*/, "").trim());
	return text || "Unknown error";
}

/** Frames held before revealing a completion strike. */
export const TODO_STRIKE_HOLD_FRAMES = 2;

/** Frames used to reveal a completion strike. */
export const TODO_STRIKE_REVEAL_FRAMES = 12;

/** Total frames in the completion strike animation. */
export const TODO_STRIKE_TOTAL_FRAMES = TODO_STRIKE_HOLD_FRAMES + TODO_STRIKE_REVEAL_FRAMES;

export function strikeRevealCount(text: string, frame: number | undefined): number | undefined {
	if (frame === undefined) return undefined;
	if (frame <= TODO_STRIKE_HOLD_FRAMES) return 0;
	const chars = [...text];
	if (chars.length === 0) return undefined;
	const revealFrame = Math.min(frame - TODO_STRIKE_HOLD_FRAMES, TODO_STRIKE_REVEAL_FRAMES);
	return Math.ceil((chars.length * revealFrame) / TODO_STRIKE_REVEAL_FRAMES);
}

let activeTodoDescriptionsProvider: () => readonly string[] = () => [];

export function setActiveTodoDescriptionsProvider(provider: () => readonly string[]): void {
	activeTodoDescriptionsProvider = provider;
}

/** Shared task state for the transcript result and pinned session HUD. */
export interface TodoTaskLineProps {
	readonly task: TodoItemForDisplay;
	readonly completionKeys?: ReadonlySet<string>;
	readonly frame?: number;
	readonly matched?: boolean;
	readonly noteCount?: number;
}

/** Styled checkbox task row, including the historical completion reveal. */
export function TodoTaskLine(props: TodoTaskLineProps): JSX.Element {
	const label = createMemo(() => forDisplay(props.task.content));
	const completion = createMemo(() => {
		if (props.task.status !== "completed") return { struck: "", remaining: "" };
		const chars = [...label()];
		const reveal = props.completionKeys?.has(props.task.content)
			? strikeRevealCount(label(), props.frame)
			: undefined;
		const struck = reveal === undefined ? chars.length : Math.min(reveal, chars.length);
		return {
			struck: chars.slice(0, struck).join(""),
			remaining: chars.slice(struck).join(""),
		};
	});
	const pendingColor = createMemo<"accent" | "dim">(() =>
		props.task.status === "in_progress" || props.matched ? "accent" : "dim",
	);
	const blockedNote = createMemo(() =>
		props.task.blocker ? `blocked: ${forDisplay(props.task.blocker)}` : "blocked",
	);
	const notes = () =>
		props.noteCount ? (
			<span color="dim" italic>
				{" "}
				⁺{String(props.noteCount).replace(/\d/g, digit => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(digit)]!)}
			</span>
		) : undefined;

	return (
		<Show
			when={props.task.status === "completed"}
			fallback={
				<Show
					when={props.task.status === "abandoned"}
					fallback={
						<Show
							when={props.task.status === "blocked"}
							fallback={
								<text color={pendingColor()}>
									<icon name="checkbox.unchecked" color={pendingColor()} /> {label()}
									{notes()}
								</text>
							}
						>
							<text color="warning">
								<icon name="checkbox.unchecked" color="warning" /> {label()} ({blockedNote()}){notes()}
							</text>
						</Show>
					}
				>
					<text color="error">
						<icon name="checkbox.unchecked" color="error" /> <span strike>{label()}</span>
						{notes()}
					</text>
				</Show>
			}
		>
			<text color="success">
				<icon name="checkbox.checked" color="success" /> <span strike>{completion().struck}</span>
				<span>{completion().remaining}</span>
				{notes()}
			</text>
		</Show>
	);
}

export function todoSummary(props: ToolViewProps<TodoRenderArgs, TodoToolDetails>): ActivitySummary {
	const operations = normalizeTodoArg(props.args);
	const names = operations.map(operation => operation.op).filter((name): name is string => name !== undefined);
	const operation = names.join(", ") || props.details?.op || "todo";
	const phases = props.details?.phases ?? [];
	const total = phases.reduce((count, phase) => count + phase.tasks.length, 0);
	const done = phases.reduce((count, phase) => count + phase.tasks.filter(isClosedTodo).length, 0);

	return {
		label: "todo",
		detail: total > 0 ? `${operation}: ${done}/${total} tasks` : operation,
		status: todoStatus(props),
	};
}

/** Solid view for streaming todo operations and phased task snapshots. */
export function TodoView(props: ToolViewProps<TodoRenderArgs, TodoToolDetails>): JSX.Element {
	const clock = useClock("frame");
	const [startFrame] = createSignal(clock());
	const frame = createMemo(() => {
		if (props.ui.frozenAt !== undefined) return undefined;
		const elapsed = clock() - startFrame();
		return elapsed >= TODO_STRIKE_TOTAL_FRAMES ? undefined : elapsed;
	});
	const outputText = createMemo(() => {
		props.output.version();
		return props.output.text();
	});
	const phases = createMemo(() => (props.details?.phases ?? []).filter(phase => phase.tasks.length > 0));
	const completedTasks = createMemo(() => props.details?.completedTasks ?? []);
	const completedKeysByPhase = createMemo(() => {
		const keysByPhase = new Map<string, Set<string>>();
		for (const task of completedTasks()) {
			let keys = keysByPhase.get(task.phase);
			if (!keys) {
				keys = new Set<string>();
				keysByPhase.set(task.phase, keys);
			}
			keys.add(task.content);
		}
		return keysByPhase;
	});
	const activeDescriptions = createMemo(() =>
		props.ui.expanded ? EMPTY_ACTIVE_TODO_DESCRIPTIONS : activeTodoDescriptionsProvider(),
	);
	const operations = createMemo(() => normalizeTodoArg(props.args));
	const total = createMemo(() => phases().reduce((count, phase) => count + phase.tasks.length, 0));
	const presentation = createMemo<"call" | "error" | "aborted" | "empty" | "result">(() => {
		if (props.phase !== "settled" && props.details === undefined) return "call";
		if (props.outcome === "failed" || props.outcome === "timed_out") return "error";
		if (props.outcome === "cancelled" || props.outcome === "skipped") return "aborted";
		return total() === 0 ? "empty" : "result";
	});
	const touched = createMemo(() => {
		if (props.ui.expanded || phases().length < 2) return undefined;
		return computeTouchedPhases(props.args, phases(), completedTasks());
	});
	const callHeader = createMemo(() => (
		<ToolHeader status="pending" label={<span color="accent">Todo</span>} meta={operationMetadata(operations())} />
	));
	const resultHeader = createMemo(() => (
		<ToolHeader
			label={
				<>
					<icon name="tool.todo" color="accent" />
					<span> </span>
					<span color="accent">Todo</span>
				</>
			}
			meta={`${total()} tasks`}
		/>
	));
	const emptyText = createMemo(() => forDisplay(outputText() || "No todos"));
	const errorText = createMemo(() => todoErrorDetail(outputText() || "Todo operation failed"));
	const abortedText = createMemo(() => forDisplay(outputText() || "Todo operation aborted"));
	const isMatched = (task: TodoItemForDisplay): boolean => {
		const descriptions = activeDescriptions();
		if (descriptions.length === 0) return false;
		return todoMatchesAnyDescription(task.content, descriptions);
	};

	return (
		<Show
			when={presentation() === "call"}
			fallback={
				<Show
					when={presentation() === "error"}
					fallback={
						<Show
							when={presentation() === "aborted"}
							fallback={
								<Show
									when={presentation() === "empty"}
									fallback={
										<Card borderColor="borderMuted" title={resultHeader()}>
											<stack gap={0}>
												<For each={phases()}>
													{(phase, phaseIndex) => {
														const displayedTasks = createMemo(() => {
															if (props.ui.expanded) return { items: phase.tasks, summary: "" };
															return selectCollapsedTodos(
																phase.tasks,
																isMatched,
																PREVIEW_LIMITS.COLLAPSED_ITEMS,
															);
														});
														const phaseProgress = createMemo(
															() => `${phase.tasks.filter(isClosedTodo).length}/${phase.tasks.length}`,
														);
														const completionKeys = createMemo(
															() => completedKeysByPhase().get(phase.name) ?? EMPTY_COMPLETION_KEYS,
														);

														return (
															<Show
																when={touched()?.has(phase.name) ?? true}
																fallback={
																	<text color="dim">
																		<span bold>
																			{formatPhaseDisplayName(phase.name, phaseIndex() + 1)}
																		</span>
																		{`  ${phaseProgress()}`}
																	</text>
																}
															>
																<stack gap={0}>
																	<Show when={phases().length > 1}>
																		<text>
																			<span color="accent">
																				{formatPhaseDisplayName(phase.name, phaseIndex() + 1)}
																			</span>
																			<span color="dim">{`  ${phaseProgress()}`}</span>
																		</text>
																	</Show>
																	<box padding={{ left: phases().length > 1 ? 2 : 0 }}>
																		<tree indent={3}>
																			<For each={displayedTasks().items}>
																				{task => (
																					<TodoTaskLine
																						task={task}
																						completionKeys={completionKeys()}
																						frame={frame()}
																						matched={isMatched(task)}
																					/>
																				)}
																			</For>
																			<Show when={displayedTasks().summary}>
																				<text color="muted">{displayedTasks().summary}</text>
																			</Show>
																		</tree>
																	</box>
																</stack>
															</Show>
														);
													}}
												</For>
											</stack>
										</Card>
									}
								>
									<stack gap={0}>
										{resultHeader()}
										<box padding={{ left: 2 }}>
											<text color="dim">{emptyText()}</text>
										</box>
									</stack>
								</Show>
							}
						>
							<Card borderColor="borderMuted" title={<ToolHeader status="aborted" label="Todo" />}>
								<box padding={{ left: 2 }}>
									<text color="dim">{abortedText()}</text>
								</box>
							</Card>
						</Show>
					}
				>
					<Card
						borderColor="error"
						backgroundBorder={true}
						recipe="tool.card.error"
						title={<ToolHeader status="error" label="Todo" />}
					>
						<text>
							{"  "}
							<span color="error">{errorText()}</span>
						</text>
					</Card>
				</Show>
			}
		>
			{callHeader()}
		</Show>
	);
}

export const todoToolView: ToolViewDefinition<TodoRenderArgs, TodoToolDetails> = {
	view: TodoView,
	summary: todoSummary,
	framed: true,
};

registerToolView("todo", todoToolView);
