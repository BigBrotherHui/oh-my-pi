import { sanitizeText as sanitizeErrorLine } from "@oh-my-pi/pi-utils";
import { editorKey } from "../chrome/keybinding-hints";
import { createDocument } from "../document/document";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { ScrollViewportState } from "../host/elements/scroll";
import type { HostKeyEvent } from "../host/input";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { matchesKey } from "../keys";
import {
	For,
	Show,
	createEffect,
	createSignal,
	useFocus,
	useTheme,
	type Accessor,
	type FocusHandle,
	type JSX,
} from "../reactive";
import type { ThemeColor } from "../theme/schema";
import type { SizeValue, TUI } from "../tui";
import { wrapTextWithAnsi } from "../utils";
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwTurns,
} from "./btw-history";
import { sanitizeDisplayLine, sanitizeDisplayText } from "./extensions/display-text";

export interface BtwHistoryPanelOptions {
	readonly records: readonly BtwHistoryRecord[];
	readonly onClose: () => void;
	readonly onCopy: (record: BtwHistoryRecord) => void;
	readonly onCancel: (record: BtwHistoryRecord) => void;
	readonly canFollowUp?: (record: BtwHistoryRecord) => boolean;
	readonly onFollowUp?: (record: BtwHistoryRecord, question: string, signal: AbortSignal) => Promise<boolean>;
	readonly getHeight?: () => number;
}

interface BtwHistoryComposer {
	readonly recordId: string;
	readonly abortController: AbortController;
	readonly draft: Accessor<string>;
	readonly setDraft: (value: string) => void;
	readonly notice: Accessor<string | undefined>;
	readonly setNotice: (value: string | undefined) => void;
}

interface BtwStatus {
	readonly label: string;
	readonly color: ThemeColor;
}

const STATUS: Readonly<Record<BtwHistoryRecord["status"], BtwStatus>> = {
	running: { label: "Running", color: "accent" },
	complete: { label: "Complete", color: "success" },
	cancelled: { label: "Cancelled", color: "warning" },
	error: { label: "Error", color: "error" },
	interrupted: { label: "Interrupted", color: "warning" },
};

