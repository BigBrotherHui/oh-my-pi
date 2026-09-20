import { createEffect, createMemo, createSignal, For, Show, type Accessor, type JSX } from "../reactive";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import type { ScrollViewportState } from "../host/elements/scroll";

/** Semantic role of a wizard step's primary interactive content. */
export type WizardStepKind = "input" | "choice" | "confirm" | "async" | "custom";

/** A retained JSX slot that may yield to the primary content on short screens. */
export interface WizardStepSlot {
	readonly children?: JSX.Element;
	readonly optional?: boolean;
}

type RowLimit = number | Accessor<number>;
type SlotRole = "heading" | "intro" | "content" | "status" | "footer";

function count(value: number | undefined, fallback = 0): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.trunc(value));
}

function readLimit(value: RowLimit | undefined): number | undefined {
	const resolved = typeof value === "function" ? value() : value;
	return resolved === undefined || !Number.isFinite(resolved) ? undefined : Math.max(0, Math.trunc(resolved));
}

function present(value: JSX.Element | undefined): value is JSX.Element {
	return value !== undefined && value !== null && value !== false;
}

function SlotView(props: { readonly role: SlotRole; readonly children?: JSX.Element }): JSX.Element {
	if (!present(props.children)) return null;
	if (typeof props.children !== "string" && typeof props.children !== "number") return props.children;
	switch (props.role) {
		case "heading":
			return (
				<text bold wrap="word">
					{props.children}
				</text>
			);
		case "intro":
			return (
				<text color="muted" wrap="word">
					{props.children}
				</text>
			);
		case "status":
			return (
				<text color="success" wrap="word">
					{props.children}
				</text>
			);
		case "footer":
			return (
				<text color="muted" wrap="word">
					{props.children}
				</text>
			);
		case "content":
			return <text wrap="word">{props.children}</text>;
	}
}

function MeasuredSlot(props: {
	readonly children: JSX.Element;
	readonly limit: Accessor<number>;
	onRows(rows: number): void;
}): JSX.Element {
	return (
		<scroll
			height={props.limit()}
			scrollbar="never"
			shrinkToFit
			onViewport={(viewport: ScrollViewportState) => props.onRows(viewport.totalRows)}
		>
			{props.children}
		</scroll>
	);
}

function Gap(props: { readonly visible: Accessor<boolean>; readonly rows: Accessor<number> }): JSX.Element {
	return (
		<Show when={props.visible()}>
			<For each={Array.from({ length: props.rows() })}>{() => <text> </text>}</For>
		</Show>
	);
}

export interface WizardStepViewProps {
	readonly heading?: JSX.Element;
	readonly intro?: JSX.Element;
	readonly preview?: WizardStepSlot;
	/** `content` is the explicit equivalent of the historical required slot. */
	readonly content?: JSX.Element;
	/** Standard JSX spelling for the primary content slot. */
	readonly children?: JSX.Element;
	readonly status?: JSX.Element;
	readonly footer?: JSX.Element;
	/** Blank rows between adjacent non-empty slots. Defaults to one. */
	readonly gap?: number;
	/** Minimum useful primary-content rows required before an optional preview remains visible. */
	readonly minContentLines?: number;
	/** Explicit complete-step row budget, matching the historical `setMaxHeight`. */
	readonly maxHeight?: RowLimit;
	/** Reactive parent-provided row budget for a bounded wizard body. */
	readonly availableRows?: Accessor<number>;
	/** Notified with the row budget remaining for the primary content, or `undefined` when unbounded. */
	readonly fitContent?: (maxLines: number | undefined) => void;
	/** Forwarded to the primary content's existing key controller. */
	readonly onKey?: (event: HostKeyEvent) => void;
	/**
	 * Receives pointer events in primary-content-local coordinates. Wheel
	 * events retain the historical behaviour of routing regardless of pointer
	 * position.
	 */
	readonly onMouse?: (event: HostMouseEvent, contentRow: number) => void;
	/** Optional focus order for a primary-content controller. */
	readonly tabIndex?: number;
}

/**
 * Reusable bounded presentation for input, choice, confirmation, and async
 * wizard steps. Slots remain retained across reflow; optional previews yield
 * first, then the primary slot receives the exact remaining viewport budget.
 */
