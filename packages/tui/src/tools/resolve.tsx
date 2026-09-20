import { isRecord } from "@oh-my-pi/pi-utils";
import { createMemo, Show, type JSX } from "../reactive";
import type { SymbolKey } from "../theme/symbols";
import { replaceTabs } from "../utils";
import type { ToolUIStatus } from "../view/status-icon";

import { registerToolView } from "./registry";
import type { ActivitySummary, ToolViewDefinition, ToolViewProps } from "./view";

/** Device name for applying a staged action. */
export const RESOLVE_DEVICE_NAME = "resolve";
/** Device name for discarding a staged action. */
export const REJECT_DEVICE_NAME = "reject";
/** Device name for submitting a plan. */
export const PROPOSE_DEVICE_NAME = "propose";
/** Plain-text staged-action device names. */
export type ResolutionDeviceName = typeof RESOLVE_DEVICE_NAME | typeof REJECT_DEVICE_NAME | typeof PROPOSE_DEVICE_NAME;
/** Resolution applied to a staged action. */
export type ResolveAction = "apply" | "discard";

/** Details payload carried on a resolve/reject dispatch result (`XdevDispatch.inner`). */
export interface ResolveDetails {
	action?: ResolveAction;
	reason?: string;
	sourceToolName?: string;
	label?: string;
	sourceResultDetails?: unknown;
	/** Outer write-tool dispatch envelope, unwrapped by the presentation. */
	xdev?: { readonly inner?: unknown };
	patch?: string;
	device?: ResolutionDeviceName;
	summary?: string;
}

/** Invoker input for queued pending-preview handlers. */
export interface ResolveInvocation {
	device: ResolutionDeviceName;
	action?: ResolveAction;
	reason?: string;
	content?: string;
	/** Raw, possibly incomplete device-write body supplied by xdev delegation. */
	__partialJson?: string;
}

type ResolveVisualState = "apply" | "discard" | "failed" | "aborted";
type ResolutionColor = "success" | "warning" | "error";

interface ResolveDisplayDetails {
	readonly action?: ResolveAction;
	readonly reason?: string;
	readonly label?: string;
}

/** Extract the inner dispatch payload without coupling the view to the write-tool envelope. */
function displayDetails(value: unknown): ResolveDisplayDetails {
	if (!isRecord(value)) return {};
	const xdev = value.xdev;
	const details = isRecord(xdev) && isRecord(xdev.inner) ? xdev.inner : value;
	const action = details.action === "apply" || details.action === "discard" ? details.action : undefined;
	const reason = typeof details.reason === "string" ? details.reason : undefined;
	const label = typeof details.label === "string" ? details.label : undefined;
	return { action, reason, label };
}

function deviceFor(props: ToolViewProps<Partial<ResolveInvocation>, ResolveDetails>): ResolutionDeviceName {
	const device = props.args.device;
	if (device === RESOLVE_DEVICE_NAME || device === REJECT_DEVICE_NAME || device === PROPOSE_DEVICE_NAME) return device;
	return isResolutionDeviceName(props.toolName) ? props.toolName : RESOLVE_DEVICE_NAME;
}

function titleFor(device: ResolutionDeviceName): string {
	if (device === PROPOSE_DEVICE_NAME) return "Propose";
	if (device === REJECT_DEVICE_NAME) return "Reject";
	return "Resolve";
}

function actionFor(
	args: ToolViewProps<Partial<ResolveInvocation>, ResolveDetails>["args"],
	details: ResolveDisplayDetails,
	device: ResolutionDeviceName,
): ResolveAction {
	if (details.action !== undefined) return details.action;
	if (args.action === "apply" || args.action === "discard") return args.action;
	return device === REJECT_DEVICE_NAME ? "discard" : "apply";
}

function previewText(content: string): string | undefined {
	const firstLine = content.trim().split("\n", 1)[0] ?? "";
	return firstLine.length > 0 ? replaceTabs(firstLine) : undefined;
}

function visualState(action: ResolveAction, outcome: ToolViewProps<unknown, unknown>["outcome"]): ResolveVisualState {
	if (action === "discard") return "discard";
	if (outcome === "failed" || outcome === "timed_out") return "failed";
	if (outcome === "cancelled" || outcome === "skipped") return "aborted";
	return "apply";
}

function colorFor(state: ResolveVisualState, outcome: ToolViewProps<unknown, unknown>["outcome"]): ResolutionColor {
	if (outcome === "failed" || outcome === "timed_out") return "error";
	if (state === "apply") return "success";
	if (state === "discard") return "warning";
	return "error";
}

function statusFor(
	phase: ToolViewProps<unknown, unknown>["phase"],
	outcome: ToolViewProps<unknown, unknown>["outcome"],
	action: ResolveAction,
): ToolUIStatus {
	if (outcome === "failed" || outcome === "timed_out") return "error";
	if (outcome === "cancelled" || outcome === "skipped") return "aborted";
	if (phase === "settled") return action === "discard" ? "warning" : "success";
	return "pending";
}

