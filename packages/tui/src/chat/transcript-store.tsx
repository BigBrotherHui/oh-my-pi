/**
 * Reactive transcript store and view.
 *
 * Backs onto B6's <transcript> host element and provides reactive append/remove/clear
 * store operations.
 */

import { batch, createSignal, For, Show, untrack, type Accessor, type JSX } from "../reactive";
import type { StableTranscriptRow } from "../host/intrinsics";

export type TranscriptBlockMode = "mutable" | "appendOnly";
export type TranscriptEntryState = "active" | "settled";

/**
 * One identity-stable piece of the mutable transcript tail.
 *
 * `view` is deliberately a factory: Solid evaluates it under the keyed block
 * owner, so replacement preserves all unrelated message owners and their
 * reactive subscriptions.
 */
export interface TranscriptEntry {
	readonly id: string;
	readonly view: () => JSX.Element;
	/** One-row live projection used under viewport pressure; never replaces scrollback content. */
	readonly compactView?: () => JSX.Element;
	readonly state: TranscriptEntryState;
	readonly mode: TranscriptBlockMode;
	readonly stableRows?: readonly StableTranscriptRow[];
	/** Declarative rendering of a requested immutable stable-prefix count. */
	readonly stableView?: (count: Accessor<number>) => JSX.Element;
	/** Drops publication state after a destructive native history reset. */
	readonly onResetStableRows?: () => void;
	/** Tool activity yields viewport space to conversation content and obeys its visibility toggle. */
	readonly toolActivity?: boolean;
	/** Receive the compositor's live output budget instead of estimating viewport chrome in leaf views. */
	readonly onAllocation?: (rows: number) => void;
}

export type TranscriptEntryInput = Omit<TranscriptEntry, "state" | "mode"> & {
	readonly state?: TranscriptEntryState;
	readonly mode?: TranscriptBlockMode;
};

export type TranscriptEntryPatch = Partial<Omit<TranscriptEntry, "id">>;

export interface TranscriptStore {
	/** Reactive, insertion-ordered source for the sole transcript `<For>`. */
	readonly entries: Accessor<readonly TranscriptEntry[]>;
	/** Changes only when the logical transcript is replaced, not on individual entry patches. */
	readonly generation: Accessor<number>;
	/** Adds a new live block. Duplicate identities are rejected rather than reordered. */
	append(entry: TranscriptEntryInput): void;
	/** Changes one existing block in place without remounting its siblings. */
	replace(id: string, patch: TranscriptEntryPatch): boolean;
	/** Whether the entire block remains mutable, with no emitted or in-flight history prefix. */
	canRemove(id: string): boolean;
	/** Mark a block as owned by an immutable history transaction. Called by the mounted transcript. */
	markRetired(id: string): void;
	/** Drops an uncommitted block; committed history remains owned by the compositor. */
	remove(id: string): boolean;
	clear(): void;
	setToolActivityVisible(visible: boolean): void;
	readonly toolActivityVisible: Accessor<boolean>;
	/** Read an entry's start row from the most recent mounted layout. */
	rowForEntry(id: string): number | undefined;
	/** Publish measured row positions from TranscriptView's host blocks. */
	setEntryRow(id: string, row: number): void;
}

interface OwnedTranscriptEntry {
	readonly entry: TranscriptEntry;
	retired: boolean;
	patch(patch: TranscriptEntryPatch): void;
}

function ownEntry(input: TranscriptEntryInput): OwnedTranscriptEntry {
	const [view, setView] = createSignal(input.view);
	const [compactView, setCompactView] = createSignal(input.compactView);
	const [state, setState] = createSignal<TranscriptEntryState>(input.state ?? "active");
	const [mode, setMode] = createSignal<TranscriptBlockMode>(input.mode ?? "mutable");
	const [stableRows, setStableRows] = createSignal(input.stableRows);
	const [stableView, setStableView] = createSignal(input.stableView);
	const [onResetStableRows, setOnResetStableRows] = createSignal(input.onResetStableRows);
	const [toolActivity, setToolActivity] = createSignal(input.toolActivity ?? false);
	const [onAllocation, setOnAllocation] = createSignal(input.onAllocation);
	return {
		retired: false,
		entry: {
			id: input.id,
			get view() {
				return view();
			},
			get compactView() {
				return compactView();
			},
			get state() {
				return state();
			},
			get mode() {
				return mode();
			},
			get stableRows() {
				return stableRows();
			},
			get stableView() {
				return stableView();
			},
			get onResetStableRows() {
				return onResetStableRows();
			},
			get toolActivity() {
				return toolActivity();
			},
			get onAllocation() {
				return onAllocation();
			},
		},
		patch(patch) {
			batch(() => {
				const nextView = patch.view;
				if (nextView !== undefined) setView(() => nextView);
				if ("compactView" in patch) setCompactView(() => patch.compactView);
				if (patch.state !== undefined) setState(patch.state);
				if (patch.mode !== undefined) setMode(patch.mode);
				if ("stableRows" in patch) setStableRows(patch.stableRows);
				if ("stableView" in patch) setStableView(() => patch.stableView);
				if ("onResetStableRows" in patch) setOnResetStableRows(() => patch.onResetStableRows);
				if ("toolActivity" in patch) setToolActivity(patch.toolActivity ?? false);
				if ("onAllocation" in patch) setOnAllocation(() => patch.onAllocation);
			});
		},
	};
}

