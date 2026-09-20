import { replaceTabs } from "../render/render-utils";
import { For, createSignal, useTightLayout, type Accessor, type JSX } from "../reactive";

/**
 * One compact transcript status row. Parts retain their individual semantic
 * styles; absent and empty parts do not leave separator gaps.
 */
export interface TranscriptStatusRow {
	readonly parts: readonly (JSX.Element | undefined)[];
	/** Horizontal inset on both sides, matching the historical Text padding. */
	readonly indent?: number;
}

export interface TranscriptStatusViewProps {
	/** Static persisted rows or a live source for an active transcript block. */
	readonly rows: readonly TranscriptStatusRow[] | Accessor<readonly TranscriptStatusRow[]>;
}

/**
 * Mutable row source for status blocks that receive a supplemental line after
 * their initial status. It replaces the legacy block's imperative `addLine`
 * without retaining a detached host node.
 */
export interface TranscriptStatusController {
	readonly rows: Accessor<readonly TranscriptStatusRow[]>;
	setRows(rows: readonly TranscriptStatusRow[]): void;
	addLine(text: JSX.Element, indent?: number): void;
}

function rowParts(parts: readonly (JSX.Element | undefined)[]): readonly JSX.Element[] {
	const visible = parts.filter((part): part is JSX.Element => Boolean(part));
	return visible.map(part => (typeof part === "string" ? replaceTabs(part) : part));
}

function TranscriptStatusRowView(props: { readonly row: TranscriptStatusRow }): JSX.Element {
	const tight = useTightLayout();
	const parts = rowParts(props.row.parts);
	return (
		<box padding={{ x: tight() ? Math.max(0, (props.row.indent ?? 1) - 1) : (props.row.indent ?? 1) }}>
			<text>
				{parts.map((part, index) => (
					<>
						{index === 0 ? null : " "}
						{part}
					</>
				))}
			</text>
		</box>
	);
}

/** Create a controlled, dynamically updating source for compact status rows. */
export function createTranscriptStatusController(
	initialRows: readonly TranscriptStatusRow[] = [],
): TranscriptStatusController {
	const [rows, setRows] = createSignal(initialRows);
	return {
		rows,
		setRows,
		addLine(text, indent = 1) {
			setRows(previous => [...previous, { parts: [text], indent }]);
		},
	};
}

/**
 * Compact transcript status rows. Each row uses the legacy symmetric one-cell
 * inset by default, removes that cell in tight layout, and word-wraps within
 * the resulting inset at narrow terminal widths.
 */
export function TranscriptStatusView(props: TranscriptStatusViewProps): JSX.Element {
	return (
		<stack>
			<For each={typeof props.rows === "function" ? props.rows() : props.rows}>
				{row => <TranscriptStatusRowView row={row} />}
			</For>
		</stack>
	);
}