const timeFormat = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dateFormat = new Intl.DateTimeFormat("en", {
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

export interface BtwHistoryPanelController {
	readonly records: Accessor<readonly BtwHistoryRecord[]>;
	readonly selectedIndex: Accessor<number>;
	readonly focus: Accessor<"list" | "answer">;
	readonly composer: Accessor<BtwHistoryComposer | undefined>;
	readonly followUpPending: Accessor<boolean>;
	readonly listOffset: Accessor<number>;
	readonly detailOffset: Accessor<number>;
	readonly detailViewport: Accessor<ScrollViewportState>;
	readonly getHeight: () => number;
	selected(): BtwHistoryRecord | undefined;
	canFollowUp(record: BtwHistoryRecord): boolean;
	isCopied(record: BtwHistoryRecord): boolean;
	update(records: readonly BtwHistoryRecord[]): void;
	markCopied(recordId: string, text: string): void;
	openFollowUp(recordId: string): boolean;
	handleInput(data: string): boolean;
	setListGeometry(rows: number): void;
	setDetailViewport(viewport: ScrollViewportState): void;
	cancelComposer(): void;
	submitFollowUp(composer: BtwHistoryComposer, value: string): void;
}

export interface BtwHistoryPanelHandle extends OverlayDisposer {
	update(records: readonly BtwHistoryRecord[]): void;
	markCopied(recordId: string, text: string): void;
	openFollowUp(recordId: string): boolean;
}

function createBtwHistoryPanelController(
	options: BtwHistoryPanelOptions,
	getHeight: () => number,
): BtwHistoryPanelController {
	const [records, setRecords] = createSignal<readonly BtwHistoryRecord[]>(options.records);
	const [selectedId, setSelectedId] = createSignal<string | undefined>(options.records[0]?.id);
	const [focus, setFocus] = createSignal<"list" | "answer">("list");
	const [composer, setComposer] = createSignal<BtwHistoryComposer>();
	const [followUpPending, setFollowUpPending] = createSignal(false);
	const [listOffset, setListOffset] = createSignal(0);
	const [listRows, setListRows] = createSignal(1);
	const [detailOffset, setDetailOffset] = createSignal(0);
	const [detailViewport, setDetailViewportState] = createSignal<ScrollViewportState>({
		offset: 0,
		totalRows: 0,
		height: 0,
		width: 0,
	});
	const [copied, setCopied] = createSignal<{ readonly id: string; readonly text: string }>();

	const selectedIndex = (): number =>
		Math.max(
			0,
			records().findIndex(record => record.id === selectedId()),
		);
	const selected = (): BtwHistoryRecord | undefined => records()[selectedIndex()];

	const select = (index: number): void => {
		const list = records();
		const record = list[Math.max(0, Math.min(index, list.length - 1))];
		if (!record || record.id === selectedId()) return;
		setSelectedId(record.id);
		setDetailOffset(0);
		const rows = Math.max(1, listRows());
		setListOffset(previous => {
			if (index < previous) return index;
			if (index >= previous + rows) return index - rows + 1;
			return previous;
		});
	};

	const canFollowUp = (record: BtwHistoryRecord): boolean =>
		!followUpPending() && options.onFollowUp !== undefined && options.canFollowUp?.(record) === true;

	const isCopied = (record: BtwHistoryRecord): boolean => {
		const marked = copied();
		return marked?.id === record.id && getBtwCopyText(record) === marked.text;
	};

	const cancelComposer = (): void => {
		const active = composer();
		if (!active) return;
		active.abortController.abort();
		setComposer(undefined);
	};

	const submitFollowUp = (active: BtwHistoryComposer, value: string): void => {
		void (async () => {
			if (followUpPending() || composer() !== active) return;
			const question = value.trim();
			if (!question) {
				active.setNotice("Enter a follow-up question.");
				return;
			}
			const record = records().find(item => item.id === active.recordId);
			if (!record || !canFollowUp(record)) {
				active.setNotice("A BTW request is busy. Try again when it finishes.");
				return;
			}
			setFollowUpPending(true);
			active.setNotice("Starting follow-up…");
			try {
				const accepted = await options.onFollowUp!(record, question, active.abortController.signal);
				if (composer() !== active) return;
				if (accepted) {
					setComposer(undefined);
					setSelectedId(active.recordId);
					setFocus("answer");
					setDetailOffset(Number.MAX_SAFE_INTEGER);
				} else {
					active.setNotice("Follow-up was not started. Your draft is kept; Enter to retry.");
				}
			} catch {
				if (composer() === active) {
					active.setNotice("Could not start the follow-up. Your draft is kept; Enter to retry.");
				}
			} finally {
				setFollowUpPending(false);
			}
		})();
	};

	const openFollowUp = (recordId: string): boolean => {
		if (composer()) return false;
		const index = records().findIndex(record => record.id === recordId);
		const record = records()[index];
		if (!record || !canFollowUp(record)) return false;
		select(index);
		const [draft, setDraft] = createSignal("");
		const [notice, setNotice] = createSignal<string>();
		setComposer({ recordId, abortController: new AbortController(), draft, setDraft, notice, setNotice });
		setFocus("answer");
		return true;
	};

	const scrollDetail = (delta: number): void => {
		setDetailOffset(() =>
			Math.max(
				0,
				Math.min(
					Math.max(0, detailViewport().totalRows - detailViewport().height),
					detailViewport().offset + delta,
				),
			),
		);
	};

	return {
		records,
		selectedIndex,
		focus,
		composer,
		followUpPending,
		listOffset,
		detailOffset,
		detailViewport,
		getHeight,
		selected,
		canFollowUp,
		isCopied,
		update(next): void {
			setRecords(next);
			const marked = copied();
			const copiedRecord = marked ? next.find(record => record.id === marked.id) : undefined;
			if (!copiedRecord || getBtwCopyText(copiedRecord) !== marked?.text) setCopied(undefined);
			if (composer() && !next.some(record => record.id === composer()!.recordId)) setComposer(undefined);
			if (!next.some(record => record.id === selectedId())) {
				setSelectedId(next[0]?.id);
				setListOffset(0);
				setDetailOffset(0);
			}
		},
		markCopied(recordId, text): void {
			setCopied({ id: recordId, text });
		},
		openFollowUp,
		handleInput(data): boolean {
			if (composer()) return false;
			const record = selected();
			if (matchesSelectCancel(data) || matchesKey(data, "escape") || matchesKey(data, "esc")) {
				if (record && getBtwLatestTurn(record).status === "running") options.onCancel(record);
				else options.onClose();
				return true;
			}
			if (matchesKey(data, "f") || matchesKey(data, "enter") || matchesKey(data, "return")) {
				if (record) openFollowUp(record.id);
				return true;
			}
			if (matchesKey(data, "c")) {
				if (record && getBtwCopyText(record) !== undefined) options.onCopy(record);
				return true;
			}
			if (
				matchesKey(data, "tab") ||
				matchesKey(data, "shift+tab") ||
				matchesKey(data, "ctrl+/") ||
				matchesKey(data, "ctrl+_") ||
				data === String.fromCharCode(31)
			) {
				setFocus(previous => (previous === "list" ? "answer" : "list"));
			} else if (matchesKey(data, "right")) {
				setFocus("answer");
			} else if (matchesKey(data, "left")) {
				setFocus("list");
			} else if (focus() === "list") {
				const index = selectedIndex();
				if (matchesSelectUp(data)) select(index - 1);
				else if (matchesSelectDown(data)) select(index + 1);
				else if (matchesSelectPageUp(data)) select(index - listRows());
				else if (matchesSelectPageDown(data)) select(index + listRows());
				else if (matchesKey(data, "home")) select(0);
				else if (matchesKey(data, "end")) select(records().length - 1);
				else return false;
			} else {
				if (matchesSelectUp(data)) scrollDetail(-1);
				else if (matchesSelectDown(data)) scrollDetail(1);
				else if (matchesSelectPageUp(data)) scrollDetail(-Math.max(1, detailViewport().height - 1));
				else if (matchesSelectPageDown(data)) scrollDetail(Math.max(1, detailViewport().height - 1));
				else if (matchesKey(data, "shift+up")) scrollDetail(-5);
				else if (matchesKey(data, "shift+down")) scrollDetail(5);
				else if (matchesKey(data, "home")) {
					setDetailOffset(0);
				} else if (matchesKey(data, "end")) {
					setDetailOffset(Number.MAX_SAFE_INTEGER);
				} else return false;
			}
			return true;
		},
		setListGeometry(rows): void {
			const nextRows = Math.max(1, Math.floor(rows));
			if (listRows() !== nextRows) setListRows(nextRows);
			setListOffset(previous => Math.min(previous, Math.max(0, records().length - nextRows)));
		},
		setDetailViewport(next): void {
			const previous = detailViewport();
			if (
				previous.offset !== next.offset ||
				previous.totalRows !== next.totalRows ||
				previous.height !== next.height ||
				previous.width !== next.width
			) {
				setDetailViewportState(next);
			}
		},
		cancelComposer,
		submitFollowUp,
	};
}

function BtwListRow(props: {
	readonly record: BtwHistoryRecord;
	readonly selected: boolean;
	readonly focused: boolean;
	readonly span: number;
	readonly cursor: string;
}): JSX.Element {
	const status = STATUS[getBtwLatestTurn(props.record).status];
	const cursorText = props.selected ? props.cursor : " ";
	const question = sanitizeDisplayLine(props.record.question);
	const selectedColor: ThemeColor | undefined = props.selected ? (props.focused ? "accent" : "muted") : undefined;

	if (props.span === 2) {
		return (
			<>
				<row background={props.selected ? "selectedBg" : undefined}>
					<text color={selectedColor} width={2} shrink={0} wrap="clip">{`${cursorText} `}</text>
					<text
						color="dim"
						width={6}
						shrink={0}
						wrap="clip"
					>{`${timeFormat.format(props.record.createdAt)} `}</text>
					<text color={status.color} shrink={0} wrap="clip">
						{status.label}
					</text>
				</row>
				<row background={props.selected ? "selectedBg" : undefined}>
					<text width={2} shrink={0}>
						{" "}
					</text>
					<text bold={props.selected} grow={1} minWidth={0} wrap="clip">
						{question}
					</text>
				</row>
			</>
		);
	}
	return (
		<row background={props.selected ? "selectedBg" : undefined}>
			<text color={selectedColor} width={2} shrink={0} wrap="clip">{`${cursorText} `}</text>
			<text color="dim" width={6} shrink={0} wrap="clip">{`${timeFormat.format(props.record.createdAt)} `}</text>
			<text color={status.color} shrink={0} wrap="clip">{`${status.label} `}</text>
			<text bold={props.selected} grow={1} minWidth={0} wrap="clip">
				{question}
			</text>
		</row>
	);
}

function BtwHistoryList(props: {
	readonly controller: BtwHistoryPanelController;
	readonly width: number;
	readonly height: number;
	readonly cursor: string;
}): JSX.Element {
	const span = props.width < 36 && props.height >= 2 ? 2 : 1;
	const rows = Math.max(1, Math.floor(props.height / span));
	props.controller.setListGeometry(rows);
	return (
		<scroll
			height={Math.max(0, props.height)}
			offset={props.controller.listOffset() * span}
			followTail={false}
			shrinkToFit={false}
			scrollbar="auto"
		>
			{props.controller.records().length === 0 ? (
				<stack>
					<text color="muted" wrap="word">
						No side questions yet.
					</text>
					<br />
					<text color="muted" wrap="word">
						Use /btw QUESTION to start one.
					</text>
				</stack>
			) : (
				props.controller
					.records()
					.map((record, index) => (
						<BtwListRow
							record={record}
							selected={index === props.controller.selectedIndex()}
							focused={props.controller.focus() === "list"}
							span={span}
							cursor={props.cursor}
						/>
					))
			)}
		</scroll>
	);
}

function BtwTurnView(props: { readonly turn: BtwHistoryTurn }): JSX.Element {
	const status = STATUS[props.turn.status];
	const question = createDocument(sanitizeDisplayText(props.turn.question));
	const answer = createDocument(sanitizeDisplayText(props.turn.answer));
	return (
		<stack>
			<text color={status.color} wrap="word">{`${status.label} · ${dateFormat.format(props.turn.createdAt)}`}</text>
			<br />
			<text color="accent" bold>
				Question
			</text>
			<markdown document={question} />
			<br />
			<text color="accent" bold>
				Answer
			</text>
			{props.turn.answer.trim() ? (
				<markdown document={answer} />
			) : (
				<text color="dim" wrap="word">
					{props.turn.status === "running" ? "Waiting for response…" : "No answer text."}
				</text>
			)}
			{props.turn.error ? (
				<>
					<br />
					<text color="error" wrap="word">
						{sanitizeErrorLine(props.turn.error)}
					</text>
				</>
			) : null}
			{props.turn.status === "interrupted" ? (
				<>
					<br />
					<text color="muted" wrap="word">
						Not resumed in this view.
					</text>
				</>
			) : null}
		</stack>
	);
}

function BtwHistoryDetail(props: {
	readonly controller: BtwHistoryPanelController;
	readonly height: number;
}): JSX.Element {
	const record = props.controller.selected();
	const turns = record ? getBtwTurns(record) : [];
	return (
		<scroll
			height={Math.max(0, props.height)}
			offset={props.controller.detailOffset()}
			followTail={false}
			shrinkToFit={false}
			scrollbar="auto"
			trackColor="muted"
			thumbColor="accent"
			onViewport={props.controller.setDetailViewport}
		>
			{record ? (
				<stack>
					{props.controller.isCopied(record) ? (
						<>
							<text color="success" wrap="word">
								✓ Copied to clipboard
							</text>
							<br />
						</>
					) : null}
					{turns.map((turn, index) => (
						<>
							{index > 0 ? (
								<>
									<br />
									<hr char="─" ruleColor="dim" />
									<br />
								</>
							) : null}
							<BtwTurnView turn={turn} />
						</>
					))}
				</stack>
			) : (
				<text color="muted" wrap="word">
					No side questions yet. Use /btw QUESTION to start one.
				</text>
			)}
		</scroll>
	);
}

interface BtwFooterAction {
	readonly key: string;
	readonly description: string;
}

function footerActions(controller: BtwHistoryPanelController, width: number): readonly string[] {
	const record = controller.selected();
	const latest = record ? getBtwLatestTurn(record) : undefined;
	const composer = controller.composer();
	const actions: BtwFooterAction[] = composer
		? [
				{ key: "Enter", description: controller.followUpPending() ? "starting…" : "send" },
				{ key: "Esc", description: "cancel" },
			]
		: [
				{ key: "Esc", description: latest?.status === "running" ? "cancel" : "close" },
				{ key: "Tab/Ctrl+/", description: "switch pane" },
			];
	if (!composer && record && controller.canFollowUp(record))
		actions.push({ key: "f/Enter", description: "follow up" });
	if (!composer && record && getBtwCopyText(record) !== undefined) {
		if (controller.isCopied(record)) actions.push({ key: "✓ copied", description: "c to copy again" });
		else actions.push({ key: "c", description: width < 40 ? "copy" : "copy answer" });
	}
	const text = actions.map(action => `${action.key} ${action.description}`).join(" · ");
	return wrapTextWithAnsi(text, Math.max(1, width));
}

interface BtwHistoryPanelLayout {
	readonly framed: boolean;
	readonly width: number;
	readonly height: number;
	readonly bodyHeight: number;
	readonly availableRows: number;
	readonly composer: BtwHistoryComposer | undefined;
	readonly actions: readonly string[];
	readonly showNavigation: boolean;
	readonly copied: boolean;
	readonly wide: boolean;
	readonly leftWidth: number;
}

function sameLayout(left: BtwHistoryPanelLayout, right: BtwHistoryPanelLayout): boolean {
	return (
		left.framed === right.framed &&
		left.width === right.width &&
		left.height === right.height &&
		left.bodyHeight === right.bodyHeight &&
		left.availableRows === right.availableRows &&
		left.composer === right.composer &&
		left.showNavigation === right.showNavigation &&
		left.copied === right.copied &&
		left.wide === right.wide &&
		left.leftWidth === right.leftWidth &&
		left.actions.length === right.actions.length &&
		left.actions.every((action, index) => action === right.actions[index])
	);
}

function BtwHistoryRows(props: {
	readonly controller: BtwHistoryPanelController;
	readonly layout: BtwHistoryPanelLayout;
	readonly cursor: string;
}): JSX.Element {
	const list = (
		<BtwHistoryList
			controller={props.controller}
			width={props.layout.wide ? props.layout.leftWidth : props.layout.width}
			height={props.layout.bodyHeight}
			cursor={props.cursor}
		/>
	);
	const detail = <BtwHistoryDetail controller={props.controller} height={props.layout.bodyHeight} />;
	const body = props.layout.wide ? (
		<split
			leftSize={{ fixed: props.layout.leftWidth, max: 46 }}
			splitAt={92}
			narrowPane={props.controller.focus() === "answer" ? "right" : "left"}
			height={props.layout.bodyHeight}
			divider=" │ "
		>
			{list}
			{detail}
		</split>
	) : props.controller.focus() === "list" ? (
		list
	) : (
		detail
	);
	return (
		<stack>
			{props.layout.framed ? (
				<split
					leftSize={{ fixed: props.layout.leftWidth, max: 46 }}
					splitAt={92}
					narrowPane={props.controller.focus() === "answer" ? "right" : "left"}
					height={1}
					divider=" │ "
				>
					<text
						color={props.controller.focus() === "list" ? "accent" : "muted"}
						bold={props.controller.focus() === "list"}
						wrap="clip"
					>
						{`${props.controller.focus() === "list" ? props.cursor : " "} History (${props.controller.records().length})`}
					</text>
					<text
						color={props.controller.focus() === "answer" ? "accent" : "muted"}
						bold={props.controller.focus() === "answer"}
						wrap="clip"
					>
						{`${props.controller.focus() === "answer" ? props.cursor : " "} Details`}
					</text>
				</split>
			) : props.layout.height >= 3 ? (
				<text color="accent" bold wrap="clip">
					{props.controller.focus() === "list"
						? `${props.cursor} History (${props.controller.records().length})`
						: `${props.cursor} Details`}
				</text>
			) : null}
			{body}
			{props.layout.composer ? (
				<>
					{props.layout.availableRows >= 2 ? (
						<text
							color="dim"
							wrap="clip"
						>{`Topic: ${sanitizeDisplayLine(props.controller.selected()?.question ?? "")}`}</text>
					) : null}
					{props.layout.composer.notice() && props.layout.availableRows >= 3 ? (
						<text color={props.controller.followUpPending() ? "dim" : "warning"} wrap="clip">
							{props.layout.composer.notice()}
						</text>
					) : null}
				</>
			) : (
				<>
					{props.layout.showNavigation ? (
						<text color="dim" wrap="clip">
							{`${editorKey("tui.select.up")}/${editorKey("tui.select.down")} ${props.controller.focus() === "list" ? "select" : "scroll"}`}
						</text>
					) : null}
					{props.layout.height >= 3
						? props.layout.actions.map(line => (
								<text color={props.layout.copied ? "success" : "dim"} wrap="clip">
									{line}
								</text>
							))
						: null}
				</>
			)}
		</stack>
	);
}

export interface BtwHistoryPanelViewProps {
	readonly controller: BtwHistoryPanelController;
	readonly inputFocus: FocusHandle;
}

/** Reactive, full-screen history for completed and streaming /btw conversations. */
export function BtwHistoryPanelView(props: BtwHistoryPanelViewProps): JSX.Element {
	const theme = useTheme();
	const [framed, setFramed] = createSignal(true);
	const [layout, setLayout] = createSignal<BtwHistoryPanelLayout>({
		framed: true,
		width: 0,
		height: 0,
		bodyHeight: 0,
		availableRows: 1,
		composer: undefined,
		actions: [],
		showNavigation: false,
		copied: false,
		wide: false,
		leftWidth: 0,
	});

	const updateLayout = (next: BtwHistoryPanelLayout): void => {
		setLayout(previous => (sameLayout(previous, next) ? previous : next));
	};

	return (
		<frame
			title="BTW history"
			paddingX={framed() ? 1 : 0}
			paddingY={0}
			border={framed()}
			borderPolicy="always"
			fitContent
			renderEmpty
		>
			<sized
				paint={contentWidth => {
					const width = Math.max(0, Math.floor(contentWidth));
					const requestedHeight = props.controller.getHeight();
					const height = Number.isFinite(requestedHeight) ? Math.max(0, Math.floor(requestedHeight)) : 0;
					if (width === 0 || height === 0) return null;
					const nextFramed = width + (framed() ? 4 : 0) >= 12 && height >= 8;
					if (nextFramed !== framed()) {
						setFramed(nextFramed);
						return null;
					}
					const composer = props.controller.composer();
					const actions = footerActions(props.controller, width).slice(0, nextFramed ? 2 : 1);
					const chrome = nextFramed ? 3 + actions.length : height >= 3 ? 2 : 0;
					const availableRows = Math.max(1, height - chrome - 1);
					const composerRows =
						composer === undefined
							? 0
							: 1 + (availableRows >= 2 ? 1 : 0) + (composer.notice() && availableRows >= 3 ? 1 : 0);
					let bodyHeight = Math.max(composer ? 0 : 1, height - chrome - composerRows);
					const showNavigation =
						nextFramed &&
						composer === undefined &&
						(props.controller.focus() === "list" || props.controller.detailViewport().totalRows > bodyHeight);
					if (showNavigation) bodyHeight = Math.max(1, bodyHeight - 1);
					const selected = props.controller.selected();
					const next: BtwHistoryPanelLayout = {
						framed: nextFramed,
						width,
						height,
						bodyHeight,
						availableRows,
						composer,
						actions,
						showNavigation,
						copied: selected !== undefined && props.controller.isCopied(selected),
						wide: nextFramed && width + 4 >= 96,
						leftWidth: Math.min(46, Math.floor((width + 4) * 0.42)),
					};
					updateLayout(next);
					return <BtwHistoryRows controller={props.controller} layout={next} cursor={theme.theme().nav.cursor} />;
				}}
			/>
			<Show when={layout().composer}>
				<input
					tabIndex={props.inputFocus.tabIndex}
					value={layout().composer!.draft()}
					prompt="Follow up: "
					promptStyle={theme.theme().style("accent")}
					onChange={layout().composer!.setDraft}
					onEscape={props.controller.cancelComposer}
					onSubmit={value => props.controller.submitFollowUp(layout().composer!, value)}
					onKey={event => event.stopPropagation()}
				/>
				<For each={layout().actions}>
					{line => (
						<text color={layout().copied ? "success" : "dim"} wrap="clip">
							{line}
						</text>
					)}
				</For>
			</Show>
		</frame>
	);
}

export interface BtwHistoryPanelProps {
	readonly controller: BtwHistoryPanelController;
	readonly width?: SizeValue;
}

/** Full-screen reactive overlay component for session-local side-question history. */
export function BtwHistoryPanel(props: BtwHistoryPanelProps): JSX.Element {
	const inputFocus = useFocus();
	createEffect(() => {
		if (props.controller.composer()) inputFocus.focus();
	});
	const handleKey = (event: HostKeyEvent): void => {
		if (!props.controller.handleInput(event.data)) return;
		event.preventDefault();
		event.stopPropagation();
	};
	return (
		<Portal to="overlay" fullscreen anchor="bottom-center" width={props.width ?? "100%"} maxHeight="100%" margin={0}>
			<box onKey={handleKey} tabIndex={0}>
				<BtwHistoryPanelView controller={props.controller} inputFocus={inputFocus} />
			</box>
		</Portal>
	);
}

/** Open /btw history and return its reactive controller plus overlay disposer. */
export function openBtwHistoryPanel(
	tui: TUI,
	options: BtwHistoryPanelOptions,
	opts?: { readonly width?: SizeValue },
): BtwHistoryPanelHandle {
	const controller = createBtwHistoryPanelController(options, options.getHeight ?? (() => tui.terminal.rows));
	const disposer = mountOverlay(tui, () => <BtwHistoryPanel controller={controller} width={opts?.width} />);
	return Object.assign(disposer, {
		update: controller.update,
		markCopied: controller.markCopied,
		openFollowUp: controller.openFollowUp,
	});
}

export const showBtwHistoryPanel = openBtwHistoryPanel;
