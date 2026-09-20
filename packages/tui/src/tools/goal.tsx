import { createMemo, For, type JSX } from "../reactive";
import { formatDuration, formatNumber, previewLine, replaceTabs, TRUNCATE_LENGTHS } from "../render/render-utils";
import type { ThemeColor } from "../theme/theme";
import type { ToolUIStatus } from "../view/status-icon";
import { Card } from "../view/card";

import { registerToolView } from "./registry";
import type { ActivitySummary, DeepReadonly, ToolViewDefinition, ToolViewProps } from "./view";

/** Lifecycle state of a tracked goal. */
export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

/** Serializable goal progress and resource budget. */
export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

/** Goal operation outcome displayed in the transcript. */
export interface GoalToolDetails {
	op: "create" | "get" | "complete" | "resume" | "drop";
	goal?: Goal | null;
	remainingTokens?: number | null;
	completionBudgetReport?: string | null;
}

export function describeOp(op: string | undefined): string {
	switch (op) {
		case "create":
			return "set";
		case "complete":
			return "complete";
		case "get":
			return "check";
		case "resume":
			return "resume";
		case "drop":
			return "drop";
		default:
			return op ?? "?";
	}
}

export function goalBadgeColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "complete":
			return "success";
		case "budget-limited":
			return "warning";
		case "paused":
		case "dropped":
			return "muted";
		default:
			return "accent";
	}
}

export interface GoalRenderArgs {
	op?: GoalToolDetails["op"];
	objective?: string;
	token_budget?: number;
}

interface GoalHeaderMeta {
	readonly text: string;
	readonly color?: "muted" | "dim";
	readonly italic?: boolean;
}

interface GoalHeaderProps {
	readonly status?: ToolUIStatus;
	readonly icon?: boolean;
	readonly description: string;
	readonly badge?: GoalStatus;
	readonly meta?: JSX.Element;
}

/** Historical status row, including its accent goal glyph and colorized badge. */
function GoalHeader(props: GoalHeaderProps): JSX.Element {
	return (
		<row gap={1}>
			{props.status === undefined ? null : <status value={props.status} />}
			{props.icon ? <icon name="tool.goal" color="accent" /> : null}
			<text grow={0} shrink={1} minWidth={1} wrap="none" overflow="ellipsis">
				<span color="accent">Goal</span>: <span color="muted">{props.description}</span>
			</text>
			{props.badge === undefined ? null : (
				<badge color={goalBadgeColor(props.badge)} shrink={1}>
					{props.badge}
				</badge>
			)}
			{props.meta === undefined ? null : (
				<text color="dim" grow={0} shrink={1} minWidth={1} wrap="none" overflow="ellipsis">
					{props.meta}
				</text>
			)}
		</row>
	);
}

function goalUsageText(goal: {
	readonly tokenBudget?: number;
	readonly tokensUsed: number;
	readonly timeUsedSeconds: number;
}): string {
	const used = formatNumber(goal.tokensUsed);
	const tokens =
		goal.tokenBudget !== undefined
			? `${used} / ${formatNumber(goal.tokenBudget)} tokens (${formatNumber(Math.max(0, goal.tokenBudget - goal.tokensUsed))} left)`
			: `${used} tokens`;
	return goal.timeUsedSeconds > 0 ? `${tokens} · ${formatDuration(goal.timeUsedSeconds * 1000)} elapsed` : tokens;
}

/** Mirrors the historical subordinate error text without leaking control-layout tabs. */
function goalErrorLines(output: string): readonly string[] {
	const normalized = (output || "Goal tool failed").replace(/^Error:\s*/, "").trim();
	const source = normalized || "Unknown error";
	return replaceTabs(source).split(/\r?\n/u);
}

function goalStatus(props: ToolViewProps<GoalRenderArgs, GoalToolDetails>): ToolUIStatus {
	if (props.phase === "receiving" || props.phase === "queued") return "pending";
	if (props.phase === "running") return "running";
	if (props.outcome === "failed" || props.outcome === "timed_out") return "error";
	if (props.outcome === "cancelled" || props.outcome === "skipped") return "aborted";
	return props.details?.goal ? "success" : "warning";
}

export function goalSummary(props: ToolViewProps<GoalRenderArgs, GoalToolDetails>): ActivitySummary {
	const op = props.details?.op ?? props.args.op ?? "goal";
	const goal = props.details?.goal;
	return {
		label: "goal",
		detail: goal ? `${describeOp(op)}: ${goal.objective}` : describeOp(op),
		status: goalStatus(props),
	};
}

