import { formatAge, isRecord } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "../utils";
import { createMemo, For, Show, useClock, type JSX } from "../reactive";
import { useTheme } from "../theme/reactive";
import type { CustomMessage } from "./messages";

const COLLAPSED_BODY_LINES = 3;
const EXPANDED_BODY_LINES = 12;

type IrcMessageKind = "incoming" | "autoreply" | "relay" | "workpool";

interface IrcBodyPreview {
	readonly lines: readonly string[];
	readonly hidden: number;
}

interface IrcPresentation {
	readonly title: string;
	readonly metadata: string;
	readonly quoteBorder: string;
	readonly body: IrcBodyPreview;
}

export interface IrcMessageViewProps {
	readonly message: CustomMessage<unknown>;
	readonly expanded: boolean;
}

/** Display-only IRC traffic retained with the transcript. */
export function IrcMessageView(props: IrcMessageViewProps): JSX.Element {
	const { symbol } = useTheme();
	const now = useClock("second");
	const presentation = createMemo(() =>
		buildPresentation(props.message, props.expanded, now(), {
			back: symbol("nav.back"),
			selected: symbol("nav.selected"),
			dot: symbol("sep.dot"),
			quoteBorder: symbol("md.quoteBorder"),
		}),
	);
	return (
		<box padding={{ left: 1, right: 1 }}>
			<stack gap={0}>
				<row gap={1}>
					<icon name="tool.irc" color="accent" />
					<text grow={1} minWidth={1} wrap="none" overflow="ellipsis">
						<span color="accent">{presentation().title}</span>
						<Show when={presentation().metadata}>
							<span color="dim">{` ${presentation().metadata}`}</span>
						</Show>
					</text>
				</row>
				<For each={presentation().body.lines}>
					{line => (
						<rail prefix={<text color="dim">{`  ${presentation().quoteBorder} `}</text>}>
							<text color="toolOutput" wrap="none" overflow="ellipsis">
								{line}
							</text>
						</rail>
					)}
				</For>
				<Show when={presentation().body.hidden > 0}>
					<rail prefix={<text color="dim">{`  ${presentation().quoteBorder} `}</text>}>
						<text color="dim" wrap="none" overflow="ellipsis">
							{`… +${presentation().body.hidden} more ${presentation().body.hidden === 1 ? "line" : "lines"}`}
						</text>
					</rail>
				</Show>
			</stack>
		</box>
	);
}

function buildPresentation(
	message: CustomMessage<unknown>,
	expanded: boolean,
	now: number,
	symbols: { readonly back: string; readonly selected: string; readonly dot: string; readonly quoteBorder: string },
): IrcPresentation {
	const kind = kindFor(message.customType);
	const from = displayName(stringDetail(message.details, "from"));
	const to = displayName(stringDetail(message.details, "to"));
	const pool = displayName(stringDetail(message.details, "pool"));
	const replyTo = stringDetail(message.details, "replyTo");
	const mode = stringDetail(message.details, "mode");
	const body = kind === "incoming" ? stringDetail(message.details, "message") : stringDetail(message.details, "body");
	const metadata = metadataFor(kind, mode, replyTo, message.timestamp, now, symbols.dot);

	return {
		title: titleFor(kind, from, to, pool, symbols),
		metadata,
		quoteBorder: symbols.quoteBorder,
		body: previewBody(body ?? "", expanded),
	};
}

function kindFor(customType: string): IrcMessageKind {
	switch (customType) {
		case "irc:incoming":
			return "incoming";
		case "irc:autoreply":
			return "autoreply";
		case "irc:workpool":
			return "workpool";
		default:
			return "relay";
	}
}

function stringDetail(details: unknown, field: string): string | undefined {
	if (!isRecord(details)) return undefined;
	const value = details[field];
	return typeof value === "string" ? value : undefined;
}

function displayName(value: string | undefined): string {
	const name = value?.trim();
	return flattenHeader(name || "?");
}

function titleFor(
	kind: IrcMessageKind,
	from: string,
	to: string,
	pool: string,
	symbols: Pick<IrcPresentationSymbols, "back" | "selected">,
): string {
	switch (kind) {
		case "incoming":
			return `IRC ${symbols.back} ${from}`;
		case "autoreply":
			return `IRC ${symbols.selected} ${to}`;
		case "workpool":
			return `Pool ${pool} ${symbols.selected} ${to}`;
		case "relay":
			return `IRC ${from} ${symbols.selected} ${to}`;
	}
}

interface IrcPresentationSymbols {
	readonly back: string;
	readonly selected: string;
	readonly dot: string;
	readonly quoteBorder: string;
}

function metadataFor(
	kind: IrcMessageKind,
	mode: string | undefined,
	replyTo: string | undefined,
	timestamp: number,
	now: number,
	dot: string,
): string {
	const items: string[] = [];
	const modeLabel = mode === undefined ? "" : flattenHeader(mode);
	if (kind === "autoreply") items.push("auto");
	if (kind === "workpool" && modeLabel.trim()) items.push(modeLabel);
	if (replyTo) items.push("reply");
	const age = messageAge(timestamp, now);
	if (age) items.push(age);
	return items.join(dot);
}

function messageAge(timestamp: number, now: number): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
	return formatAge(Math.max(1, Math.round((now - timestamp) / 1000)));
}

function previewBody(body: string, expanded: boolean): IrcBodyPreview {
	const lines = body
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => replaceTabs(line.trim()));
	const shown = expanded ? EXPANDED_BODY_LINES : COLLAPSED_BODY_LINES;
	return { lines: lines.slice(0, shown), hidden: Math.max(0, lines.length - shown) };
}

function flattenHeader(value: string): string {
	return value.replace(/\r\n?|\n/g, " ");
}