/** Pure semantic summary for compact transcript rows. */
export function resolveSummary(props: ToolViewProps<Partial<ResolveInvocation>, ResolveDetails>): ActivitySummary {
	const details = displayDetails(props.details);
	const device = deviceFor(props);
	const action = actionFor(props.args, details, device);
	const rawContent = props.args.content ?? props.args.__partialJson;
	return {
		label: props.toolName,
		detail: details.reason ?? props.args.reason ?? (rawContent === undefined ? action : previewText(rawContent)),
		status: statusFor(props.phase, props.outcome, action),
	};
}

/** Pending device-write line matching the historical `renderResolutionDeviceCall` and `renderCall` paths. */
function ResolveCallView(props: ToolViewProps<Partial<ResolveInvocation>, ResolveDetails>): JSX.Element {
	const details = createMemo(() => displayDetails(props.details));
	const device = createMemo(() => deviceFor(props));
	const action = createMemo(() => actionFor(props.args, details(), device()));
	const rawContent = createMemo(() => props.args.content ?? props.args.__partialJson);
	const description = createMemo(() => {
		const content = rawContent();
		if (content !== undefined) return previewText(content);
		return props.args.action ?? action();
	});
	const reason = createMemo(() => {
		const value = props.args.reason?.trim();
		return value && value.length > 0 ? value : undefined;
	});

	return (
		<text>
			<status value="pending" />{" "}
			<span color="accent">{rawContent() === undefined ? "Resolve" : titleFor(device())}</span>
			<Show when={description()}>
				{": "}
				<span color="muted">{description()}</span>
			</Show>
			<Show when={rawContent() === undefined}>
				{" "}
				<badge color={action() === "apply" ? "success" : "warning"}>
					{action() === "apply" ? "proposed -> resolved" : "proposed -> rejected"}
				</badge>
			</Show>
			<Show when={reason()}>
				{" "}
				<span color="dim">
					<span color="muted">{reason()}</span>
				</span>
			</Show>
		</text>
	);
}

/** Historical merged acceptance/rejection result: five fully inverse-tinted rows. */
function ResolveResultView(props: ToolViewProps<Partial<ResolveInvocation>, ResolveDetails>): JSX.Element {
	const details = createMemo(() => displayDetails(props.details));
	const device = createMemo(() => deviceFor(props));
	const action = createMemo(() => actionFor(props.args, details(), device()));
	const state = createMemo(() => visualState(action(), props.outcome));
	const color = createMemo<ResolutionColor>(() => colorFor(state(), props.outcome));
	const icon = createMemo<SymbolKey>(() => (state() === "apply" ? "tool.resolve" : "status.error"));
	const verb = createMemo(() => {
		switch (state()) {
			case "apply":
				return "Accept";
			case "discard":
				return "Discard";
			case "failed":
				return "Failed";
			case "aborted":
				return "Aborted";
		}
	});
	const label = createMemo(() => replaceTabs(details().label ?? "pending action"));
	const reason = createMemo(() => replaceTabs(details().reason?.trim() || "No reason provided"));
	const labelParts = createMemo(() => {
		const value = label();
		const separator = ": ";
		const index = value.indexOf(separator);
		if (index <= 0) return { source: undefined, summary: value };
		return { source: value.slice(0, index).trim(), summary: value.slice(index + separator.length).trim() };
	});

	return (
		<box color={color()} padding={{ x: 1, y: 1 }}>
			<stack>
				<text wrap="none" overflow="clip">
					<icon name={icon()} /> {verb()}: {labelParts().summary}
					<Show when={labelParts().source}>
						{" "}
						<badge>{labelParts().source}</badge>
					</Show>
				</text>
				<text>{""}</text>
				<text wrap="none" overflow="clip">
					{reason()}
				</text>
			</stack>
		</box>
	);
}

/** Reactive view for staged-action acceptance or rejection. */
export function ResolveView(props: ToolViewProps<Partial<ResolveInvocation>, ResolveDetails>): JSX.Element {
	return (
		<Show when={props.hasResult} fallback={<ResolveCallView {...props} />}>
			{<ResolveResultView {...props} />}
		</Show>
	);
}

export const resolveToolView: ToolViewDefinition<Partial<ResolveInvocation>, ResolveDetails> = {
	view: ResolveView,
	summary: resolveSummary,
	framed: true,
};

registerToolView(RESOLVE_DEVICE_NAME, resolveToolView);
registerToolView(REJECT_DEVICE_NAME, resolveToolView);
registerToolView(PROPOSE_DEVICE_NAME, resolveToolView);

/** Whether an xd:// device name is one of the plain-text resolution devices. */
export function isResolutionDeviceName(name: string): name is ResolutionDeviceName {
	return name === RESOLVE_DEVICE_NAME || name === REJECT_DEVICE_NAME || name === PROPOSE_DEVICE_NAME;
}
