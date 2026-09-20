import { formatNumber } from "@oh-my-pi/pi-utils";
import { cellWidth } from "../core/richtext";
import { createDocument } from "../document/document";
import { createMemo, type JSX } from "../reactive";
import { useTheme } from "../theme/reactive";
import type { CompactionSummaryMessage, CustomMessage } from "./messages";

const COMPACTION_METHOD_LABELS: Record<string, string> = {
	remote: "remote-compacted",
	soft: "soft-compacted",
	handoff: "handed-off",
	snapcompact: "snap-compacted",
	shake: "shaken",
};

export interface SummaryMessageViewProps {
	readonly label: string;
	readonly warning?: string;
	readonly detail: string;
	readonly expanded: boolean;
}

/**
 * Shared history-collapse divider. The detail subtree stays unmaterialized
 * until it is expanded, then survives later collapse/re-expand cycles.
 */
export function SummaryMessageView(props: SummaryMessageViewProps): JSX.Element {
	const { symbol, theme } = useTheme();
	const divider = createMemo(() => {
		const label = props.label;
		const warning = props.warning;
		const hint = `${symbol("sep.dot").trim()} ctrl+o`;
		const rule = theme().tree.horizontal;
		return (width: number) => (
			<SummaryDivider width={width} label={label} warning={warning} hint={hint} rule={rule} />
		);
	});
	let detail: { readonly text: string; readonly view: JSX.Element } | undefined;
	const detailView = (): JSX.Element => {
		const text = props.detail;
		if (detail?.text !== text) {
			detail = {
				text,
				view: (
					<box background="customMessageBg" padding={1}>
						<markdown document={createDocument(text)} color="customMessageText" options={{ ignoreTight: true }} />
					</box>
				),
			};
		}
		return detail.view;
	};

	return (
		<stack>
			<br />
			<sized paint={divider()} />
			<br />
			{props.expanded ? detailView() : null}
		</stack>
	);
}

interface SummaryDividerProps {
	readonly width: number;
	readonly label: string;
	readonly warning?: string;
	readonly hint: string;
	readonly rule: string;
}

function SummaryDivider(props: SummaryDividerProps): JSX.Element {
	const width = Math.max(1, Math.trunc(props.width));
	const visibleLabel = props.warning === undefined ? props.label : `${props.label} ${props.warning}`;
	const remaining = width - cellWidth(`${visibleLabel} ${props.hint}`) - 2;
	if (remaining < 4) {
		return (
			<text color="muted" wrap="overflow">
				{props.label}
				{props.warning === undefined ? null : <span color="warning"> {props.warning}</span>}
			</text>
		);
	}
	const left = Math.floor(remaining / 2);
	const right = remaining - left;
	return (
		<text wrap="overflow">
			<span color="dim">{props.rule.repeat(left)}</span> <span color="muted">{props.label}</span>
			{props.warning === undefined ? null : <span color="warning"> {props.warning}</span>}{" "}
			<span color="dim">{props.hint}</span> <span color="dim">{props.rule.repeat(right)}</span>
		</text>
	);
}

function compactionDetail(message: CompactionSummaryMessage, warningIcon: string): string {
	const tokenLine =
		message.tokensBefore > 0
			? message.tokensAfter !== undefined
				? `Compacted from ${message.tokensBefore.toLocaleString()} to ${message.tokensAfter.toLocaleString()} tokens`
				: `Compacted from ${message.tokensBefore.toLocaleString()} tokens`
			: message.tokensAfter !== undefined
				? `Compacted to ${message.tokensAfter.toLocaleString()} tokens`
				: "Compacted context";
	const warning = message.warning ? `\n\n${warningIcon} **Warning:** ${message.warning}` : "";
	const frames = message.images?.length ?? 0;
	const frameNote = frames === 0 ? "" : `\n\n_${frames} snapcompact frame${frames === 1 ? "" : "s"} attached_`;
	return `**${tokenLine}**${warning}\n\n${message.summary}${frameNote}`;
}

export interface CompactionSummaryMessageViewProps {
	readonly message: CompactionSummaryMessage;
	readonly expanded: boolean;
}

export function CompactionSummaryMessageView(props: CompactionSummaryMessageViewProps): JSX.Element {
	const { symbol } = useTheme();
	const content = createMemo(() => {
		const method = (props.message.method && COMPACTION_METHOD_LABELS[props.message.method]) || "compacted";
		const amount =
			props.message.tokensAfter === undefined || props.message.tokensBefore <= 0
				? ""
				: `${symbol("sep.dot")}${formatNumber(props.message.tokensBefore)}→${formatNumber(props.message.tokensAfter)}`;
		const warningIcon = symbol("icon.warning");
		return {
			label: `${symbol("icon.camera")} ${method}${amount}`,
			warning: props.message.warning ? warningIcon : undefined,
			detail: compactionDetail(props.message, warningIcon),
		};
	});
	return (
		<SummaryMessageView
			label={content().label}
			warning={content().warning}
			detail={content().detail}
			expanded={props.expanded}
		/>
	);
}

export interface HandoffSummaryMessageViewProps {
	readonly message: CustomMessage<unknown>;
	readonly expanded: boolean;
}

export function HandoffSummaryMessageView(props: HandoffSummaryMessageViewProps): JSX.Element {
	const { symbol } = useTheme();
	const label = createMemo(() => `${symbol("icon.context")} handed-off`);
	const detail = `**Handoff context**\n\n${extractHandoffDocument(messageText(props.message)) || "_No handoff content._"}`;
	return <SummaryMessageView label={label()} detail={detail} expanded={props.expanded} />;
}

export function isHandoffMessage(message: CustomMessage<unknown>): boolean {
	return message.customType === "handoff" && message.display;
}

function messageText(message: CustomMessage<unknown>): string {
	if (typeof message.content === "string") return message.content;
	let firstText: string | undefined;
	let parts: string[] | undefined;
	for (const content of message.content) {
		if (content.type !== "text") continue;
		if (firstText === undefined) {
			firstText = content.text;
			continue;
		}
		if (parts === undefined) parts = [firstText];
		parts.push(content.text);
	}
	return parts === undefined ? (firstText ?? "") : parts.join("\n");
}

function extractHandoffDocument(text: string): string {
	const openTag = "<handoff-context>";
	const closeTag = "</handoff-context>";
	const start = text.indexOf(openTag);
	if (start < 0) return text.trim();
	const contentStart = start + openTag.length;
	const end = text.indexOf(closeTag, contentStart);
	return text.slice(contentStart, end < 0 ? undefined : end).trim();
}
