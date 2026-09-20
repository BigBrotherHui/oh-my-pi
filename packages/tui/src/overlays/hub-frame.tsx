import { createSignal, For, Show, type JSX } from "../reactive";
import type { SplitPaneLayout, SplitPaneSize } from "../host/elements/split";
import { matchesKey } from "../keys";
import type { ThemeColor } from "../theme/schema";

/** A scope row shared by fullscreen hubs, with hub-specific kinds and metadata. */
export interface SidebarEntry<TKind extends string> {
	id: string;
	kind: TKind;
	label: string;
	annotation?: string;
}
export interface StripChip<TAction> {
	label: string;
	action: TAction;
}
export interface StripState<TChip extends StripChip<unknown>> {
	chips: TChip[];
	index: number;
}
export interface ChipRange {
	start: number;
	end: number;
	index: number;
}
export interface SidebarStyle {
	icon: string;
	iconColor?: ThemeColor;
	annotation: string;
	annotationColor?: ThemeColor;
	muted?: boolean;
	hovered?: boolean;
	padTruncated?: boolean;
}
export interface HubFrameViewProps {
	readonly title: string;
	readonly sidebar?: JSX.Element;
	readonly body: JSX.Element;
	readonly footer?: JSX.Element;
	/** Sidebar content width; the historical hubs constrain this to 16–24 columns. */
	readonly sidebarWidth?: number;
	/** Native sidebar sizing constraints; takes precedence over a fixed sidebarWidth. */
	readonly sidebarSize?: SplitPaneSize;
	/** Actual pane allocation, for width-aware content such as model metrics. */
	readonly onPaneLayout?: (layout: SplitPaneLayout) => void;
	/** Disable frame-owned scrolling when pane content manages its own viewport. */
	readonly scrollPanes?: boolean;
	/** Independently controlled sidebar viewport offset. */
	readonly sidebarOffset?: number;
	/** Independently controlled detail viewport offset. */
	readonly bodyOffset?: number;
	/**
	 * Terminal rows available to the frame, including its chrome. Historical
	 * fullscreen hubs defaulted to 14 rows: ten content rows plus four rows for
	 * top, divider, footer, and bottom.
	 */
	readonly viewportHeight?: number;
}

function frameContentRows(viewportHeight: number | undefined, hasFooter: boolean): number {
	const chromeRows = hasFooter ? 4 : 2;
	return Math.max(0, Math.trunc(viewportHeight ?? (hasFooter ? 14 : 12)) - chromeRows);
}

function HubPaneView(props: {
	readonly content: JSX.Element;
	readonly height: number;
	readonly offset?: number;
	readonly scrolling: boolean;
}): JSX.Element {
	return (
		<scroll
			height={props.height}
			offset={props.scrolling ? props.offset : 0}
			scrollbar={props.scrolling ? "auto" : "never"}
			followTail={false}
		>
			{props.content}
		</scroll>
	);
}

/** Shared fullscreen split frame with independently scrolling sidebar and detail panes. */
export function HubFrameView(props: HubFrameViewProps): JSX.Element {
	const contentRows = () => frameContentRows(props.viewportHeight, props.footer !== undefined);
	const [layout, setLayout] = createSignal<SplitPaneLayout>();
	const sidebarWidth = () =>
		layout()?.leftWidth ?? props.sidebarSize?.fixed ?? props.sidebarSize?.min ?? props.sidebarWidth ?? 24;
	const junctions = () => (props.sidebar && layout()?.split !== false ? [sidebarWidth() + 3] : undefined);
	return (
		<frame
			title={props.title}
			height={props.viewportHeight}
			paddingX={1}
			paddingY={0}
			borderPolicy="always"
			renderEmpty
			topDividerCols={junctions()}
			bottomDividerCols={props.footer ? [] : undefined}
			dividerCols={props.footer ? junctions() : undefined}
		>
			<Show
				when={props.sidebar}
				fallback={
					<HubPaneView
						content={props.body}
						height={contentRows()}
						offset={props.bodyOffset}
						scrolling={props.scrollPanes !== false}
					/>
				}
			>
				<split
					leftSize={props.sidebarSize ?? { fixed: props.sidebarWidth ?? 24 }}
					height={contentRows()}
					divider=" │ "
					onLayout={value => {
						setLayout(value);
						props.onPaneLayout?.(value);
					}}
				>
					<HubPaneView
						content={props.sidebar}
						height={contentRows()}
						offset={props.sidebarOffset}
						scrolling={props.scrollPanes !== false}
					/>
					<HubPaneView
						content={props.body}
						height={contentRows()}
						offset={props.bodyOffset}
						scrolling={props.scrollPanes !== false}
					/>
				</split>
			</Show>
			<Show when={props.footer}>
				<hr variant="frame" />
				<box height={1}>{props.footer}</box>
			</Show>
		</frame>
	);
}

/** Cycle a footer strip selection. */
export function moveStripSelection(strip: StripState<StripChip<unknown>>, data: string): boolean {
	if (strip.chips.length === 0) return false;
	if (matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
		strip.index = (strip.index + strip.chips.length - 1) % strip.chips.length;
		return true;
	}
	if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) {
		strip.index = (strip.index + 1) % strip.chips.length;
		return true;
	}
	return false;
}

export function SidebarList<TKind extends string>(props: {
	entries: readonly SidebarEntry<TKind>[];
	selectedId?: string;
	onSelect?: (entry: SidebarEntry<TKind>) => void;
}): JSX.Element {
	return (
		<stack>
			<For each={props.entries}>
				{entry => (
					<text color={entry.id === props.selectedId ? "accent" : undefined}>
						{entry.id === props.selectedId ? "› " : "  "}
						{entry.label}
						{entry.annotation ? <span color="dim"> {entry.annotation}</span> : null}
					</text>
				)}
			</For>
		</stack>
	);
}