/** Create an in-memory reactive transcript store. */
export function createTranscriptStore(): TranscriptStore {
	const [entries, setEntries] = createSignal<readonly TranscriptEntry[]>([]);
	const [generation, setGeneration] = createSignal(0);
	const owned = new Map<string, OwnedTranscriptEntry>();
	const [toolActivityVisible, setToolActivityVisible] = createSignal<boolean>(true);
	const entryRows = new Map<string, number>();

	return {
		entries,
		generation,
		append(input: TranscriptEntryInput): void {
			if (owned.has(input.id)) throw new Error(`Transcript entry already exists: ${input.id}`);
			const item = ownEntry(input);
			owned.set(input.id, item);
			setEntries(previous => [...previous, item.entry]);
		},
		replace(id: string, patch: TranscriptEntryPatch): boolean {
			const item = owned.get(id);
			if (!item) return false;
			item.patch(patch);
			return true;
		},
		canRemove: id => owned.get(id)?.retired === false,
		markRetired(id) {
			const item = owned.get(id);
			if (item) item.retired = true;
		},
		remove(id: string): boolean {
			const item = owned.get(id);
			if (!item || item.retired) return false;
			owned.delete(id);
			entryRows.delete(id);
			setEntries(previous => previous.filter(entry => entry.id !== id));
			return true;
		},
		clear(): void {
			batch(() => {
				owned.clear();
				entryRows.clear();
				setEntries([]);
				setGeneration(previous => previous + 1);
			});
		},
		setToolActivityVisible,
		toolActivityVisible,
		rowForEntry: id => entryRows.get(id),
		setEntryRow: (id, row) => {
			entryRows.set(id, row);
		},
	};
}

export interface TranscriptViewProps {
	readonly store: TranscriptStore;
	/** Persistent header; factories keep timed resources inside the header's retireable owner. */
	readonly header?: JSX.Element | (() => JSX.Element);
	readonly headerSettled?: boolean;
}

function TranscriptEntryView(props: { readonly entry: TranscriptEntry; readonly store: TranscriptStore }): JSX.Element {
	const [compact, setCompact] = createSignal(false);
	const [stableCount, setStableCount] = createSignal(0);
	const visible = () => !props.entry.toolActivity || props.store.toolActivityVisible();
	return (
		<transcript-block
			settled={props.entry.state === "settled"}
			mode={props.entry.mode}
			stableRows={props.entry.stableRows}
			stable={
				<Show when={props.entry.stableView} keyed>
					{(view: (count: Accessor<number>) => JSX.Element) => untrack(() => view(stableCount))}
				</Show>
			}
			onStableRender={setStableCount}
			onResetStableRows={() => {
				setStableCount(0);
				props.entry.onResetStableRows?.();
			}}
			toolActivity={props.entry.toolActivity}
			onAllocation={props.entry.onAllocation}
			onCompact={setCompact}
			compact={
				<Show when={compact() && visible()}>
					<Show when={props.entry.compactView} keyed>
						{(view: () => JSX.Element) => untrack(view)}
					</Show>
				</Show>
			}
			onRetire={() => props.store.markRetired(props.entry.id)}
			onRowLayout={(row: number) => props.store.setEntryRow(props.entry.id, row)}
		>
			<Show when={visible()}>{props.entry.view()}</Show>
		</transcript-block>
	);
}

/** Render a reactive transcript store through the <transcript> host element. */
export function TranscriptView(props: TranscriptViewProps): JSX.Element {
	const header = (): JSX.Element => {
		const content = props.header;
		return typeof content === "function" ? content() : content;
	};
	return (
		<transcript generation={props.store.generation()}>
			<Show when={props.header}>
				<transcript-block settled={props.headerSettled !== false}>{header()}</transcript-block>
			</Show>
			<For each={props.store.entries()}>{entry => <TranscriptEntryView entry={entry} store={props.store} />}</For>
		</transcript>
	);
}