export function WizardStepView(props: WizardStepViewProps): JSX.Element {
	const [headingRows, setHeadingRows] = createSignal(0);
	const [introRows, setIntroRows] = createSignal(0);
	const [previewRows, setPreviewRows] = createSignal(0);
	const [contentRows, setContentRows] = createSignal(0);
	const [statusRows, setStatusRows] = createSignal(0);
	const [footerRows, setFooterRows] = createSignal(0);
	const content = (): JSX.Element | undefined => (props.content === undefined ? props.children : props.content);
	const limit = createMemo(() => readLimit(props.maxHeight) ?? readLimit(props.availableRows));
	const gap = createMemo(() => count(props.gap, 1));
	const minContentLines = createMemo(() => count(props.minContentLines, 1));
	const setRows = (set: (value: number | ((previous: number) => number)) => void, rows: number): void => {
		const next = count(rows);
		set(previous => (previous === next ? previous : next));
	};
	const headingVisible = (): boolean => present(props.heading) && headingRows() > 0;
	const introVisible = (): boolean => present(props.intro) && introRows() > 0;
	const previewVisible = (): boolean => present(props.preview?.children) && previewRows() > 0 && previewShown();
	const statusVisible = (): boolean => present(props.status) && statusRows() > 0;
	const footerVisible = (): boolean => present(props.footer) && footerRows() > 0;
	const contentPresent = (): boolean => present(content());
	const previewShown = (): boolean => {
		if (!present(props.preview?.children) || props.preview?.optional !== true)
			return present(props.preview?.children);
		const maxHeight = limit();
		if (maxHeight === undefined) return true;
		const fixedCount =
			Number(headingVisible()) + Number(introVisible()) + Number(statusVisible()) + Number(footerVisible());
		const requiredSlots = fixedCount + Number(contentPresent());
		const fixedRows =
			(headingVisible() ? headingRows() : 0) +
			(introVisible() ? introRows() : 0) +
			(statusVisible() ? statusRows() : 0) +
			(footerVisible() ? footerRows() : 0);
		const requiredRows =
			fixedRows + Math.max(0, requiredSlots - 1) * gap() + (contentPresent() ? minContentLines() : 0);
		return requiredRows + previewRows() + (requiredSlots > 0 ? gap() : 0) <= maxHeight;
	};
	const contentBudget = createMemo(() => {
		const maxHeight = limit();
		if (maxHeight === undefined) return undefined;
		if (!contentPresent()) return 0;
		const surroundingRows =
			(headingVisible() ? headingRows() : 0) +
			(introVisible() ? introRows() : 0) +
			(previewVisible() ? previewRows() : 0) +
			(statusVisible() ? statusRows() : 0) +
			(footerVisible() ? footerRows() : 0);
		const surroundingCount =
			Number(headingVisible()) +
			Number(introVisible()) +
			Number(previewVisible()) +
			Number(statusVisible()) +
			Number(footerVisible());
		return Math.max(0, maxHeight - surroundingRows - surroundingCount * gap());
	});
	const measurementLimit = (): number => limit() ?? Number.MAX_SAFE_INTEGER;
	const contentVisibleRows = (): number => contentRows();
	const contentStart = (): number => {
		if (contentVisibleRows() === 0) return -1;
		let rows = 0;
		if (headingVisible()) rows += headingRows();
		if (introVisible()) rows += (rows > 0 ? gap() : 0) + introRows();
		if (previewVisible()) rows += (rows > 0 ? gap() : 0) + previewRows();
		return rows + (rows > 0 ? gap() : 0);
	};
	const routeMouse = (event: HostMouseEvent): void => {
		if (!props.onMouse) return;
		const contentRow = event.localRow - contentStart();
		if (event.action !== "wheel" && (contentRow < 0 || contentRow >= contentVisibleRows())) return;
		props.onMouse(event, contentRow);
		event.stopPropagation();
	};

	createEffect(() => {
		props.fitContent?.(contentBudget());
	});

	return (
		<box tabIndex={props.tabIndex} onKey={props.onKey} onMouse={routeMouse}>
			<scroll height={measurementLimit()} scrollbar="never" shrinkToFit>
				<Show when={present(props.heading)}>
					<MeasuredSlot limit={measurementLimit} onRows={rows => setRows(setHeadingRows, rows)}>
						<SlotView role="heading">{props.heading}</SlotView>
					</MeasuredSlot>
				</Show>
				<Gap visible={() => present(props.heading) && present(props.intro)} rows={gap} />
				<Show when={present(props.intro)}>
					<MeasuredSlot limit={measurementLimit} onRows={rows => setRows(setIntroRows, rows)}>
						<SlotView role="intro">{props.intro}</SlotView>
					</MeasuredSlot>
				</Show>
				<Gap
					visible={() =>
						present(props.preview?.children) && previewShown() && (present(props.heading) || present(props.intro))
					}
					rows={gap}
				/>
				<Show when={present(props.preview?.children) && previewShown()}>
					<MeasuredSlot limit={measurementLimit} onRows={rows => setRows(setPreviewRows, rows)}>
						<SlotView role="content">{props.preview?.children}</SlotView>
					</MeasuredSlot>
				</Show>
				<Gap
					visible={() => contentPresent() && (present(props.heading) || present(props.intro) || previewVisible())}
					rows={gap}
				/>
				<Show when={contentPresent()}>
					<scroll
						height={contentBudget() ?? Number.MAX_SAFE_INTEGER}
						scrollbar="never"
						shrinkToFit
						onViewport={viewport => setRows(setContentRows, viewport.height)}
					>
						<SlotView role="content">{content()}</SlotView>
					</scroll>
				</Show>
				<Gap
					visible={() =>
						present(props.status) &&
						(present(props.heading) || present(props.intro) || previewVisible() || contentPresent())
					}
					rows={gap}
				/>
				<Show when={present(props.status)}>
					<MeasuredSlot limit={measurementLimit} onRows={rows => setRows(setStatusRows, rows)}>
						<SlotView role="status">{props.status}</SlotView>
					</MeasuredSlot>
				</Show>
				<Gap
					visible={() =>
						present(props.footer) &&
						(present(props.heading) ||
							present(props.intro) ||
							previewVisible() ||
							contentPresent() ||
							present(props.status))
					}
					rows={gap}
				/>
				<Show when={present(props.footer)}>
					<MeasuredSlot limit={measurementLimit} onRows={rows => setRows(setFooterRows, rows)}>
						<SlotView role="footer">{props.footer}</SlotView>
					</MeasuredSlot>
				</Show>
			</scroll>
		</box>
	);
}
