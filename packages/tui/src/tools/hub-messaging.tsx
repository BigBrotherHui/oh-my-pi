import { formatAge, replaceTabs } from "../render/render-utils";
import { Style } from "../core/style";
import { createMemo, For, Match, Show, Switch, useClock, useTheme, type Accessor, type JSX } from "../reactive";
import type { ThemeColor } from "../theme/theme";
import { ExpandHint } from "../view/expand-hint";
import { TreeList } from "../view/tree-list";
import type { HubPeerInfo, IrcDeliveryReceipt, IrcMessage } from "./hub-contract";
import { LIST_STATUS_ORDER } from "./hub-contract";
import { coordinationDetails, currentTime, outputText, type HubViewProps } from "./hub-selection";
import type { DeepReadonly } from "./view";

const BODY_LINES_COLLAPSED = 2;
const BODY_LINES_EXPANDED = 12;
const COLLAPSED_ITEM_LIMIT = 8;

function messageAge(timestamp: number | undefined, now: number): string | undefined {
	return timestamp ? formatAge(Math.max(1, Math.round((now - timestamp) / 1_000))) : undefined;
}

function QuotedBody(props: {
	readonly body: string;
	readonly expanded: boolean;
	readonly tone?: ThemeColor;
	readonly collapsedLines?: number;
	readonly indent?: string;
	readonly wrap?: "clip" | "word";
}): JSX.Element {
	const { theme } = useTheme();
	const window = createMemo(() => {
		const lines = props.body
			.split("\n")
			.map(line => replaceTabs(line).trim())
			.filter(Boolean);
		const limit = props.expanded ? BODY_LINES_EXPANDED : (props.collapsedLines ?? BODY_LINES_COLLAPSED);
		return { lines: lines.slice(0, limit), hidden: Math.max(0, lines.length - limit) };
	});
	return (
		<stack gap={0}>
			<For each={window().lines}>
				{line => (
					<Show
						when={props.wrap === "word"}
						fallback={
							<row gap={1}>
								<text color="dim">
									{props.indent ?? ""}
									{theme().symbol("md.quoteBorder")}
								</text>
								<text
									color={props.tone ?? "toolOutput"}
									grow={1}
									minWidth={1}
									wrap="clip"
									overflow="ellipsis"
									ellipsisColor={props.tone ?? "toolOutput"}
									ellipsisStyle={Style.RESET}
								>
									{line}
								</text>
							</row>
						}
					>
						<text wrap="word" overflow="clip">
							<span color="dim">
								{props.indent ?? ""}
								{theme().symbol("md.quoteBorder")}{" "}
							</span>
							<span color={props.tone ?? "toolOutput"}>{line}</span>
						</text>
					</Show>
				)}
			</For>
			<Show when={window().hidden > 0}>
				<row gap={1}>
					<text color="dim">
						{props.indent ?? ""}
						{theme().symbol("md.quoteBorder")}
					</text>
					<text color="dim">
						… +{window().hidden} more {window().hidden === 1 ? "line" : "lines"}{" "}
						<ExpandHint expanded={props.expanded} hasMore />
					</text>
				</row>
			</Show>
		</stack>
	);
}

function ReceiptRow(props: { readonly receipt: DeepReadonly<IrcDeliveryReceipt> }): JSX.Element {
	const { theme } = useTheme();
	const color = (): ThemeColor =>
		props.receipt.outcome === "woken"
			? "success"
			: props.receipt.outcome === "revived"
				? "warning"
				: props.receipt.outcome === "failed"
					? "error"
					: "accent";
	return (
		<text
			wrap="clip"
			overflow="ellipsis"
			ellipsisColor={props.receipt.error ? "error" : "toolOutput"}
			ellipsisStyle={Style.RESET}
		>
			<span color="toolOutput">{props.receipt.to}</span> <badge color={color()}>{props.receipt.outcome}</badge>
			<Show when={props.receipt.error}>
				{(value: Accessor<string>) => (
					<span color="error">
						{" "}
						{theme().format.dash} {value()}
					</span>
				)}
			</Show>
		</text>
	);
}

