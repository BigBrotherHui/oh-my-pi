import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { MarkdownLayout } from "../components/markdown-engine";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	Show,
	useFocus,
	useViewport,
	type Accessor,
	type JSX,
} from "../reactive";
import { createDocument } from "../document/document";
import type { TextDocument } from "../document/types";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import { matchesKey, extractPrintableText } from "../keys";
import {
	matchesAppExternalEditor,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../keybinding-matchers";
import type { TUI } from "../tui";
import { replaceTabs } from "../utils";
import type { HookSelectorSlider } from "./hook-selector";
import { joinPlanSections, parsePlanSections, sectionDeletionSpan, type PlanSection } from "./plan-toc";

const OVERLAY_TITLE = "Plan Review";
const MIN_BODY_ROWS = 3;
const SIDEBAR_MIN_HEADINGS = 2;
const SIDEBAR_MIN_TOTAL_WIDTH = 64;
const MAX_ANNOTATION_CONTEXT_CHARS = 120;

type Focus = "toc" | "body" | "actions";

type AnnotationTarget = { kind: "section" } | { kind: "line"; row: number; context: string; contextTruncated: boolean };

interface OverlayAnnotation {
	readonly id: number;
	readonly note: string;
	readonly document: TextDocument;
	readonly target: AnnotationTarget;
}

interface OverlaySection extends PlanSection {
	readonly document: TextDocument;
	annotations: OverlayAnnotation[];
}

interface UndoEntry {
	readonly text: string;
	readonly annotations: OverlayAnnotation[][];
	readonly deleted: string[];
}

interface LineAnchorContext {
	readonly text: string;
	readonly truncated: boolean;
}

export interface PlanReviewAnnotationTarget {
	readonly sectionIndex: number;
	readonly row: number | null;
	readonly context: string | null;
	readonly contextTruncated?: boolean;
}

interface BodyRowAnchor {
	readonly sectionIndex: number;
	readonly row: number;
	readonly context: string;
	readonly contextTruncated: boolean;
}

interface BodyLayout {
	readonly anchors: readonly BodyRowAnchor[];
	readonly sectionOffsets: readonly number[];
}

export interface PlanReviewAnnotationState {
	annotations: Array<{
		section: { index: number; title: string; path?: string[]; contentHash?: string };
		target: { kind: "section" } | { kind: "line"; row: number; context: string; contextTruncated?: boolean };
		note: string;
	}>;
}

export interface PlanReviewOverlayCallbacks {
	onPick: (label: string) => void;
	onCancel: () => void;
	onCopyPlan?: (content: string) => void | Promise<void>;
	onExternalEditor?: () => void;
	onAnnotationExternalEditor?: (draft: string, commit: (text: string | null) => void) => void;
	onPlanEdited?: (content: string) => void;
	onFeedbackChange?: (feedback: string) => void;
	onAnnotationStateChange?: (state: PlanReviewAnnotationState) => void;
}

export interface PlanReviewOverlayOptions {
	promptTitle?: string;
	options: string[];
	disabledIndices?: number[];
	helpText?: string;
	initialIndex?: number;
	slider?: HookSelectorSlider;
	externalEditorLabel?: string;
	annotationState?: PlanReviewAnnotationState;
}

export interface PlanReviewController {
	readonly selectedIndex: Accessor<number>;
	readonly sliderIndex: Accessor<number>;
	readonly plan: Accessor<string>;
	readonly sections: Accessor<readonly OverlaySection[]>;
	readonly toc: Accessor<readonly number[]>;
	readonly tocBaseLevel: Accessor<number>;
	readonly tocCursor: Accessor<number>;
	readonly focus: Accessor<Focus>;
	readonly scrollOffset: Accessor<number>;
	readonly bodyHeight: Accessor<number>;
	readonly sidebarShown: Accessor<boolean>;
	readonly committed: Accessor<boolean>;
	readonly committedLabel: Accessor<string | undefined>;
	readonly annotating: Accessor<boolean>;
	readonly annotationDraft: Accessor<string>;
	readonly annotationTarget: Accessor<PlanReviewAnnotationTarget | undefined>;
	readonly annotationState: Accessor<PlanReviewAnnotationState>;
	readonly hoveredOption: Accessor<number | undefined>;
	readonly canCopyPlan: boolean;
	handleInput(data: string): void;
	select(): void;
	cancel(): void;
	setPlan(content: string): void;
	setPlanContent(content: string): void;
	setAnnotationDraft(value: string): void;
	submitAnnotation(value?: string): void;
	cancelAnnotation(): void;
	openAnnotationExternalEditor(): void;
	focusBody(): void;
	focusTocAt(position: number): void;
	scrollBy(delta: number): void;
	updateViewport(viewport: { readonly columns: number; readonly rows: number }): void;
	setSectionLayout(sectionIndex: number, layout: MarkdownLayout): void;
	setAnnotationLayout(sectionIndex: number, annotationId: number, layout: MarkdownLayout): void;
	setBodyViewport(viewport: { readonly totalRows: number; readonly height: number }): void;
	setHoveredOption(index: number | undefined): void;
	pickOption(index: number): void;
	dispose(): void;
}

function annotationDocument(note: string): TextDocument {
	return createDocument(
		annotationLines(note)
			.map((line, index) => `${index === 0 ? "▎ note: " : "      "}${line}`)
			.join("\n"),
	);
}

function cloneAnnotation(annotation: OverlayAnnotation, id: number): OverlayAnnotation {
	const target =
		annotation.target.kind === "section"
			? { kind: "section" as const }
			: {
					kind: "line" as const,
					row: annotation.target.row,
					context: annotation.target.context,
					contextTruncated: annotation.target.contextTruncated,
				};
	return { id, note: annotation.note, document: annotationDocument(annotation.note), target };
}

function lineContext(line: string): LineAnchorContext {
	const sanitized = sanitizeText(line).replace(/[\r\n]+/g, " ");
	const characters = Array.from(sanitized);
	const truncated = characters.length > MAX_ANNOTATION_CONTEXT_CHARS;
	const text = characters.slice(0, MAX_ANNOTATION_CONTEXT_CHARS).join("") + (truncated ? "…" : "");
	return { text: text || "(blank line)", truncated };
}

function resolveLineRow(
	storedRow: number,
	storedContext: LineAnchorContext,
	contexts: readonly LineAnchorContext[],
): number {
	if (contexts.length === 0) return -1;
	const targetRow = Math.max(0, Math.floor(storedRow));
	const normalize = (context: LineAnchorContext): string => {
		const normalized = sanitizeText(context.text).replace(/\s+/g, " ").trim();
		return context.truncated && normalized.endsWith("…") ? normalized.slice(0, -1) : normalized;
	};
	const expected = normalize(storedContext);
	if (!expected) return -1;
	let best = -1;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let row = 0; row < contexts.length; row++) {
		const candidate = normalize(contexts[row]!);
		if (candidate !== expected && !candidate.includes(expected) && !expected.includes(candidate)) continue;
		const distance = Math.abs(row - targetRow);
		if (distance < bestDistance) {
			best = row;
			bestDistance = distance;
		}
	}
	return best;
}

