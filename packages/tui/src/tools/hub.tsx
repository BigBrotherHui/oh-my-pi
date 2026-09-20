import { createMemo, Show, type JSX } from "../reactive";
import { ToolCard } from "../view/tool-card";
import { HubHeader, toolStatus } from "./hub-header";
import { type HubDetails, type HubRenderArgs } from "./hub-contract";
import { hideSealedPoll, JobsBody } from "./hub-jobs";
import { MessagingBody } from "./hub-messaging";
import { ProcessBody } from "./hub-process";
import { hubPresentationFor, type HubViewProps } from "./hub-selection";
import { registerToolView } from "./registry";
import type { ToolViewDefinition } from "./view";

function HubBody(props: { readonly call: HubViewProps; readonly expanded: boolean }): JSX.Element {
	const presentation = createMemo(() => hubPresentationFor(props.call.args, props.call.details));
	return (
		<stack gap={0}>
			<Show when={props.call.outcome === "cancelled"}>
				<text color="warning">Cancelled</text>
			</Show>
			<Show when={props.call.outcome === "skipped"}>
				<text color="dim">Skipped</text>
			</Show>
			<Show
				when={presentation() === "jobs"}
				fallback={
					<Show
						when={presentation() === "launch"}
						fallback={<MessagingBody call={props.call} expanded={props.expanded} />}
					>
						<ProcessBody call={props.call} expanded={props.expanded} />
					</Show>
				}
			>
				<JobsBody call={props.call} expanded={props.expanded} />
			</Show>
		</stack>
	);
}

/** Reactive presentation of hub messaging, background jobs, and supervised processes. */
export function HubToolView(props: HubViewProps): JSX.Element {
	return (
		<Show when={!hideSealedPoll(props)}>
			<Show
				when={props.args.op === "logs" && props.phase === "settled"}
				fallback={
					<stack gap={0}>
						<HubHeader call={props} />
						<Show when={props.ui.expanded} fallback={<HubBody call={props} expanded={false} />}>
							<HubBody call={props} expanded />
						</Show>
					</stack>
				}
			>
				<ToolCard
					phase={props.phase}
					outcome={props.outcome}
					framed
					expanded={props.ui.expanded}
					header={<HubHeader call={props} />}
					summary={<HubBody call={props} expanded={false} />}
				>
					<HubBody call={props} expanded />
				</ToolCard>
			</Show>
		</Show>
	);
}

export const hubToolView: ToolViewDefinition<HubRenderArgs, HubDetails> = {
	view: props => <HubToolView {...props} />,
	summary: props => {
		const op = props.args.op;
		let detail = op;
		if (op === "send" && (props.args.to || props.args.name)) detail = `send → ${props.args.to ?? props.args.name}`;
		else if (op === "wait" && (props.args.from || props.args.name))
			detail = `wait ${props.args.from ?? props.args.name}`;
		else if ((op === "wait" || op === "cancel") && props.args.ids?.length)
			detail = `${op} ${props.args.ids.length} job${props.args.ids.length === 1 ? "" : "s"}`;
		else if (props.args.name) detail = `${op} ${props.args.name}`;
		return { label: props.label || "hub", detail, status: toolStatus(props) };
	},
	framed: false,
	tint: false,
};

registerToolView("hub", hubToolView);