function MessageRow(props: {
	readonly message: DeepReadonly<IrcMessage>;
	readonly expanded: boolean;
	readonly now: () => number;
}): JSX.Element {
	const age = createMemo(() => messageAge(props.message.ts, props.now()));
	return (
		<stack gap={0}>
			<row gap={1}>
				<text color="accent">{props.message.from}</text>
				<Show when={age()}>{(value: Accessor<string>) => <text color="dim">{value()}</text>}</Show>
				<Show when={props.message.replyTo}>
					<badge color="muted">reply</badge>
				</Show>
			</row>
			<QuotedBody body={props.message.body} expanded={props.expanded} collapsedLines={1} />
		</stack>
	);
}

function PeerRow(props: { readonly peer: DeepReadonly<HubPeerInfo>; readonly now: () => number }): JSX.Element {
	const { theme } = useTheme();
	const age = createMemo(() => messageAge(props.peer.lastActivity, props.now()));
	const color = (): ThemeColor =>
		props.peer.status === "running"
			? "accent"
			: props.peer.status === "idle"
				? "success"
				: props.peer.status === "parked"
					? "muted"
					: "error";
	const glyph = () =>
		props.peer.status === "running"
			? theme().symbol("status.running")
			: props.peer.status === "idle"
				? theme().symbol("status.enabled")
				: props.peer.status === "parked"
					? theme().symbol("status.shadowed")
					: theme().symbol("status.aborted");
	return (
		<text wrap="clip" overflow="ellipsis" ellipsisStyle={Style.RESET}>
			<span color={color()}>
				{glyph()} {props.peer.status}
			</span>{" "}
			{replaceTabs(props.peer.id)} <span color="dim">{replaceTabs(props.peer.displayName)}</span>{" "}
			<span color="dim">
				{props.peer.parentId ? `${props.peer.kind} · of ${props.peer.parentId}` : props.peer.kind}
			</span>
			<Show when={props.peer.activity}>
				{(activity: Accessor<string>) => <span color="dim"> {replaceTabs(activity())}</span>}
			</Show>
			<Show when={props.peer.unread > 0}>
				{" "}
				<badge color="warning">{props.peer.unread} unread</badge>
			</Show>
			<Show when={age()}>{(value: Accessor<string>) => <span color="dim"> {value()}</span>}</Show>
		</text>
	);
}

function ReceivedMessage(props: {
	readonly message: DeepReadonly<IrcMessage>;
	readonly expanded: boolean;
	readonly now: () => number;
	readonly arrow: string;
	readonly indent?: string;
}): JSX.Element {
	return (
		<stack>
			<row gap={1}>
				<text>
					{props.indent ?? ""}
					<span color="dim">{props.arrow}</span> <span color="accent">{props.message.from}</span>
				</text>
				<Show when={messageAge(props.message.ts, props.now())}>
					{(value: Accessor<string>) => <text color="dim">{value()}</text>}
				</Show>
			</row>
			<QuotedBody body={props.message.body} expanded={props.expanded} indent={props.indent} />
		</stack>
	);
}

