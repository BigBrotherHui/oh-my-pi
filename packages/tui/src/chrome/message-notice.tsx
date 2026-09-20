import { createMemo, createSignal, For, Show, type Accessor, type JSX } from "../reactive";
import { Style, type Color } from "../core/style";
import type { ThemeBg, ThemeColor } from "../theme/schema";

/** Render-time state supplied to a notice presentation. */
export interface MessageNoticeContext {
	readonly expanded: boolean;
}

/** Header and optional detail rows rendered inside a notice frame. */
export interface MessageNoticePresentation {
	readonly header: string;
	readonly icon?: string;
	readonly body?: JSX.Element | readonly JSX.Element[];
}

export type MessageNoticePresentationFactory = (context: MessageNoticeContext) => MessageNoticePresentation;
export type MessageNoticePresentationSource = MessageNoticePresentation | MessageNoticePresentationFactory;
export type MessageNoticeBackground = ThemeBg | Color | Style;
type ControlledBoolean = boolean | Accessor<boolean>;

/** Reactive input for a transcript notice. */
export interface MessageNoticeViewProps {
	readonly presentation: MessageNoticePresentationSource;
	readonly expanded?: ControlledBoolean;
	readonly visible?: ControlledBoolean;
	readonly severity?: ThemeColor;
	readonly background?: MessageNoticeBackground;
	readonly leadingSpace?: boolean;
}

/** Mutable adapter for historical controller-driven notice updates. */
export interface MessageNoticeModel {
	readonly expanded: boolean;
	readonly visible: boolean;
	setExpanded(expanded: boolean): void;
	isExpanded(): boolean;
	setToolActivityVisible(visible: boolean): void;
	refresh(): void;
	view(): JSX.Element;
}

/** Factory options for a controller-owned transcript notice. */
export interface MessageNoticeOptions {
	readonly presentation: MessageNoticePresentationFactory;
	readonly severity?: ThemeColor;
	readonly background?: MessageNoticeBackground;
	readonly leadingSpace?: boolean;
}

/** Reactive notice card retaining the historical inverse severity frame and row layout. */
export function MessageNoticeView(props: MessageNoticeViewProps): JSX.Element {
	const expanded = createMemo(() => {
		const value = props.expanded;
		return value === undefined ? false : typeof value === "function" ? value() : value;
	});
	const visible = createMemo(() => {
		const value = props.visible;
		return value === undefined ? true : typeof value === "function" ? value() : value;
	});
	const presentation = createMemo(() => {
		const source = props.presentation;
		return typeof source === "function" ? source({ expanded: expanded() }) : source;
	});
	const body = createMemo(() => {
		const value = presentation().body;
		return value === undefined ? [] : Array.isArray(value) ? value : [value];
	});
	const background = createMemo(() => props.background);
	const backgroundStyle = createMemo(() => {
		const value = background();
		return value instanceof Style ? value : undefined;
	});
	const backgroundColor = createMemo(() => {
		const value = background();
		return value instanceof Style ? undefined : value;
	});
	const customBackground = createMemo(() => background() !== undefined);

	return (
		<Show when={visible()}>
			<stack>
				<Show when={props.leadingSpace !== false}>
					<br />
				</Show>
				<box
					background={backgroundColor()}
					style={backgroundStyle()}
					color={customBackground() ? undefined : (props.severity ?? "accent")}
					inverse={!customBackground()}
					padding={1}
				>
					<stack>
						<text wrap="word">
							{presentation().icon ? `${presentation().icon} ${presentation().header}` : presentation().header}
						</text>
						<Show when={body().length > 0}>
							<br />
						</Show>
						<For each={body()}>{item => item}</For>
					</stack>
				</box>
			</stack>
		</Show>
	);
}

/** Create a controller-owned notice with historical expansion, visibility, and refresh hooks. */
export function createMessageNoticeModel(options: MessageNoticeOptions): MessageNoticeModel {
	const [expanded, setExpanded] = createSignal(false);
	const [visible, setVisible] = createSignal(true);
	const [revision, setRevision] = createSignal(0);
	const presentation = (): MessageNoticePresentation => {
		revision();
		return options.presentation({ expanded: expanded() });
	};

	return {
		get expanded() {
			return expanded();
		},
		get visible() {
			return visible();
		},
		setExpanded(next) {
			if (expanded() !== next) setExpanded(next);
		},
		isExpanded() {
			return expanded();
		},
		setToolActivityVisible(next) {
			if (visible() !== next) setVisible(next);
		},
		refresh() {
			setRevision(value => value + 1);
		},
		view() {
			return (
				<MessageNoticeView
					presentation={presentation}
					expanded={expanded}
					visible={visible}
					severity={options.severity}
					background={options.background}
					leadingSpace={options.leadingSpace}
				/>
			);
		},
	};
}
