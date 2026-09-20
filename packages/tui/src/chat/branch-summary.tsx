import { cellWidth } from "../core/richtext";
import { createDocument } from "../document/document";
import { createMemo, type JSX } from "../reactive";
import { useTheme } from "../theme/reactive";
import type { BranchSummaryMessage } from "./messages";

export interface BranchSummaryViewProps {
	readonly message: BranchSummaryMessage;
	readonly expanded: boolean;
}

/**
 * Side-branch collapse marker in the main transcript.
 *
 * The detail subtree deliberately materializes only after its first expansion,
 * then retains its document and host nodes across later collapse cycles.
 */
export function BranchSummaryView(props: BranchSummaryViewProps): JSX.Element {
	const { symbol, theme } = useTheme();
	const divider = createMemo(() => {
		const label = `${symbol("icon.branch")} branch`;
		const hint = `${symbol("sep.dot").trim()} ctrl+o`;
		const rule = theme().tree.horizontal;
		return (width: number) => <BranchSummaryDivider width={width} label={label} hint={hint} rule={rule} />;
	});
	let detail: JSX.Element | undefined;
	const detailView = (): JSX.Element =>
		(detail ??= (
			<box background="customMessageBg" padding={1}>
				<markdown
					document={createDocument(`**Branch summary**\n\n${props.message.summary}`)}
					color="customMessageText"
					options={{ ignoreTight: true }}
				/>
			</box>
		));

	return (
		<stack>
			<br />
			<sized paint={divider()} />
			<br />
			{props.expanded ? detailView() : null}
		</stack>
	);
}

interface BranchSummaryDividerProps {
	readonly width: number;
	readonly label: string;
	readonly hint: string;
	readonly rule: string;
}

/** Historical centered divider, including its unframed narrow-terminal fallback. */
function BranchSummaryDivider(props: BranchSummaryDividerProps): JSX.Element {
	const width = Math.max(1, Math.trunc(props.width));
	const remaining = width - cellWidth(`${props.label} ${props.hint}`) - 2;
	if (remaining < 4) {
		return (
			<text color="muted" wrap="overflow">
				{props.label}
			</text>
		);
	}
	const left = Math.floor(remaining / 2);
	const right = remaining - left;
	return (
		<text wrap="overflow">
			<span color="dim">{props.rule.repeat(left)}</span> <span color="muted">{props.label}</span>{" "}
			<span color="dim">{props.hint}</span> <span color="dim">{props.rule.repeat(right)}</span>
		</text>
	);
}