/** Render peer delivery, wait, inbox, and roster results with reactive metadata. */
export function MessagingBody(props: { readonly call: HubViewProps; readonly expanded: boolean }): JSX.Element {
	const { theme } = useTheme();
	const tick = useClock("second");
	const details = createMemo(() => coordinationDetails(props.call.details));
	const op = createMemo(() => details()?.op ?? props.call.args.op);
	const now = createMemo(() => currentTime(props.call, tick));
	const receipts = createMemo(() => details()?.receipts ?? []);
	const waited = createMemo(() => details()?.waited);
	const inbox = createMemo(() => details()?.inbox ?? []);
	const peers = createMemo(() =>
		[...(details()?.peers ?? [])].sort(
			(left, right) =>
				(LIST_STATUS_ORDER[left.status] ?? 9) - (LIST_STATUS_ORDER[right.status] ?? 9) ||
				right.lastActivity - left.lastActivity,
		),
	);
	const rosterMeta = createMemo(() => {
		const counts = details()?.counts;
		return counts
			? `${counts.running} running · ${counts.idle} idle · ${counts.parked} parked${counts.truncated > 0 ? ` · ${counts.truncated} truncated` : ""}`
			: undefined;
	});
	return (
		<Show
			when={props.call.outcome !== "failed"}
			fallback={
				<Show
					when={op() === "send"}
					fallback={
						<text
							color={op() === "wait" ? "muted" : "error"}
							wrap="clip"
							overflow="ellipsis"
							ellipsisColor={op() === "wait" ? "muted" : "error"}
							ellipsisStyle={Style.RESET}
						>
							{"  "}
							{props.call.args.op
								? outputText(props.call) || "IRC call failed."
								: outputText(props.call).replace(/^Error:\s*/u, "") || "Hub call failed."}
						</text>
					}
				>
					<stack gap={0}>
						<Show when={props.call.args.message?.trim()}>
							<QuotedBody
								body={props.call.args.message!}
								expanded={props.expanded}
								tone="dim"
								collapsedLines={1}
								indent="  "
							/>
						</Show>
						<Show
							when={receipts().length > 0}
							fallback={<text color="error">{outputText(props.call) || "Send failed."}</text>}
						>
							<TreeList
								items={receipts()}
								expanded={props.expanded}
								maxCollapsed={COLLAPSED_ITEM_LIMIT}
								itemType="recipient"
								renderItem={receipt => <ReceiptRow receipt={receipt} />}
							/>
						</Show>
					</stack>
				</Show>
			}
		>
			<Switch
				fallback={
					<Show when={props.call.phase === "settled"}>
						<text color="muted">
							{"  "}
							{outputText(props.call) || "Done."}
						</text>
					</Show>
				}
			>
				<Match when={op() === "send"}>
					<stack gap={0}>
						<Show
							when={receipts().length > 0}
							fallback={
								<Show
									when={props.call.phase === "settled"}
									fallback={
										<Show when={props.call.args.message?.trim()}>
											<QuotedBody
												body={props.call.args.message!}
												expanded={props.expanded}
												tone="dim"
												collapsedLines={1}
												indent="  "
												wrap="word"
											/>
										</Show>
									}
								>
									<text color="warning">{outputText(props.call) || "Nothing to deliver."}</text>
								</Show>
							}
						>
							<Show when={props.call.args.message?.trim()}>
								<QuotedBody
									body={props.call.args.message!}
									expanded={props.expanded}
									tone="dim"
									collapsedLines={1}
									indent="  "
								/>
							</Show>
							<Show when={receipts().length > 1 || receipts().some(receipt => receipt.outcome === "failed")}>
								<TreeList
									items={receipts()}
									expanded={props.expanded}
									maxCollapsed={COLLAPSED_ITEM_LIMIT}
									itemType="recipient"
									renderItem={receipt => <ReceiptRow receipt={receipt} />}
								/>
							</Show>
							<Show when={waited()}>
								{(value: Accessor<DeepReadonly<IrcMessage>>) => (
									<ReceivedMessage
										message={value()}
										expanded={props.expanded}
										now={now}
										arrow={theme().nav.back}
										indent="  "
									/>
								)}
							</Show>
							<Show when={waited() === null}>
								<text color="warning">No reply yet — they may answer later; check inbox or wait again.</text>
							</Show>
						</Show>
					</stack>
				</Match>
				<Match when={op() === "wait"}>
					<Show
						when={waited()}
						fallback={
							<Show when={props.call.phase === "settled"}>
								<text color="dim">
									{"  "}
									{outputText(props.call) || "No message arrived."}
								</text>
							</Show>
						}
					>
						{(value: Accessor<DeepReadonly<IrcMessage>>) => (
							<QuotedBody body={value().body} expanded={props.expanded} indent="  " />
						)}
					</Show>
				</Match>
				<Match when={op() === "inbox"}>
					<Show
						when={inbox().length > 0}
						fallback={
							<Show when={props.call.phase === "settled"}>
								<text color="dim">IRC inbox · empty</text>
							</Show>
						}
					>
						<TreeList
							items={inbox()}
							expanded={props.expanded}
							maxCollapsed={COLLAPSED_ITEM_LIMIT}
							itemType="message"
							renderItem={message => <MessageRow message={message} expanded={props.expanded} now={now} />}
						/>
					</Show>
				</Match>
				<Match when={op() === "list"}>
					<Show
						when={peers().length > 0}
						fallback={
							<Show when={props.call.phase === "settled"}>
								<text color="dim">{rosterMeta() ?? "no other agents"}</text>
							</Show>
						}
					>
						<Show when={rosterMeta()}>{(value: Accessor<string>) => <text color="dim">{value()}</text>}</Show>
						<TreeList
							items={peers()}
							expanded={props.expanded}
							maxCollapsed={COLLAPSED_ITEM_LIMIT}
							itemType="peer"
							renderItem={peer => <PeerRow peer={peer} now={now} />}
						/>
					</Show>
				</Match>
			</Switch>
		</Show>
	);
}