type GoalPresentation =
	| { readonly kind: "call" }
	| { readonly kind: "error" }
	| { readonly kind: "aborted" }
	| { readonly kind: "empty" }
	| {
			readonly kind: "result";
			readonly goal: DeepReadonly<Goal>;
			readonly completionBudgetReport?: string;
	  };

function GoalResultCard(props: {
	readonly description: string;
	readonly goal: DeepReadonly<Goal>;
	readonly completionBudgetReport?: string;
}): JSX.Element {
	return (
		<Card
			title={<GoalHeader icon description={props.description} badge={props.goal.status} />}
			titleInset={3}
			borderColor="borderMuted"
			backgroundBorder
			recipe="tool.card.success"
		>
			<stack gap={0}>
				<text color="muted">"{props.goal.objective.trim()}"</text>
				<text color="dim">{goalUsageText(props.goal)}</text>
				{props.completionBudgetReport === undefined ? null : (
					<>
						<hr variant="frame" label="Report" />
						<For each={props.completionBudgetReport.split("\n")}>{line => <text color="muted">{line}</text>}</For>
					</>
				)}
			</stack>
		</Card>
	);
}

/** Solid presentation preserving the historical goal call and result layouts. */
export function GoalView(props: ToolViewProps<GoalRenderArgs, GoalToolDetails>): JSX.Element {
	const output = createMemo(() => {
		props.output.version();
		return props.output.text();
	});
	const description = createMemo(() => describeOp(props.details?.op ?? props.args.op));
	const callMeta = createMemo<readonly GoalHeaderMeta[]>(() => {
		const meta: GoalHeaderMeta[] = [];
		const objective = props.args.objective?.trim();
		if (props.args.op === "create" && objective) {
			meta.push({
				text: `"${previewLine(objective, TRUNCATE_LENGTHS.TITLE)}"`,
				color: "muted",
			});
		}
		if (props.args.op === "create" && props.args.token_budget !== undefined) {
			meta.push({ text: `budget ${formatNumber(props.args.token_budget)}` });
		}
		return meta;
	});
	const presentation = createMemo<GoalPresentation>(() => {
		if (props.outcome === "failed" || props.outcome === "timed_out") return { kind: "error" };
		if (props.outcome === "cancelled" || props.outcome === "skipped") return { kind: "aborted" };
		if (props.phase !== "settled" || !props.hasResult) return { kind: "call" };
		const goal = props.details?.goal;
		if (!goal) return { kind: "empty" };
		return {
			kind: "result",
			goal,
			completionBudgetReport: props.details?.completionBudgetReport ?? undefined,
		};
	});
	const rendered = createMemo<JSX.Element>(() => {
		const state = presentation();
		switch (state.kind) {
			case "call":
				return (
					<text wrap="word">
						<icon name="status.pending" color="muted" /> <span color="accent">Goal</span>:{" "}
						<span color="muted">{description()}</span>
						<For each={callMeta()}>
							{(item, index) => (
								<>
									{index() === 0 ? " " : " · "}
									<span color={item.color} italic={item.italic}>
										{item.text}
									</span>
								</>
							)}
						</For>
					</text>
				);
			case "error":
				return (
					<Card
						title={<GoalHeader status="error" description={description()} />}
						titleInset={3}
						borderColor="error"
						backgroundBorder
						recipe="tool.card.error"
					>
						<stack gap={0}>
							<For each={goalErrorLines(output())}>
								{line => (
									<text>
										{"  "}
										<span color="error">{line}</span>
									</text>
								)}
							</For>
						</stack>
					</Card>
				);
			case "aborted":
				return <GoalHeader status="aborted" description={description()} />;
			case "empty":
				return <GoalHeader status="warning" description={description()} meta={<span>no active goal</span>} />;
			case "result":
				return (
					<GoalResultCard
						description={description()}
						goal={state.goal}
						completionBudgetReport={state.completionBudgetReport}
					/>
				);
		}
	});

	return <>{rendered()}</>;
}

export const goalToolView: ToolViewDefinition<GoalRenderArgs, GoalToolDetails> = {
	view: GoalView,
	summary: goalSummary,
	framed: true,
};

registerToolView("goal", goalToolView);
