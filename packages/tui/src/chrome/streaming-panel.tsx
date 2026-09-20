import { For, type JSX } from "../reactive";

/** A present streaming region, or a group of rows that share a trailing gap. */
export type StreamingPanelSection = JSX.Element | readonly JSX.Element[] | undefined;

/** Footer content evaluated again when its external state changes. */
export type StreamingPanelFooter = JSX.Element | (() => JSX.Element);

/** One refresh of a streaming overlay's presentation. */
export interface StreamingPanelPresentation {
	/** Non-empty sections separated by one blank row. */
	readonly sections: readonly StreamingPanelSection[];
	/** Use a provider when action availability may change without a controller transition. */
	readonly footer: StreamingPanelFooter;
}

export interface StreamingPanelViewProps extends StreamingPanelPresentation {}

function isSectionList(value: Exclude<StreamingPanelSection, undefined>): value is readonly JSX.Element[] {
	return Array.isArray(value);
}

function StreamingPanelSectionView(props: { readonly section: StreamingPanelSection }): JSX.Element | null {
	const section = props.section;
	if (!section) return null;
	const children = isSectionList(section) ? section : [section];
	if (children.length === 0) return null;
	return (
		<>
			<For each={children}>{child => child}</For>
			<br />
		</>
	);
}

function StreamingPanelFooterView(props: { readonly footer: StreamingPanelFooter }): JSX.Element {
	const footer = () => (typeof props.footer === "function" ? props.footer() : props.footer);
	return <text wrap="word">{footer()}</text>;
}

/**
 * Shared body/footer shell for streaming overlays. Present sections retain
 * their owners, while a footer provider remains live between transitions.
 */
export function StreamingPanelView(props: StreamingPanelViewProps): JSX.Element {
	return (
		<stack>
			<br />
			<For each={props.sections}>{section => <StreamingPanelSectionView section={section} />}</For>
			<StreamingPanelFooterView footer={props.footer} />
		</stack>
	);
}
