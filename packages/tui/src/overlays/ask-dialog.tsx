import { createEffect, createMemo, createSignal, For, Show, useFocus, type Accessor, type JSX } from "../reactive";
import type { Editor } from "../components/editor";
import { matchesKey } from "../keys";
import {
	matchesAppToolsExpand,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import type { ScrollViewportState } from "../host/elements/scroll";
import { createDocument } from "../document/document";
import { CountdownTimer } from "../chrome/countdown-timer";
import { editorKey } from "../chrome/keybinding-hints";
import { disambiguateDisplayLabels, expandKeyHint, replaceTabs, sanitizeCarriageReturns } from "../render/render-utils";
import type { TUI } from "../tui";

const OTHER_OPTION = "Other (type your own)";
const SUBMIT_OPTION = "Submit";
const GUEST_ACTION_LABELS = ["Chat about this", "Next →"];
const MAX_PROMPT_TITLE_ROWS = 3;
const MAX_DESCRIPTION_ROWS = 2;

/** One selectable answer in an ask dialog. */
export interface ExtensionAskDialogOption {
	label: string;
	/** Stable answer value when a display label must be sanitized or disambiguated. */
	value?: string;
	description?: string;
	preview?: string;
}

/** Question and answer choices displayed by the ask dialog. */
export interface ExtensionAskDialogQuestion {
	id: string;
	question: string;
	header?: string;
	options: ExtensionAskDialogOption[];
	multi?: boolean;
	recommended?: number;
}

export interface ExtensionAskDialogResultItem {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
}

export interface ExtensionAskDialogSubmitResult {
	kind: "submit";
	results: ExtensionAskDialogResultItem[];
}

export interface ExtensionAskDialogChatResult {
	kind: "chat";
}

export type ExtensionAskDialogResult = ExtensionAskDialogSubmitResult | ExtensionAskDialogChatResult;

function stringOr(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function optionValue(option: ExtensionAskDialogOption): string {
	return option.value ?? option.label;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function displayText(value: string): string {
	return replaceTabs(sanitizeCarriageReturns(value));
}

function normalizedInlineInput(value: string): string {
	return displayText(value).replace(/\s+/g, " ").trim();
}

function questionTabLabel(question: ExtensionAskDialogQuestion, index: number): string {
	return displayText(question.header ?? "").trim() || displayText(question.id) || `Q${index + 1}`;
}

function displayOptionLabels(question: ExtensionAskDialogQuestion): string[] {
	const suffix = " (Recommended)";
	const badged = question.options.map((option, index) => {
		const label = sanitizeCarriageReturns(option.label);
		return question.recommended === index && !label.endsWith(suffix) ? `${label}${suffix}` : label;
	});
	return disambiguateDisplayLabels(badged, [OTHER_OPTION, ...GUEST_ACTION_LABELS]).map(replaceTabs);
}

/** Prepares complete, render-safe prompt context for the native editor view. */
export function boundPromptTitle(prefix: string, question: string): string {
	const heading = normalizedInlineInput(prefix);
	const detail = normalizedInlineInput(question);
	return heading ? `${heading}\n${detail}` : detail;
}

/**
 * Coerce public extension data to a render-safe shape while retaining every
 * original correlation value. Display copies are sanitized at render time;
 * submit results retain raw ids, questions, labels, and explicit values.
 */
export function normalizeDialogQuestions(questions: ExtensionAskDialogQuestion[]): ExtensionAskDialogQuestion[] {
	if (!Array.isArray(questions)) return [];
	const normalized: ExtensionAskDialogQuestion[] = [];
	for (const entry of questions) {
		if (entry === null || typeof entry !== "object") continue;
		const options: ExtensionAskDialogOption[] = [];
		if (Array.isArray(entry.options)) {
			for (const candidate of entry.options) {
				if (candidate === null || typeof candidate !== "object") continue;
				const label = stringOr(candidate.label, "");
				options.push({
					label,
					value: stringOr(candidate.value, label),
					...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
					...(typeof candidate.preview === "string" ? { preview: candidate.preview } : {}),
				});
			}
		}
		normalized.push({
			id: stringOr(entry.id, "?"),
			question: stringOr(entry.question, ""),
			...(typeof entry.header === "string" ? { header: entry.header } : {}),
			options,
			...(typeof entry.multi === "boolean" ? { multi: entry.multi } : {}),
			...(typeof entry.recommended === "number" && Number.isInteger(entry.recommended)
				? { recommended: entry.recommended }
				: {}),
		});
	}
	return normalized;
}

export interface AskDialogCallbacks {
	onSubmit(result: ExtensionAskDialogSubmitResult): void;
	onCancel(): void;
	onPrompt(title: string, prefill?: string): Promise<string | undefined>;
}

/** Preserve an in-progress composer draft before accepting answers. */
export interface AskDialogInputGuard {
	readonly editor?: Editor;
	isBlocked(): boolean;
	handleInput(data: string): void;
	readonly hint: string;
}

export interface AskDialogOptions {
	timeout?: number;
	onTimeout?: () => void;
	tui?: TUI;
	inputGuard?: AskDialogInputGuard;
}

interface AnswerState {
	selected: Set<string>;
	customInput: string | undefined;
	note: string | undefined;
	noteRowKey: string | undefined;
	cursor: number;
	scrollOffset: number;
	timedOut: boolean;
}

export interface AskDialogAnswer {
	readonly selected: ReadonlySet<string>;
	readonly customInput: string | undefined;
	readonly note: string | undefined;
	readonly noteRowKey: string | undefined;
	readonly cursor: number;
	readonly scrollOffset: number;
	readonly timedOut: boolean;
}

export interface AskDialogController {
	readonly activeQuestion: Accessor<number>;
	readonly cursor: Accessor<number>;
	readonly isReview: Accessor<boolean>;
	readonly expanded: Accessor<boolean>;
	readonly remainingSeconds: Accessor<number | undefined>;
	readonly reviewScrollOffset: Accessor<number>;
	readonly hasReview: boolean;
	answer(): AskDialogAnswer | undefined;
	answerAt(index: number): AskDialogAnswer | undefined;
	activateRow(index: number): void;
	setViewport(viewport: ScrollViewportState): void;
	handleInput(data: string): void;
	submit(): void;
	cancel(): void;
	dispose(): void;
}

function noteForSubmittedAnswer(question: ExtensionAskDialogQuestion, state: AskDialogAnswer): string | undefined {
	if (state.note === undefined || state.noteRowKey === undefined) return undefined;
	if (state.noteRowKey === "other") return state.customInput === undefined ? undefined : state.note;
	const match = /^option:(\d+)$/.exec(state.noteRowKey);
	const optionIndex = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
	const option = Number.isInteger(optionIndex) ? question.options[optionIndex] : undefined;
	return option !== undefined && state.selected.has(optionValue(option)) ? state.note : undefined;
}

/** Stateful domain controller shared by the retained view and overlay lifecycle. */
export function createAskDialogController(
	questions: ExtensionAskDialogQuestion[],
	callbacks: AskDialogCallbacks,
	options: AskDialogOptions = {},
): AskDialogController {
	const normalized = normalizeDialogQuestions(questions);
	const states: AnswerState[] = normalized.map(question => ({
		selected: new Set<string>(),
		customInput: undefined,
		note: undefined,
		noteRowKey: undefined,
		cursor: clamp(question.recommended ?? 0, 0, Math.max(0, question.options.length - 1)),
		scrollOffset: 0,
		timedOut: false,
	}));
	const hasReview = normalized.length > 1 || normalized.some(question => question.multi === true);
	const reviewIndex = normalized.length;
	const [activeQuestion, setActiveQuestion] = createSignal(0);
	const [cursor, setCursor] = createSignal(states[0]?.cursor ?? 0);
	const [version, setVersion] = createSignal(0);
	const [expanded, setExpanded] = createSignal(false);
	const [remainingSeconds, setRemainingSeconds] = createSignal<number>();
	const [reviewScrollOffset, setReviewScrollOffset] = createSignal(0);
	let promptActive = false;
	let timeoutDeferred = false;
	let disposed = false;
	let countdown: CountdownTimer | undefined;
	let viewportHeight = 1;

	const touch = (): void => {
		setVersion(current => current + 1);
	};
	const answerAt = (index: number): AskDialogAnswer | undefined => {
		version();
		return states[index];
	};
	const isReview = (): boolean => hasReview && activeQuestion() === reviewIndex;
	const active = (): { question: ExtensionAskDialogQuestion; state: AnswerState } | undefined => {
		const index = activeQuestion();
		const question = normalized[index];
		const state = states[index];
		return question === undefined || state === undefined ? undefined : { question, state };
	};
	const setActive = (index: number): void => {
		setActiveQuestion(index);
		setCursor(states[index]?.cursor ?? 0);
		setReviewScrollOffset(0);
	};
	const clearNote = (state: AnswerState): void => {
		state.note = undefined;
		state.noteRowKey = undefined;
	};
	const clearNoteIfRow = (state: AnswerState, rowKey: string): void => {
		if (state.noteRowKey === rowKey) clearNote(state);
	};
	const clearNoteUnlessRow = (state: AnswerState, rowKey: string): void => {
		if (state.noteRowKey !== undefined && state.noteRowKey !== rowKey) clearNote(state);
	};
	const finishSubmit = (): void => {
		if (disposed) return;
		disposed = true;
		countdown?.dispose();
		callbacks.onSubmit({
			kind: "submit",
			results: normalized.map((question, index) => {
				const state = states[index]!;
				return {
					id: question.id,
					question: question.question,
					options: question.options.map(optionValue),
					multi: question.multi === true,
					selectedOptions: question.options.map(optionValue).filter(value => state.selected.has(value)),
					customInput: state.customInput,
					note: noteForSubmittedAnswer(question, state),
					timedOut: state.timedOut || undefined,
				};
			}),
		});
	};
	const finishCancel = (): void => {
		if (disposed) return;
		disposed = true;
		countdown?.dispose();
		callbacks.onCancel();
	};
	const advance = (): void => {
		const index = activeQuestion();
		if (normalized.length === 1) {
			finishSubmit();
			return;
		}
		setActive(index + 1 < normalized.length ? index + 1 : reviewIndex);
	};
	const chooseOther = async (question: ExtensionAskDialogQuestion, state: AnswerState): Promise<void> => {
		promptActive = true;
		try {
			const input = await callbacks.onPrompt(
				boundPromptTitle("Custom answer: ", question.question),
				state.customInput,
			);
			if (input === undefined || disposed) return;
			if (input.trim().length === 0) {
				state.customInput = undefined;
				clearNoteIfRow(state, "other");
				return;
			}
			state.customInput = input;
			if (!question.multi) {
				state.selected.clear();
				clearNoteUnlessRow(state, "other");
			}
			if (question.multi && normalized.length === 1) setActive(reviewIndex);
			else advance();
		} finally {
			promptActive = false;
			touch();
			if (timeoutDeferred) {
				timeoutDeferred = false;
				handleTimeout();
			}
		}
	};
	const chooseNote = async (
		question: ExtensionAskDialogQuestion,
		state: AnswerState,
		rowKey: string,
		label: string,
	): Promise<void> => {
		promptActive = true;
		try {
			const input = await callbacks.onPrompt(
				boundPromptTitle(`Note for ${label}: `, question.question),
				state.noteRowKey === rowKey ? state.note : undefined,
			);
			if (input === undefined || disposed) return;
			state.note = input;
			state.noteRowKey = rowKey;
		} finally {
			promptActive = false;
			touch();
			if (timeoutDeferred) {
				timeoutDeferred = false;
				handleTimeout();
			}
		}
	};
	const choose = (): void => {
		const current = active();
		if (current === undefined) return;
		const { question, state } = current;
		const option = question.options[cursor()];
		if (option === undefined) {
			void chooseOther(question, state);
			return;
		}
		const rowKey = `option:${cursor()}`;
		if (question.multi) {
			advance();
			return;
		}
		state.selected.clear();
		state.selected.add(optionValue(option));
		state.customInput = undefined;
		clearNoteUnlessRow(state, rowKey);
		touch();
		advance();
	};
	const toggle = (): void => {
		const current = active();
		if (current === undefined) return;
		const { question, state } = current;
		if (!question.multi) return;
		const option = question.options[cursor()];
		if (option === undefined) return;
		const value = optionValue(option);
		if (state.selected.has(value)) {
			state.selected.delete(value);
			clearNoteIfRow(state, `option:${cursor()}`);
		} else state.selected.add(value);
		touch();
	};
	const handleTimeout = (): void => {
		if (disposed) return;
		if (promptActive) {
			timeoutDeferred = true;
			return;
		}
		options.onTimeout?.();
		for (let index = 0; index < normalized.length; index++) {
			const question = normalized[index]!;
			const state = states[index]!;
			if (state.selected.size > 0 || state.customInput !== undefined) continue;
			const noted = /^option:(\d+)$/.exec(state.noteRowKey ?? "");
			const notedIndex = noted?.[1] === undefined ? Number.NaN : Number.parseInt(noted[1], 10);
			const fallbackIndex =
				Number.isInteger(notedIndex) && question.options[notedIndex] !== undefined
					? notedIndex
					: clamp(question.recommended ?? 0, 0, Math.max(0, question.options.length - 1));
			const fallback = question.options[fallbackIndex];
			if (fallback !== undefined) state.selected.add(optionValue(fallback));
			state.timedOut = true;
		}
		touch();
		finishSubmit();
	};

	if (options.timeout !== undefined && options.timeout > 0) {
		countdown = new CountdownTimer(options.timeout, options.tui, setRemainingSeconds, handleTimeout);
	}

	return {
		activeQuestion,
		cursor,
		isReview,
		expanded,
		remainingSeconds,
		reviewScrollOffset,
		hasReview,
		answer(): AskDialogAnswer | undefined {
			return answerAt(activeQuestion());
		},
		answerAt,
		setViewport(viewport): void {
			viewportHeight = Math.max(1, viewport.height);
		},
		activateRow(index): void {
			if (disposed || promptActive || isReview()) return;
			const current = active();
			if (current === undefined) return;
			countdown?.reset();
			const next = clamp(index, 0, current.question.options.length);
			current.state.cursor = next;
			setCursor(next);
			if (current.question.multi && next < current.question.options.length) {
				toggle();
				return;
			}
			touch();
			choose();
		},
		handleInput(data): void {
			if (disposed || promptActive) return;
			countdown?.reset();
			if (matchesSelectCancel(data)) {
				finishCancel();
				return;
			}
			if (matchesAppToolsExpand(data)) {
				const current = active();
				if (current?.question.options.some(option => option.description?.trim())) setExpanded(value => !value);
				return;
			}
			if (options.inputGuard?.isBlocked()) {
				options.inputGuard.handleInput(data);
				return;
			}
			if (hasReview && (matchesKey(data, "tab") || matchesKey(data, "right"))) {
				setActive((activeQuestion() + 1) % (normalized.length + 1));
				return;
			}
			if (hasReview && (matchesKey(data, "shift+tab") || matchesKey(data, "left"))) {
				setActive((activeQuestion() - 1 + normalized.length + 1) % (normalized.length + 1));
				return;
			}
			if (isReview()) {
				if (matchesSelectUp(data)) setReviewScrollOffset(offset => Math.max(0, offset - 1));
				else if (matchesSelectDown(data)) setReviewScrollOffset(offset => offset + 1);
				else if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") finishSubmit();
				return;
			}
			const current = active();
			if (current === undefined) return;
			const maxCursor = current.question.options.length;
			if (matchesSelectPageUp(data)) {
				current.state.scrollOffset = Math.max(0, current.state.scrollOffset - viewportHeight);
				touch();
				return;
			}
			if (matchesSelectPageDown(data)) {
				current.state.scrollOffset += viewportHeight;
				touch();
				return;
			}
			if (matchesSelectUp(data) || matchesSelectDown(data)) {
				const delta = matchesSelectUp(data) ? -1 : 1;
				const next = clamp(cursor() + delta, 0, maxCursor);
				current.state.cursor = next;
				setCursor(next);
				touch();
				return;
			}
			const option = current.question.options[cursor()];
			if (data === "n" || data === "N") {
				const label =
					option === undefined
						? OTHER_OPTION
						: (displayOptionLabels(current.question)[cursor()] ?? displayText(option.label));
				void chooseNote(
					current.question,
					current.state,
					option === undefined ? "other" : `option:${cursor()}`,
					label,
				);
				return;
			}
			if (matchesKey(data, "space") || data === " ") {
				toggle();
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") choose();
		},
		submit: finishSubmit,
		cancel: finishCancel,
		dispose(): void {
			disposed = true;
			countdown?.dispose();
		},
	};
}

export interface AskDialogViewProps {
	readonly questions: ExtensionAskDialogQuestion[];
	readonly controller: AskDialogController;
	readonly callbacks: AskDialogCallbacks;
	readonly options?: AskDialogOptions;
}

function cancelKeyLabel(): string {
	const [key = "Esc"] = editorKey("tui.select.cancel").split("/");
	return key === "escape" ? "Esc" : key;
}

function pageKeysLabel(): string {
	const pageUp = editorKey("tui.select.pageUp");
	const pageDown = editorKey("tui.select.pageDown");
	return `${pageUp === "pageup" ? "PgUp" : pageUp}/${pageDown === "pagedown" ? "PgDn" : pageDown}`;
}

function isSelected(question: ExtensionAskDialogQuestion, state: AskDialogAnswer | undefined, index: number): boolean {
	return state?.selected.has(optionValue(question.options[index]!)) === true;
}

function answerSummary(question: ExtensionAskDialogQuestion, state: AskDialogAnswer | undefined): string {
	if (state === undefined) return "unanswered";
	const labels = displayOptionLabels(question);
	const selected = question.options
		.map((option, index) => ({ label: labels[index] ?? displayText(option.label), value: optionValue(option) }))
		.filter(option => state.selected.has(option.value))
		.map(option => option.label);
	if (question.multi) {
		if (state.customInput !== undefined) selected.push(`Other: “${normalizedInlineInput(state.customInput)}”`);
		return selected.length > 0 ? selected.join(", ") : "unanswered";
	}
	if (state.customInput !== undefined) return `“${normalizedInlineInput(state.customInput)}”`;
	return selected[0] ?? "unanswered";
}

function OptionRow(props: {
	question: ExtensionAskDialogQuestion;
	index: number;
	label: string;
	controller: AskDialogController;
}): JSX.Element {
	const option = props.question.options[props.index]!;
	const labelDocument = createDocument(props.label);
	const descriptionDocument = createDocument(option.description === undefined ? "" : displayText(option.description));
	const previewDocument = createDocument(option.preview === undefined ? "" : displayText(option.preview));
	const selected = (): boolean => props.controller.cursor() === props.index && !props.controller.isReview();
	const answer = (): AskDialogAnswer | undefined => props.controller.answer();
	const selectWithMouse = (event: HostMouseEvent): void => {
		if (event.action !== "down" || event.button !== 0) return;
		props.controller.activateRow(props.index);
		event.preventDefault();
	};
	return (
		<box onMouse={selectWithMouse}>
			<row pad={false} wrap="continuation" continuationIndent={2}>
				<text width={2} shrink={0} color="accent">
					{selected() ? "❯ " : "  "}
				</text>
				<box grow={1}>
					<choice
						kind={props.question.multi ? "checkbox" : "radio"}
						checked={isSelected(props.question, answer(), props.index)}
					>
						<markdown
							document={labelDocument}
							color={
								selected()
									? "accent"
									: isSelected(props.question, answer(), props.index)
										? "toolOutput"
										: "text"
							}
						/>
					</choice>
				</box>
				{answer()?.noteRowKey === `option:${props.index}` ? (
					<text shrink={1} overflowPriority={0} color="success" wrap="clip">
						✎ note
					</text>
				) : null}
			</row>
			{option.description?.trim() ? (
				<box padding={{ left: 6 }}>
					<Show
						when={props.controller.expanded()}
						fallback={
							<scroll height={MAX_DESCRIPTION_ROWS} scrollbar="never" shrinkToFit>
								<markdown document={descriptionDocument} color="muted" />
							</scroll>
						}
					>
						<markdown document={descriptionDocument} color="muted" />
					</Show>
				</box>
			) : null}
			{option.preview?.trim() ? (
				<box padding={{ left: 6 }}>
					<rail prefix="│ " color="muted">
						<markdown document={previewDocument} color="muted" />
					</rail>
				</box>
			) : null}
		</box>
	);
}

function OtherRow(props: { question: ExtensionAskDialogQuestion; controller: AskDialogController }): JSX.Element {
	const index = (): number => props.question.options.length;
	const selected = (): boolean => props.controller.cursor() === index() && !props.controller.isReview();
	const answer = (): AskDialogAnswer | undefined => props.controller.answer();
	const selectWithMouse = (event: HostMouseEvent): void => {
		if (event.action !== "down" || event.button !== 0) return;
		props.controller.activateRow(index());
		event.preventDefault();
	};
	return (
		<box onMouse={selectWithMouse}>
			<row pad={false} wrap="continuation" continuationIndent={2}>
				<text width={2} shrink={0} color="accent">
					{selected() ? "❯ " : "  "}
				</text>
				<box grow={1}>
					<choice kind={props.question.multi ? "checkbox" : "radio"} checked={answer()?.customInput !== undefined}>
						{OTHER_OPTION}
					</choice>
				</box>
				{answer()?.noteRowKey === "other" ? (
					<text shrink={1} overflowPriority={0} color="success" wrap="clip">
						✎ note
					</text>
				) : null}
			</row>
			{answer()?.customInput !== undefined ? (
				<box padding={{ left: 6 }}>
					<text color="muted" wrap="word">
						{normalizedInlineInput(answer()?.customInput ?? "")}
					</text>
				</box>
			) : null}
		</box>
	);
}

/** Retained question-card dialog with navigation, review, notes, previews, and custom answers. */
export function AskDialogView(props: AskDialogViewProps): JSX.Element {
	const questions = normalizeDialogQuestions(props.questions);
	const controlsFocus = useFocus();
	const draftFocus = useFocus();
	createEffect(() => {
		const guard = props.options?.inputGuard;
		if (guard?.editor && guard.isBlocked()) draftFocus.focus();
		else controlsFocus.focus();
	});
	const question = (): ExtensionAskDialogQuestion | undefined => questions[props.controller.activeQuestion()];
	const questionDocument = createMemo(() => createDocument(displayText(question()?.question ?? "")));
	const [bodyViewport, setBodyViewport] = createSignal<ScrollViewportState>();
	const handleBodyViewport = (viewport: ScrollViewportState): void => {
		setBodyViewport(viewport);
		props.controller.setViewport(viewport);
	};
	const handleKey = (event: HostKeyEvent): void => {
		props.controller.handleInput(event.data);
		event.preventDefault();
	};
	const unansweredCount = createMemo(() => {
		let count = 0;
		for (let index = 0; index < questions.length; index++) {
			const answer = props.controller.answerAt(index);
			if (answer?.selected.size === 0 && answer?.customInput === undefined) count++;
		}
		return count;
	});
	const footer = (): string => {
		const cancel = `${cancelKeyLabel()} cancel`;
		const inputGuard = props.options?.inputGuard;
		if (inputGuard?.isBlocked()) return `${inputGuard.hint} · ${cancel}`;
		if (props.controller.isReview()) return `Enter submit · ↑/↓ scroll · ${cancel}`;
		const current = question();
		const action = current?.multi
			? `Space toggle · Enter ${questions.length > 1 ? "next" : "submit"}`
			: "Enter select · n note";
		const tabs = props.controller.hasReview ? " · Tab/←/→" : "";
		const viewport = bodyViewport();
		const scroll =
			viewport !== undefined && viewport.totalRows > viewport.height
				? ` · ${pageKeysLabel()} ${props.controller.answer()?.scrollOffset ? "↑" : "↓"} scroll`
				: "";
		const expand = question()?.options.some(option => option.description?.trim())
			? ` · ${expandKeyHint()} ${props.controller.expanded() ? "collapse" : "expand"} descriptions`
			: "";
		return `${action} · ↑/↓ move${tabs}${scroll} · ${cancel}${expand}`;
	};
	return (
		<stack height="fill">
			<frame
				grow={1}
				height="fill"
				title={
					props.controller.remainingSeconds() === undefined
						? "Ask"
						: `Ask (${props.controller.remainingSeconds()}s)`
				}
				paddingX={1}
				paddingY={0}
				borderPolicy="always"
				renderEmpty
			>
				<box height="fill" tabIndex={controlsFocus.tabIndex} onKey={handleKey}>
					<stack height="fill">
						{props.controller.hasReview ? (
							<tabs
								tabs={[
									...questions.map((item, index) => ({
										id: String(index),
										label: questionTabLabel(item, index),
									})),
									{ id: "submit", label: SUBMIT_OPTION },
								]}
								active={props.controller.isReview() ? "submit" : String(props.controller.activeQuestion())}
							/>
						) : null}
						{props.controller.isReview() ? (
							<text color="accent" bold>
								Review answers
							</text>
						) : (
							<scroll height={MAX_PROMPT_TITLE_ROWS} scrollbar="never" shrinkToFit>
								<markdown document={questionDocument()} />
							</scroll>
						)}
						<hr variant="frame" />
						{props.controller.isReview() ? (
							<scroll
								grow={1}
								offset={props.controller.reviewScrollOffset()}
								followTail={false}
								onViewport={handleBodyViewport}
							>
								<stack>
									{unansweredCount() > 0 ? (
										<text color="warning">
											{`${unansweredCount()} unanswered question${unansweredCount() === 1 ? "" : "s"}; Enter still submits.`}
										</text>
									) : null}
									<For each={questions}>
										{(item, index) => {
											const state = (): AskDialogAnswer | undefined => props.controller.answerAt(index());
											const submittedNote = (): string | undefined => {
												const answer = state();
												return answer === undefined ? undefined : noteForSubmittedAnswer(item, answer);
											};
											return (
												<stack>
													<text wrap="word">
														<span color="dim">{`${index() + 1}. ${questionTabLabel(item, index())}:`}</span>
														{` ${answerSummary(item, state())}`}
													</text>
													{submittedNote() !== undefined ? (
														<text color="muted" wrap="word">
															{`   Note: ${normalizedInlineInput(submittedNote() ?? "")}`}
														</text>
													) : null}
												</stack>
											);
										}}
									</For>
									<text color="accent">❯ {SUBMIT_OPTION}</text>
								</stack>
							</scroll>
						) : (
							<scroll
								grow={1}
								offset={props.controller.answer()?.scrollOffset ?? 0}
								followTail={false}
								onViewport={handleBodyViewport}
							>
								<stack>
									<For each={question()?.options ?? []}>
										{(option, index) => (
											<OptionRow
												question={question()!}
												index={index()}
												label={displayOptionLabels(question()!)[index()] ?? displayText(option.label)}
												controller={props.controller}
											/>
										)}
									</For>
									{question() === undefined ? null : (
										<OtherRow question={question()!} controller={props.controller} />
									)}
								</stack>
							</scroll>
						)}
						<hr variant="frame" />
						<row wrap="continuation" continuationIndent={2}>
							<text grow={1} color="dim" wrap="clip" overflow="ellipsis">
								{footer()}
							</text>
						</row>
					</stack>
				</box>
			</frame>
			<Show when={props.options?.inputGuard?.editor}>
				{(editor: Accessor<Editor>) => (
					<editor editor={editor()} tabIndex={draftFocus.tabIndex} onKey={handleKey} />
				)}
			</Show>
		</stack>
	);
}

export interface AskDialogOverlayProps {
	readonly questions: ExtensionAskDialogQuestion[];
	readonly callbacks: AskDialogCallbacks;
	readonly options?: AskDialogOptions;
}

export interface AskDialogHandle extends OverlayDisposer, AskDialogController {}

export function openAskDialogOverlay(tui: TUI, props: AskDialogOverlayProps): AskDialogHandle {
	const controller = createAskDialogController(props.questions, props.callbacks, { ...props.options, tui });
	const overlay = mountOverlay(tui, () => (
		<Portal to="overlay" anchor="bottom-center" width="100%" maxHeight="70%" mouseTracking>
			<AskDialogView {...props} controller={controller} />
		</Portal>
	));
	const dispose = (): void => {
		controller.dispose();
		overlay.dispose();
	};
	return Object.assign(dispose, controller, { hide: dispose, dispose });
}
