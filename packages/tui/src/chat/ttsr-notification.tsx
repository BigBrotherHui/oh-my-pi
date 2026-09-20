import { createStore, For, Show, type JSX } from "../reactive";

/** Rule fields shown in rewind notifications. */
export interface NotificationRule {
	readonly name: string;
	readonly description?: string;
	readonly content?: string;
}

/** Collapsed notifications show at most this many rules. */
const MAX_COLLAPSED_RULES = 4;

export interface TtsrNotificationViewProps {
	readonly rules: readonly NotificationRule[];
	readonly expanded: boolean;
	readonly visible: boolean;
}

interface TtsrNotificationState {
	rules: NotificationRule[];
	expanded: boolean;
	visible: boolean;
}

/**
 * Reactive state for one TTSR transcript block.
 *
 * Consecutive trigger events merge rules into the live model. The caller owns
 * the block's transcript lifetime and uses {@link view} when it mounts it.
 */
export interface TtsrNotificationModel {
	readonly rules: readonly NotificationRule[];
	readonly expanded: boolean;
	readonly visible: boolean;
	addRules(rules: readonly NotificationRule[]): void;
	setExpanded(expanded: boolean): void;
	setVisible(visible: boolean): void;
	view(): JSX.Element;
}

/** Create a mutable TTSR notification while preserving rule arrival order. */
export function createTtsrNotificationModel(rules: readonly NotificationRule[]): TtsrNotificationModel {
	const [state, setState] = createStore<TtsrNotificationState>({
		rules: [...rules],
		expanded: false,
		visible: true,
	});

	return {
		get rules() {
			return state.rules;
		},
		get expanded() {
			return state.expanded;
		},
		get visible() {
			return state.visible;
		},
		addRules(nextRules) {
			const names = new Set(state.rules.map(rule => rule.name));
			const additions: NotificationRule[] = [];
			for (const rule of nextRules) {
				if (names.has(rule.name)) continue;
				names.add(rule.name);
				additions.push(rule);
			}
			if (additions.length > 0) setState("rules", rules => [...rules, ...additions]);
		},
		setExpanded(expanded) {
			if (state.expanded !== expanded) setState("expanded", expanded);
		},
		setVisible(visible) {
			if (state.visible !== visible) setState("visible", visible);
		},
		view() {
			return <TtsrNotificationView rules={state.rules} expanded={state.expanded} visible={state.visible} />;
		},
	};
}

function ruleDescription(rule: NotificationRule): string | undefined {
	return (rule.description || rule.content)?.trim();
}

function SingleRuleHeader(props: { readonly rule: NotificationRule }): JSX.Element {
	return (
		<text>
			<icon name="icon.warning" /> Injecting rule: <span bold>{props.rule.name}</span>
			{"  "}
			<icon name="icon.rewind" />
		</text>
	);
}

function SingleRuleBody(props: { readonly rule: NotificationRule; readonly expanded: boolean }): JSX.Element | null {
	const description = () => ruleDescription(props.rule);
	const truncated = () => !props.expanded && (description()?.split("\n").length ?? 0) > 2;
	const displayText = () => {
		const text = description();
		if (!text || !truncated()) return text;
		return `${text.split("\n").slice(0, 2).join("\n")}…`;
	};

	return (
		<Show when={description()}>
			<stack>
				<br />
				<text italic>{displayText()}</text>
				<Show when={truncated()}>
					<text italic> (ctrl+o to expand)</text>
				</Show>
			</stack>
		</Show>
	);
}

function MultiRuleHeader(props: { readonly count: number }): JSX.Element {
	return (
		<text>
			<icon name="icon.warning" /> Injecting {props.count} rules:{"  "}
			<icon name="icon.rewind" />
		</text>
	);
}

function RuleLine(props: { readonly rule: NotificationRule; readonly expanded: boolean }): JSX.Element {
	const description = () => ruleDescription(props.rule);
	const displayText = () => {
		const text = description();
		if (!text || props.expanded) return text;
		const newline = text.indexOf("\n");
		return newline === -1 ? text : `${text.slice(0, newline).trimEnd()}…`;
	};

	return (
		<text>
			<span bold>{props.rule.name}</span>
			<Show when={description()}>
				: <span italic>{displayText()}</span>
			</Show>
		</text>
	);
}

function MultiRuleBody(props: {
	readonly rules: readonly NotificationRule[];
	readonly expanded: boolean;
}): JSX.Element | null {
	const shown = () => (props.expanded ? props.rules : props.rules.slice(0, MAX_COLLAPSED_RULES));
	const hidden = () => props.rules.length - shown().length;
	const elidedDetail = () =>
		!props.expanded &&
		shown().some(rule => {
			const description = ruleDescription(rule);
			return description !== undefined && description.includes("\n");
		});

	return (
		<Show when={props.rules.length > 0}>
			<stack>
				<br />
				<For each={shown()}>{rule => <RuleLine rule={rule} expanded={props.expanded} />}</For>
				<Show
					when={hidden() > 0}
					fallback={
						<Show when={elidedDetail()}>
							<text italic> (ctrl+o to expand)</text>
						</Show>
					}
				>
					<text italic>{`… +${hidden()} more (ctrl+o to expand)`}</text>
				</Show>
			</stack>
		</Show>
	);
}

/** Rewind-rule transcript notice with controlled expansion and visibility. */
export function TtsrNotificationView(props: TtsrNotificationViewProps): JSX.Element {
	return (
		<Show when={props.visible}>
			<stack>
				<br />
				<box color="warning" inverse padding={1}>
					<Show
						when={props.rules.length === 1}
						fallback={
							<stack>
								<MultiRuleHeader count={props.rules.length} />
								<MultiRuleBody rules={props.rules} expanded={props.expanded} />
							</stack>
						}
					>
						<stack>
							<SingleRuleHeader rule={props.rules[0]!} />
							<SingleRuleBody rule={props.rules[0]!} expanded={props.expanded} />
						</stack>
					</Show>
				</box>
			</stack>
		</Show>
	);
}