function annotationFeedback(note: string): string {
	if (!note.includes("\n")) return `- ${note}\n`;
	let fence = "```";
	while (note.includes(fence)) fence += "`";
	return `${fence}md\n${note}\n${fence}\n`;
}

export function createPlanReviewController(
	planContent: string,
	options: PlanReviewOverlayOptions,
	callbacks: PlanReviewOverlayCallbacks,
): PlanReviewController {
	const disabled = new Set(
		(options.disabledIndices ?? []).filter(
			index => Number.isInteger(index) && index >= 0 && index < options.options.length,
		),
	);
	const slider = options.slider && options.slider.segments.length > 0 ? options.slider : undefined;
	const makeSections = (content: string): OverlaySection[] =>
		parsePlanSections(content).map(section => ({
			...section,
			document: createDocument(section.raw),
			annotations: [],
		}));
	let sectionEntries = makeSections(planContent);
	let undo: UndoEntry[] = [];
	let deleted: string[] = [];
	let nextAnnotationId = 0;
	let sectionRows: LineAnchorContext[][] = [];
	const annotationRows = new Map<number, LineAnchorContext[]>();
	let scrollProgress = 0;
	let disposed = false;

	const coerceIndex = (index: number): number => {
		const max = options.options.length - 1;
		if (max < 0) return -1;
		const clamped = Math.max(0, Math.min(max, Number.isFinite(index) ? Math.trunc(index) : 0));
		if (!disabled.has(clamped)) return clamped;
		for (let candidate = clamped + 1; candidate <= max; candidate++) if (!disabled.has(candidate)) return candidate;
		for (let candidate = clamped - 1; candidate >= 0; candidate--) if (!disabled.has(candidate)) return candidate;
		return clamped;
	};

	const [selectedIndex, setSelectedIndex] = createSignal(coerceIndex(options.initialIndex ?? 0));
	const [sliderIndex, setSliderIndex] = createSignal(
		slider ? Math.max(0, Math.min(slider.segments.length - 1, slider.index)) : 0,
	);
	const [plan, setPlanSignal] = createSignal(planContent);
	const [sections, setSections] = createSignal<readonly OverlaySection[]>(sectionEntries);
	const [toc, setToc] = createSignal<readonly number[]>([]);
	const [tocBaseLevel, setTocBaseLevel] = createSignal(1);
	const [tocCursor, setTocCursor] = createSignal(0);
	const [focus, setFocus] = createSignal<Focus>("actions");
	const [scrollOffset, setScrollOffset] = createSignal(0);
	const [bodyHeight, setBodyHeight] = createSignal(MIN_BODY_ROWS);
	const [bodyRows, setBodyRows] = createSignal(0);
	const [sidebarShown, setSidebarShown] = createSignal(false);
	const [bodyLayout, setBodyLayout] = createSignal<BodyLayout>({ anchors: [], sectionOffsets: [] });
	const [committed, setCommitted] = createSignal(false);
	const [committedLabel, setCommittedLabel] = createSignal<string>();
	const [annotating, setAnnotating] = createSignal(false);
	const [annotationDraft, setAnnotationDraftSignal] = createSignal("");
	const [annotationTarget, setAnnotationTarget] = createSignal<PlanReviewAnnotationTarget>();
	const [annotationState, setAnnotationState] = createSignal<PlanReviewAnnotationState>({ annotations: [] });
	const [hoveredOption, setHoveredOptionSignal] = createSignal<number>();

	const rebuildToc = (): void => {
		const headings: number[] = [];
		for (let index = 0; index < sectionEntries.length; index++)
			if (sectionEntries[index]!.level >= 1) headings.push(index);
		let minLevel = Number.POSITIVE_INFINITY;
		for (const index of headings) minLevel = Math.min(minLevel, sectionEntries[index]!.level);
		const topLevel = headings.filter(index => sectionEntries[index]!.level === minLevel);
		const titleIndex = topLevel.length === 1 && headings[0] === topLevel[0] ? topLevel[0] : -1;
		const nextToc = headings.filter(index => index !== titleIndex);
		setToc(nextToc);
		setTocBaseLevel(nextToc.length > 0 ? Math.min(...nextToc.map(index => sectionEntries[index]!.level)) : 1);
		setTocCursor(current => Math.min(current, Math.max(0, nextToc.length - 1)));
	};

	const sectionPaths = (): string[][] => {
		const stack: Array<{ level: number; title: string }> = [];
		return sectionEntries.map(section => {
			if (section.level < 1) return [];
			while (stack.length > 0 && stack[stack.length - 1]!.level >= section.level) stack.pop();
			stack.push({ level: section.level, title: section.title });
			return stack.map(entry => entry.title);
		});
	};

	const sectionContentHash = (section: OverlaySection): string =>
		`${section.raw.length}:${Bun.hash(section.raw).toString(16)}`;

	const snapshotAnnotations = (): PlanReviewAnnotationState => {
		const annotations: PlanReviewAnnotationState["annotations"] = [];
		const paths = sectionPaths();
		for (let sectionIndex = 0; sectionIndex < sectionEntries.length; sectionIndex++) {
			const section = sectionEntries[sectionIndex]!;
			for (const annotation of section.annotations) {
				annotations.push({
					section: {
						index: sectionIndex,
						title: section.title,
						path: paths[sectionIndex]!,
						contentHash: sectionContentHash(section),
					},
					target:
						annotation.target.kind === "section"
							? { kind: "section" }
							: {
									kind: "line",
									row: annotation.target.row,
									context: annotation.target.context,
									contextTruncated: annotation.target.contextTruncated,
								},
					note: annotation.note,
				});
			}
		}
		return { annotations };
	};

	const restoreAnnotationState = (state: PlanReviewAnnotationState | undefined): void => {
		if (!state || !Array.isArray(state.annotations)) return;
		const paths = sectionPaths();
		const hashes = sectionEntries.map(sectionContentHash);
		for (const entry of state.annotations) {
			if (
				!entry ||
				typeof entry.note !== "string" ||
				!entry.section ||
				!entry.target ||
				typeof entry.section.title !== "string"
			)
				continue;
			const note = entry.note.trim();
			if (!note) continue;
			const storedIndex = Number.isInteger(entry.section.index) ? entry.section.index : -1;
			let candidates: number[];
			if (
				Array.isArray(entry.section.path) &&
				entry.section.path.every(segment => typeof segment === "string") &&
				typeof entry.section.contentHash === "string"
			) {
				candidates = [];
				for (let index = 0; index < sectionEntries.length; index++) {
					const path = paths[index]!;
					if (
						sectionEntries[index]!.title === entry.section.title &&
						hashes[index] === entry.section.contentHash &&
						path.length === entry.section.path.length &&
						path.every((segment, pathIndex) => segment === entry.section.path![pathIndex])
					) {
						candidates.push(index);
					}
				}
			} else {
				candidates =
					storedIndex >= 0 &&
					storedIndex < sectionEntries.length &&
					sectionEntries[storedIndex]!.title === entry.section.title
						? [storedIndex]
						: [];
			}
			if (candidates.length === 0) continue;
			const sectionIndex = candidates.reduce((best, candidate) =>
				Math.abs(candidate - storedIndex) < Math.abs(best - storedIndex) ? candidate : best,
			);
			const section = sectionEntries[sectionIndex]!;
			if (entry.target.kind === "section") {
				if (section.level >= 1) {
					section.annotations.push({
						id: nextAnnotationId++,
						note,
						document: annotationDocument(note),
						target: { kind: "section" },
					});
				}
				continue;
			}
			if (
				entry.target.kind !== "line" ||
				!Number.isFinite(entry.target.row) ||
				typeof entry.target.context !== "string"
			) {
				continue;
			}
			const storedContext = { text: entry.target.context, truncated: entry.target.contextTruncated === true };
			const contexts = sectionRows[sectionIndex] ?? [];
			const row =
				contexts.length === 0
					? Math.max(0, Math.floor(entry.target.row))
					: resolveLineRow(entry.target.row, storedContext, contexts);
			if (row < 0) continue;
			const context = contexts[row] ?? storedContext;
			section.annotations.push({
				id: nextAnnotationId++,
				note,
				document: annotationDocument(note),
				target: { kind: "line", row, context: context.text, contextTruncated: context.truncated },
			});
		}
	};

	const maxScrollOffset = (): number => Math.max(0, bodyRows() - bodyHeight());
	const captureScrollProgress = (): void => {
		const maximum = maxScrollOffset();
		if (maximum > 0) scrollProgress = scrollOffset() / maximum;
	};
	const setBodyOffset = (next: number): void => {
		const maximum = maxScrollOffset();
		const offset = Math.max(0, Math.min(maximum, Math.round(next)));
		setScrollOffset(offset);
		if (maximum > 0) scrollProgress = offset / maximum;
	};

	const rebuildBodyLayout = (): void => {
		captureScrollProgress();
		const anchors: BodyRowAnchor[] = [];
		const offsets: number[] = new Array(sectionEntries.length);
		for (let sectionIndex = 0; sectionIndex < sectionEntries.length; sectionIndex++) {
			const section = sectionEntries[sectionIndex]!;
			offsets[sectionIndex] = anchors.length;
			const contexts = sectionRows[sectionIndex] ?? [];
			for (let row = 0; row < contexts.length; row++) {
				const context = contexts[row]!;
				anchors.push({ sectionIndex, row, context: context.text, contextTruncated: context.truncated });
			}
			for (const annotation of section.annotations) {
				const target =
					annotation.target.kind === "section"
						? { sectionIndex, row: 0, context: section.title || "Plan preamble", contextTruncated: false }
						: {
								sectionIndex,
								row: annotation.target.row,
								context: annotation.target.context,
								contextTruncated: annotation.target.contextTruncated,
							};
				for (const _ of annotationRows.get(annotation.id) ?? []) anchors.push(target);
			}
		}
		setBodyLayout({ anchors, sectionOffsets: offsets });
		const maximum = maxScrollOffset();
		setScrollOffset(maximum > 0 ? Math.round(scrollProgress * maximum) : 0);
	};

	const updateViewport = (viewport: { readonly columns: number }): void => {
		setSidebarShown(toc().length >= SIDEBAR_MIN_HEADINGS && viewport.columns >= SIDEBAR_MIN_TOTAL_WIDTH);
	};

	const updateSectionLayout = (sectionIndex: number, layout: MarkdownLayout): void => {
		if (disposed || !sectionEntries[sectionIndex]) return;
		const contexts = layout.rows.map(lineContext);
		sectionRows[sectionIndex] = contexts;
		const section = sectionEntries[sectionIndex]!;
		let remapped = false;
		for (let index = 0; index < section.annotations.length; index++) {
			const annotation = section.annotations[index]!;
			if (annotation.target.kind === "section") continue;
			const row = resolveLineRow(
				annotation.target.row,
				{ text: annotation.target.context, truncated: annotation.target.contextTruncated },
				contexts,
			);
			if (row < 0) continue;
			const context = contexts[row]!;
			if (
				annotation.target.row !== row ||
				annotation.target.context !== context.text ||
				annotation.target.contextTruncated !== context.truncated
			) {
				section.annotations[index] = {
					...annotation,
					target: { kind: "line", row, context: context.text, contextTruncated: context.truncated },
				};
				remapped = true;
			}
		}
		rebuildBodyLayout();
		if (remapped) recomputeFeedback();
	};

	const updateAnnotationLayout = (sectionIndex: number, annotationId: number, layout: MarkdownLayout): void => {
		if (disposed || !sectionEntries[sectionIndex]?.annotations.some(annotation => annotation.id === annotationId))
			return;
		annotationRows.set(annotationId, layout.rows.map(lineContext));
		rebuildBodyLayout();
	};

	const updateBodyViewport = (viewport: { readonly totalRows: number; readonly height: number }): void => {
		const rows = Math.max(0, Math.trunc(viewport.totalRows));
		const height = Math.max(MIN_BODY_ROWS, Math.trunc(viewport.height));
		setBodyRows(rows);
		setBodyHeight(height);
		const maximum = Math.max(0, rows - height);
		setScrollOffset(current => Math.max(0, Math.min(maximum, current)));
		if (maximum > 0) scrollProgress = scrollOffset() / maximum;
	};

	const publishSections = (): void => {
		setSections(sectionEntries.map(section => ({ ...section, annotations: section.annotations.slice() })));
		rebuildBodyLayout();
	};

	const recomputeFeedback = (): void => {
		const state = snapshotAnnotations();
		setAnnotationState(state);
		callbacks.onAnnotationStateChange?.(state);
		const annotated = sectionEntries.filter(section => section.annotations.length > 0);
		if (annotated.length === 0 && deleted.length === 0) {
			callbacks.onFeedbackChange?.("");
			return;
		}
		let feedback = "Refinement feedback on the plan:\n";
		if (deleted.length > 0) {
			feedback += "\nRemove these sections:\n";
			for (const title of deleted) feedback += `- ${title}\n`;
		}
		for (const section of annotated) {
			feedback += `\n## ${section.title || "Plan preamble"}\n`;
			for (const annotation of section.annotations) {
				if (annotation.target.kind === "line") feedback += `> Line: ${annotation.target.context}\n`;
				feedback += annotationFeedback(annotation.note);
			}
		}
		callbacks.onFeedbackChange?.(feedback);
	};

	const deriveTocCursorFromScroll = (): number => {
		const tocEntries = toc();
		if (tocEntries.length === 0) return 0;
		const offsets = bodyLayout().sectionOffsets;
		let currentSection = 0;
		for (let index = 0; index < sectionEntries.length; index++) {
			if ((offsets[index] ?? 0) <= scrollOffset()) currentSection = index;
			else break;
		}
		let currentToc = 0;
		for (let position = 0; position < tocEntries.length; position++) {
			if (tocEntries[position]! <= currentSection) currentToc = position;
			else break;
		}
		return currentToc;
	};

	const setFocusRegion = (region: Focus): void => {
		setFocus(region);
		if (region === "toc") setTocCursor(deriveTocCursorFromScroll());
	};

	const scrubBodyToToc = (): void => {
		const sectionIndex = toc()[tocCursor()];
		if (sectionIndex === undefined) return;
		const offset = bodyLayout().sectionOffsets[sectionIndex];
		if (offset !== undefined) setBodyOffset(offset);
	};

	const moveSelection = (delta: number): void => {
		const max = options.options.length - 1;
		if (max < 0) return;
		let current = selectedIndex();
		while (true) {
			const next = Math.max(0, Math.min(max, current + delta));
			if (next === current) return;
			current = next;
			if (!disabled.has(current)) {
				setSelectedIndex(current);
				return;
			}
		}
	};

	const firstEnabled = (): number => {
		for (let index = 0; index < options.options.length; index++) if (!disabled.has(index)) return index;
		return -1;
	};

	const moveSlider = (delta: number): void => {
		if (!slider) return;
		const next = Math.max(0, Math.min(slider.segments.length - 1, sliderIndex() + delta));
		if (next === sliderIndex()) return;
		setSliderIndex(next);
		slider.onChange?.(next);
	};

	const select = (): void => {
		const index = selectedIndex();
		const option = options.options[index];
		if (!option || disabled.has(index) || committed() || disposed) return;
		setCommitted(true);
		setCommittedLabel(option);
		callbacks.onPick(option);
	};

	const pushUndo = (): void => {
		undo.push({
			text: joinPlanSections(sectionEntries),
			annotations: sectionEntries.map(section =>
				section.annotations.map(annotation => cloneAnnotation(annotation, nextAnnotationId++)),
			),
			deleted: [...deleted],
		});
	};

	const deleteSelectedSection = (): void => {
		const sectionIndex = toc()[tocCursor()];
		if (sectionIndex === undefined) return;
		const span = sectionDeletionSpan(sectionEntries, sectionIndex);
		if (span.length === 0) return;
		pushUndo();
		for (const index of span) {
			const section = sectionEntries[index]!;
			if (section.level >= 1 && section.title) deleted.push(section.title);
			for (const annotation of section.annotations) annotationRows.delete(annotation.id);
		}
		for (let index = span.length - 1; index >= 0; index--) sectionEntries.splice(span[index]!, 1);
		sectionRows.splice(sectionIndex, span.length);
		rebuildToc();
		setPlanSignal(joinPlanSections(sectionEntries));
		scrubBodyToToc();
		publishSections();
		callbacks.onPlanEdited?.(plan());
		recomputeFeedback();
	};

	const undoLast = (): void => {
		const entry = undo.pop();
		if (!entry) return;
		sectionEntries = makeSections(entry.text);
		sectionRows = [];
		annotationRows.clear();
		for (let index = 0; index < sectionEntries.length; index++) {
			sectionEntries[index]!.annotations =
				entry.annotations[index]?.map(annotation => cloneAnnotation(annotation, nextAnnotationId++)) ?? [];
		}
		deleted = [...entry.deleted];
		rebuildToc();
		setPlanSignal(joinPlanSections(sectionEntries));
		scrubBodyToToc();
		publishSections();
		callbacks.onPlanEdited?.(plan());
		recomputeFeedback();
	};

	const startAnnotation = (target: PlanReviewAnnotationTarget): void => {
		setAnnotationTarget(target);
		setAnnotationDraftSignal("");
		setAnnotating(true);
	};

	const startSectionAnnotation = (): void => {
		const sectionIndex = toc()[tocCursor()];
		if (sectionIndex !== undefined) startAnnotation({ sectionIndex, row: null, context: null });
	};

	const startBodyAnnotation = (): void => {
		const anchors = bodyLayout().anchors;
		const anchor = anchors[Math.max(0, Math.min(anchors.length - 1, Math.floor(scrollOffset())))];
		if (anchor) startAnnotation(anchor);
	};

	const submitAnnotation = (value = annotationDraft()): void => {
		if (!annotating()) return;
		const target = annotationTarget();
		const note = value.trim();
		setAnnotating(false);
		setAnnotationTarget();
		setAnnotationDraftSignal("");
		if (note && target && sectionEntries[target.sectionIndex]) {
			pushUndo();
			sectionEntries[target.sectionIndex]!.annotations.push({
				id: nextAnnotationId++,
				note,
				document: annotationDocument(note),
				target:
					target.row === null
						? { kind: "section" }
						: {
								kind: "line",
								row: target.row,
								context: target.context ?? "",
								contextTruncated: target.contextTruncated === true,
							},
			});
			publishSections();
			recomputeFeedback();
		}
	};

	const cancelAnnotation = (): void => {
		if (!annotating()) return;
		setAnnotating(false);
		setAnnotationTarget();
		setAnnotationDraftSignal("");
	};

	const setPlanContent = (content: string): void => {
		if (disposed) return;
		const annotations = snapshotAnnotations();
		sectionEntries = makeSections(content);
		sectionRows = [];
		annotationRows.clear();
		setPlanSignal(content);
		deleted = [];
		undo = [];
		setScrollOffset(0);
		scrollProgress = 0;
		setTocCursor(0);
		rebuildToc();
		restoreAnnotationState(annotations);
		publishSections();
		recomputeFeedback();
	};

	const setPlan = (content: string): void => {
		if (disposed) return;
		setPlanContent(content);
		callbacks.onPlanEdited?.(content);
	};

	const scrollBy = (delta: number): void => {
		if (disposed) return;
		setBodyOffset(scrollOffset() + delta);
		if (focus() !== "toc") setTocCursor(deriveTocCursorFromScroll());
	};

	const moveToc = (delta: number): void => {
		const entries = toc();
		if (entries.length === 0) return;
		const next = Math.max(0, Math.min(entries.length - 1, tocCursor() + delta));
		if (next === tocCursor()) return;
		setTocCursor(next);
		scrubBodyToToc();
	};

	const cycleRegion = (direction: number): void => {
		const regions: Focus[] = sidebarShown() ? ["toc", "body", "actions"] : ["body", "actions"];
		const current = regions.indexOf(focus());
		const base = current < 0 ? regions.length - 1 : current;
		setFocusRegion(regions[(base + direction + regions.length) % regions.length]!);
	};

	const handleBodyScroll = (data: string): boolean => {
		if (matchesKey(data, "home")) {
			scrollProgress = 0;
			setBodyOffset(0);
			return true;
		}
		if (matchesKey(data, "end")) {
			scrollProgress = 1;
			setBodyOffset(maxScrollOffset());
			return true;
		}
		if (matchesKey(data, "pageUp")) {
			scrollBy(-Math.max(1, bodyHeight() - 1));
			return true;
		}
		if (matchesKey(data, "pageDown")) {
			scrollBy(Math.max(1, bodyHeight() - 1));
			return true;
		}
		if (matchesKey(data, "shift+up")) {
			scrollBy(-5);
			return true;
		}
		if (matchesKey(data, "shift+down")) {
			scrollBy(5);
			return true;
		}
		if (data === "g") {
			scrollProgress = 0;
			setBodyOffset(0);
			return true;
		}
		if (data === "G") {
			scrollProgress = 1;
			setBodyOffset(maxScrollOffset());
			return true;
		}
		return false;
	};

	const handleAnnotationInput = (data: string): void => {
		if (callbacks.onAnnotationExternalEditor && matchesAppExternalEditor(data)) {
			controller.openAnnotationExternalEditor();
			return;
		}
		if (matchesSelectCancel(data)) {
			cancelAnnotation();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			submitAnnotation();
			return;
		}
		if (matchesKey(data, "backspace")) {
			setAnnotationDraftSignal(value => Array.from(value).slice(0, -1).join(""));
			return;
		}
		const text = extractPrintableText(data);
		if (text) setAnnotationDraftSignal(value => value + text.replace(/[\r\n]/g, ""));
	};

	const handleInput = (data: string): void => {
		if (disposed || committed()) return;
		if (annotating()) {
			handleAnnotationInput(data);
			return;
		}
		if (matchesSelectCancel(data)) {
			setCommitted(true);
			callbacks.onCancel();
			return;
		}
		if (matchesAppExternalEditor(data)) {
			callbacks.onExternalEditor?.();
			return;
		}
		if (callbacks.onCopyPlan && data === "c") {
			void callbacks.onCopyPlan(joinPlanSections(sectionEntries));
			return;
		}
		if (matchesKey(data, "tab") || data === "\t") {
			cycleRegion(1);
			return;
		}
		if (matchesKey(data, "shift+tab") || data === "\x1b[Z") {
			cycleRegion(-1);
			return;
		}
		if (focus() === "actions") {
			if (matchesKey(data, "left") || (slider && matchesKey(data, "h"))) {
				moveSlider(-1);
				return;
			}
			if (matchesKey(data, "right") || (slider && matchesKey(data, "l"))) {
				moveSlider(1);
				return;
			}
			if (matchesSelectUp(data) || matchesKey(data, "k")) {
				if (selectedIndex() === firstEnabled()) setFocusRegion("body");
				else moveSelection(-1);
				return;
			}
			if (matchesSelectDown(data) || matchesKey(data, "j")) {
				moveSelection(1);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				select();
				return;
			}
			handleBodyScroll(data);
			return;
		}
		if (focus() === "body") {
			if (data === "a") {
				startBodyAnnotation();
				return;
			}
			if (matchesKey(data, "left") || matchesKey(data, "h")) {
				if (sidebarShown()) setFocusRegion("toc");
				return;
			}
			if (
				matchesKey(data, "right") ||
				matchesKey(data, "l") ||
				matchesKey(data, "enter") ||
				matchesKey(data, "return") ||
				data === "\n"
			) {
				setFocusRegion("actions");
				return;
			}
			if (matchesSelectUp(data) || matchesKey(data, "k")) {
				if (scrollOffset() <= 0 && sidebarShown()) setFocusRegion("toc");
				else scrollBy(-1);
				return;
			}
			if (matchesSelectDown(data) || matchesKey(data, "j")) {
				if (scrollOffset() >= maxScrollOffset()) setFocusRegion("actions");
				else scrollBy(1);
				return;
			}
			handleBodyScroll(data);
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			moveToc(-1);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			if (tocCursor() >= toc().length - 1) setFocusRegion("actions");
			else moveToc(1);
			return;
		}
		if (
			matchesKey(data, "right") ||
			matchesKey(data, "l") ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			data === "\n"
		) {
			setFocusRegion("body");
			return;
		}
		if (data === "d" || matchesKey(data, "delete")) {
			deleteSelectedSection();
			return;
		}
		if (data === "a") {
			startSectionAnnotation();
			return;
		}
		if (data === "u") undoLast();
	};

	const controller: PlanReviewController = {
		selectedIndex,
		sliderIndex,
		plan,
		sections,
		toc,
		tocBaseLevel,
		tocCursor,
		focus,
		scrollOffset,
		bodyHeight,
		sidebarShown,
		committed,
		committedLabel,
		annotating,
		annotationDraft,
		annotationTarget,
		annotationState,
		hoveredOption,
		canCopyPlan: callbacks.onCopyPlan !== undefined,
		handleInput,
		select,
		cancel(): void {
			if (disposed || committed()) return;
			setCommitted(true);
			callbacks.onCancel();
		},
		setPlan,
		setPlanContent,
		setAnnotationDraft(value): void {
			if (!disposed && annotating()) setAnnotationDraftSignal(value);
		},
		submitAnnotation,
		cancelAnnotation,
		openAnnotationExternalEditor(): void {
			if (disposed || !annotating() || !callbacks.onAnnotationExternalEditor) return;
			callbacks.onAnnotationExternalEditor(annotationDraft(), text => {
				if (!disposed && text !== null) submitAnnotation(text);
			});
		},
		focusBody(): void {
			if (!disposed && !committed()) setFocusRegion("body");
		},
		focusTocAt(position): void {
			if (disposed || committed() || position < 0 || position >= toc().length) return;
			setFocusRegion("toc");
			setTocCursor(position);
			scrubBodyToToc();
		},
		scrollBy,
		updateViewport,
		setSectionLayout: updateSectionLayout,
		setAnnotationLayout: updateAnnotationLayout,
		setBodyViewport: updateBodyViewport,
		setHoveredOption(index): void {
			setHoveredOptionSignal(index !== undefined && !disabled.has(index) ? index : undefined);
		},
		pickOption(index): void {
			if (disposed || committed() || disabled.has(index) || !options.options[index]) return;
			setFocusRegion("actions");
			setSelectedIndex(index);
			select();
		},
		dispose(): void {
			disposed = true;
		},
	};

	rebuildToc();
	restoreAnnotationState(options.annotationState);
	publishSections();
	if (options.annotationState?.annotations.length) recomputeFeedback();

	return controller;
}

