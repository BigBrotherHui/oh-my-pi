import { Show, type JSX } from "../reactive";
import type { CallOutcome, CallPhase } from "../tools/view";
import { Card } from "./card";
import type { ThemeColor } from "../theme/schema";

/** Props for a lifecycle-tinted tool card. */
export interface ToolCardProps {
	readonly phase: CallPhase;
	readonly outcome?: CallOutcome;
	readonly framed?: boolean;
	readonly expanded?: boolean;
	readonly header?: JSX.Element;
	readonly summary?: JSX.Element;
	readonly children?: JSX.Element;
	readonly footer?: string;
	/** Optional presentation override; execution outcome remains unchanged. */
	readonly recipe?: string;
	readonly borderColor?: ThemeColor;
	/** Horizontal content inset; zero keeps diff rows flush with their frame. */
	readonly paddingX?: number;
	/** Disable automatic lifecycle backgrounds; an explicit recipe still wins. */
	readonly tint?: boolean;
}

function recipeFor(phase: CallPhase, outcome: CallOutcome | undefined): string | undefined {
	if (phase !== "settled") return `tool.card.${phase}`;
	if (outcome === "success") return "tool.card.success";
	if (outcome === "failed" || outcome === "timed_out") return "tool.card.error";
	return undefined;
}

/** Render a tool card whose phase recipe tints body and border rows. */
export function ToolCard(props: ToolCardProps): JSX.Element {
	const borderColor = (): ThemeColor =>
		props.borderColor ??
		(props.outcome === "failed"
			? "error"
			: props.outcome === "timed_out"
				? "warning"
				: props.phase === "settled"
					? "dim"
					: "accent");
	return (
		<Show
			when={props.framed ?? true}
			fallback={
				<Card
					border={false}
					backgroundBorder={true}
					recipe={props.recipe ?? (props.tint === false ? undefined : recipeFor(props.phase, props.outcome))}
					borderColor={borderColor()}
					paddingX={props.paddingX}
				>
					{props.header}
					<Show when={props.expanded ?? true} fallback={props.summary ?? props.children}>
						{props.children}
					</Show>
					<Show when={props.footer}>
						<text color="dim">{props.footer}</text>
					</Show>
				</Card>
			}
		>
			<Card
				title={props.header}
				footer={props.footer}
				backgroundBorder={true}
				recipe={props.recipe ?? (props.tint === false ? undefined : recipeFor(props.phase, props.outcome))}
				borderColor={borderColor()}
				paddingX={props.paddingX}
			>
				<Show when={props.expanded ?? true} fallback={props.summary ?? props.children}>
					{props.children}
				</Show>
			</Card>
		</Show>
	);
}