function annotationLines(note: string): string[] {
	return note.split(/\r?\n/).map(line => replaceTabs(sanitizeText(line)));
}

function PlanReviewBody(props: { readonly controller: PlanReviewController }): JSX.Element {
	return (
		<For each={props.controller.sections()}>
			{(section, sectionIndex) => (
				<stack>
					<markdown
						document={section.document}
						onLayout={layout => props.controller.setSectionLayout(sectionIndex(), layout)}
					/>
					<For each={section.annotations}>
						{annotation => (
							<markdown
								document={annotation.document}
								color="accent"
								onLayout={layout => props.controller.setAnnotationLayout(sectionIndex(), annotation.id, layout)}
							/>
						)}
					</For>
				</stack>
			)}
		</For>
	);
}

export interface PlanReviewOverlayViewProps {
	readonly controller: PlanReviewController;
	readonly options: PlanReviewOverlayOptions;
}

export function PlanReviewOverlayView(props: PlanReviewOverlayViewProps): JSX.Element {
	const annotationFocus = useFocus();
	const viewport = useViewport();
	const optionRows = createMemo(() =>
		props.options.options.map((label, index) => ({
			label,
			index,
			disabled: props.options.disabledIndices?.includes(index) === true,
		})),
	);
	const help = (): string => {
		if (props.controller.committed())
			return "Applying your selection — this can take a moment while context is prepared.";
		if (props.controller.annotating())
			return (
				"enter save · esc cancel" +
				(props.options.externalEditorLabel ? ` · ${props.options.externalEditorLabel} editor` : "")
			);
		const parts: string[] = [];
		switch (props.controller.focus()) {
			case "actions":
				parts.push("↑↓ select", "⏎ confirm");
				if (props.options.slider?.segments.length) parts.push("◂▸ model");
				break;
			case "toc":
				parts.push("↑↓ section", "⏎ open", "a annotate", "d delete", "u undo");
				break;
			case "body":
				parts.push("↑↓ scroll", "⇧ faster", "pgup/pgdn", "g/G ends", "a annotate");
				break;
		}
		if (props.controller.canCopyPlan) parts.push("c copy");
		parts.push("tab regions");
		if (props.options.externalEditorLabel && props.controller.focus() !== "toc")
			parts.push(`${props.options.externalEditorLabel} editor`);
		parts.push(props.options.helpText ?? "esc cancel");
		return parts.join(" · ");
	};
	const key = (event: HostKeyEvent): void => {
		if (props.controller.annotating()) return;
		props.controller.handleInput(event.data);
		event.preventDefault();
		event.stopPropagation();
	};
	const annotationKey = (event: HostKeyEvent): void => {
		if (matchesAppExternalEditor(event.data)) {
			props.controller.openAnnotationExternalEditor();
			event.preventDefault();
		}
		event.stopPropagation();
	};
	const mouse = (event: HostMouseEvent): void => {
		if (event.action === "wheel") props.controller.scrollBy(event.wheel * 3);
		else if (event.action === "move") props.controller.setHoveredOption(undefined);
		else if (event.action === "down") props.controller.focusBody();
		event.stopPropagation();
	};
	createEffect(() => {
		if (props.controller.annotating()) annotationFocus.focus();
	});
	createEffect(() => {
		props.controller.updateViewport(viewport());
	});
	const bodyRows = (): number => {
		const sliderRows =
			props.controller.committed() || !props.options.slider?.segments.length
				? 0
				: props.options.slider.segments[props.controller.sliderIndex()]?.detail
					? 2
					: 1;
		const chromeRows =
			4 +
			(props.options.promptTitle ? 1 : 0) +
			sliderRows +
			(props.controller.committed() ? 1 : props.options.options.length) +
			(props.controller.annotating() ? 3 : 1);
		return Math.max(MIN_BODY_ROWS, viewport().rows - chromeRows);
	};
	const tocBody = (
		<scroll
			height={bodyRows()}
			offset={Math.max(0, props.controller.tocCursor() - Math.floor(bodyRows() / 2))}
			followTail={false}
		>
			<For each={props.controller.toc()}>
				{(sectionIndex, position) => {
					const section = () => props.controller.sections()[sectionIndex]!;
					const focused = () => props.controller.focus() === "toc" && props.controller.tocCursor() === position();
					const current = () => props.controller.tocCursor() === position();
					return (
						<text
							pad
							wrap="clip"
							overflow="ellipsis"
							color={focused() || current() ? "accent" : "muted"}
							background={focused() ? "selectedBg" : undefined}
							bold={focused()}
							onMouse={event => {
								if (event.action === "wheel") props.controller.scrollBy(event.wheel * 3);
								else if (event.action === "down") props.controller.focusTocAt(position());
								else if (event.action === "move") props.controller.setHoveredOption(undefined);
								event.stopPropagation();
							}}
						>
							{focused() ? "›" : current() ? "▎" : " "}
							{" ".repeat(Math.max(0, section().level - props.controller.tocBaseLevel()))}
							{section().title || "(untitled)"}
							{section().annotations.length > 0 ? " ✎" : ""}
						</text>
					);
				}}
			</For>
		</scroll>
	);
	return (
		<box tabIndex={0} onKey={key} onMouse={mouse}>
			<frame title={OVERLAY_TITLE} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
				<Show
					when={props.controller.sidebarShown()}
					fallback={
						<scroll
							height={bodyRows()}
							offset={props.controller.scrollOffset()}
							followTail={false}
							onMouse={mouse}
							onViewport={props.controller.setBodyViewport}
						>
							<PlanReviewBody controller={props.controller} />
						</scroll>
					}
				>
					<split
						height={bodyRows()}
						leftSize={{ ratio: 0.24, min: 18, max: 30 }}
						rightMinWidth={40}
						splitAt={SIDEBAR_MIN_TOTAL_WIDTH}
						narrowPane="right"
						divider="│"
					>
						<box>{tocBody}</box>
						<box>
							<scroll
								height={bodyRows()}
								offset={props.controller.scrollOffset()}
								followTail={false}
								onMouse={mouse}
								onViewport={props.controller.setBodyViewport}
							>
								<PlanReviewBody controller={props.controller} />
							</scroll>
						</box>
					</split>
				</Show>
				<hr variant="frame" />
				<Show when={props.options.promptTitle}>
					<text color="accent" bold wrap="word">
						{props.options.promptTitle}
					</text>
				</Show>
				<Show
					when={!props.controller.committed() && props.options.slider && props.options.slider.segments.length > 0}
				>
					<row>
						<text color={props.controller.sliderIndex() > 0 ? "accent" : "dim"}>◂ </text>
						<tabs
							label={props.options.slider!.caption}
							tabs={props.options.slider!.segments.map((segment, index) => ({
								id: String(index),
								label: segment.label,
							}))}
							active={String(props.controller.sliderIndex())}
						/>
						<text
							color={
								props.controller.sliderIndex() < props.options.slider!.segments.length - 1 ? "accent" : "dim"
							}
						>
							{" "}
							▸
						</text>
					</row>
					<Show when={props.options.slider!.segments[props.controller.sliderIndex()]?.detail}>
						<text color="muted"> ↳ {props.options.slider!.segments[props.controller.sliderIndex()]?.detail}</text>
					</Show>
				</Show>
				<Show
					when={props.controller.committed()}
					fallback={
						<For each={optionRows()}>
							{option => (
								<row
									onMouse={event => {
										if (event.action === "wheel") props.controller.scrollBy(event.wheel * 3);
										else if (event.action === "move") props.controller.setHoveredOption(option.index);
										else if (event.action === "down") props.controller.pickOption(option.index);
										event.stopPropagation();
									}}
								>
									<text
										color={
											option.index === props.controller.selectedIndex()
												? props.controller.focus() === "actions"
													? "accent"
													: "dim"
												: undefined
										}
									>
										{option.index === props.controller.selectedIndex() ? "› " : "  "}
									</text>
									<text
										grow={1}
										pad
										wrap="clip"
										color={
											option.disabled
												? "dim"
												: option.index === props.controller.selectedIndex() &&
													  props.controller.focus() === "actions"
													? "accent"
													: undefined
										}
										bold={
											!option.disabled &&
											option.index === props.controller.selectedIndex() &&
											props.controller.focus() === "actions"
										}
										background={
											!option.disabled && option.index === props.controller.hoveredOption()
												? "selectedBg"
												: undefined
										}
									>
										{option.label}
									</text>
								</row>
							)}
						</For>
					}
				>
					<text color="accent" bold>
						{props.controller.committedLabel()
							? `${props.controller.committedLabel()} — submitting…`
							: "Submitting…"}
					</text>
				</Show>
				<hr variant="frame" />
				<Show
					when={props.controller.annotating()}
					fallback={
						<text color="dim" wrap="clip">
							{help()}
						</text>
					}
				>
					<stack>
						<text wrap="clip">
							<span color="dim">Annotate </span>
							<span color="accent">
								‹
								{props.controller.sections()[props.controller.annotationTarget()?.sectionIndex ?? -1]?.title ||
									"Plan preamble"}
								›
								{props.controller.annotationTarget()?.row === null
									? ""
									: ` · ${props.controller.annotationTarget()?.context ?? ""}`}
							</span>
						</text>
						<input
							tabIndex={annotationFocus.tabIndex}
							value={props.controller.annotationDraft()}
							prompt="> "
							useTerminalCursor={false}
							onKey={annotationKey}
							onChange={props.controller.setAnnotationDraft}
							onSubmit={props.controller.submitAnnotation}
							onEscape={props.controller.cancelAnnotation}
						/>
						<text color="dim" wrap="clip">
							{help()}
						</text>
					</stack>
				</Show>
			</frame>
		</box>
	);
}

export interface PlanReviewOverlayProps {
	readonly planContent: string;
	readonly options: PlanReviewOverlayOptions;
	readonly callbacks: PlanReviewOverlayCallbacks;
}

export interface PlanReviewHandle extends OverlayDisposer, PlanReviewController {}

export function openPlanReviewOverlay(tui: TUI, props: PlanReviewOverlayProps): PlanReviewHandle {
	const controller = createPlanReviewController(props.planContent, props.options, props.callbacks);
	const disposer = mountOverlay(tui, () => (
		<Portal to="overlay" fullscreen anchor="bottom-center" mouseTracking>
			<PlanReviewOverlayView controller={controller} options={props.options} />
		</Portal>
	));
	return Object.assign(
		() => {
			controller.dispose();
			disposer.dispose();
		},
		controller,
		{
			hide(): void {
				controller.dispose();
				disposer.hide();
			},
			dispose(): void {
				controller.dispose();
				disposer.dispose();
			},
		},
	);
}
