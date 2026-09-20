import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { createImagePaintState } from "../components/image";
import type { MarkdownOptions } from "../components/markdown-engine";
import { documentFromSnapshots, type SnapshotDocument } from "../document/snapshots";
import type { TextDocument } from "../document/types";
import type { StableTranscriptRow } from "../host/intrinsics";
import { expandKeyHint } from "../render/render-utils";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	Index,
	Show,
	useClock,
	type Accessor,
	type JSX,
} from "../reactive";
import { useTheme } from "../theme/reactive";
import type { AssistantThinkingRenderer } from "./extension-types";
import { resolveAbortLabel, shouldRenderAbortReason } from "./messages";
import { type ReactionSplit, type ReactionTarget, splitReaction } from "./reaction";
import { canonicalizeMessage, formatThinkingForDisplay, hasDisplayableThinking } from "./thinking-display";

const MAX_TRANSCRIPT_ERROR_ROWS = 8;
const THINKING_MARKDOWN_OPTIONS: MarkdownOptions = { defaultTextStyle: { italic: true } };
const THINKING_DOTS_FRAMES = ["✻", "✼", "❉", "❊", "✺", "✹", "✸", "✶"] as const;
const THINKING_DOTS_FRAME_MS_MIN = 70;
const THINKING_DOTS_FRAME_MS_MAX = 230;
const SPEED_WINDOW_MS = 3000;
const SPEED_MAX = 200;

export type AssistantMessageSource = AssistantMessage | Accessor<AssistantMessage>;
export type AssistantTransientSource = boolean | Accessor<boolean>;
export type AssistantBooleanSource = boolean | Accessor<boolean>;

function sourceValue(source: AssistantBooleanSource | undefined, fallback = false): boolean {
	return typeof source === "function" ? source() : (source ?? fallback);
}

export interface AssistantMessageViewProps {
	/** A signal source keeps one retained view current across streaming snapshots. */
	readonly message: AssistantMessageSource;
	readonly transient?: AssistantTransientSource;
	readonly reactionTarget?: ReactionTarget;
	readonly expanded: AssistantBooleanSource;
	readonly hideThinking?: AssistantBooleanSource;
	/** Fold reasoning code blocks into prose summaries; defaults to true. */
	readonly proseOnlyThinking?: AssistantBooleanSource;
	/** Resolved OSC 8 destinations for model-authored prose links. */
	readonly linkTargets?: ReadonlyMap<string, string>;
	readonly thinkingRenderers?: readonly AssistantThinkingRenderer[];
	/** The same provider error is shown in the pinned banner while collapsed. */
	readonly errorPinned?: AssistantBooleanSource;
	readonly showImages?: AssistantBooleanSource;
	/** Receives append-only, immutable Markdown-prefix publications while streaming. */
	readonly onStableRows?: (rows: readonly StableTranscriptRow[]) => void;
}

type ThinkingContentBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;

export interface FullAssistantErrorPresentation {
	readonly kind: "full";
	readonly text: string;
	readonly aborted: boolean;
}

export interface RecoveredAssistantErrorPresentation {
	readonly kind: "compact-recovered";
	readonly text: string;
}

export type AssistantErrorPresentation =
	| { readonly kind: "none" }
	| FullAssistantErrorPresentation
	| RecoveredAssistantErrorPresentation;

interface ProseBlock {
	readonly id: string;
	readonly kind: "text" | "thinking" | "image";
	readonly sourceText?: string;
	readonly document?: TextDocument;
	readonly image?: ImageContent;
	readonly contentIndex?: number;
	readonly thinkingIndex?: number;
	readonly thinkingText?: string;
	readonly leadingGap: boolean;
	readonly trailingGap: boolean;
}

interface ProseBlocks {
	readonly blocks: readonly ProseBlock[];
	readonly hasVisibleContent: boolean;
}

type StablePart = { readonly kind: "text" | "thinking"; readonly text: string } | { readonly kind: "spacer" };

interface StableSnapshot {
	readonly partCount: number;
	readonly lastTextLength: number;
}

interface StablePublication {
	setCandidate(
		candidate: (stableText: (blockId: string) => string | undefined) => readonly StablePart[] | undefined,
	): void;
	onStableText(blockId: string, text: string): void;
	stableView(count: Accessor<number>): JSX.Element;
	reset(): void;
}

class ThinkingSpeedTracker {
	#observations: Array<{ time: number; rate: number }> = [];

	observe(rate: number, now: number): void {
		if (!Number.isFinite(rate) || rate < 0) return;
		this.#observations.push({ time: now, rate: Math.min(rate, SPEED_MAX) });
		this.#prune(now);
	}

	getSpeed(now: number): number {
		this.#prune(now);
		if (this.#observations.length === 0) return 0;
		let sum = 0;
		for (const observation of this.#observations) sum += observation.rate;
		return sum / this.#observations.length;
	}

	reset(): void {
		this.#observations = [];
	}

	#prune(now: number): void {
		const threshold = now - SPEED_WINDOW_MS;
		while (this.#observations.length > 0 && this.#observations[0]!.time < threshold) {
			this.#observations.shift();
		}
	}
}

const sharedSpeedTracker = new ThinkingSpeedTracker();

/** Test-only reset so a previous streaming turn cannot influence the next fixture. */
export function resetThinkingSpeedTracker(): void {
	sharedSpeedTracker.reset();
}

function openingText(
	message: AssistantMessage,
): { index: number; block: TextContent; split: ReactionSplit } | undefined {
	const index = message.content.findIndex(content => content.type === "text" && content.text.length > 0);
	const block = message.content[index];
	return block?.type === "text" ? { index, block, split: splitReaction(block.text) } : undefined;
}

/**
 * Display form of one assistant snapshot: lift a resolved opening reaction to
 * its preceding target and suppress a prefix that is still an incomplete emoji.
 */
function displayMessage(
	message: AssistantMessage,
	target: ReactionTarget | undefined,
	transient: boolean,
): AssistantMessage {
	const opening = openingText(message);
	if (!opening) return message;
	const { index, block, split } = opening;
	let text: string;
	if (split.emoji !== undefined) {
		if (!target) return message;
		target.setReaction(split.emoji);
		text = split.body;
	} else if (split.pending && transient) {
		text = "";
	} else {
		return message;
	}
	const content = message.content.slice();
	content[index] = { ...block, text };
	return { ...message, content };
}

function documentFor(documents: Map<string, SnapshotDocument>, id: string, text: string): TextDocument {
	let snapshot = documents.get(id);
	if (!snapshot) {
		snapshot = documentFromSnapshots();
		documents.set(id, snapshot);
	}
	snapshot.push(text);
	return snapshot.doc;
}

function rawThinking(block: ThinkingContentBlock): string | undefined {
	return "rawThinking" in block && typeof block.rawThinking === "string" ? block.rawThinking : undefined;
}

function thinkingDisplay(block: ThinkingContentBlock, proseOnly: boolean): { text: string; visible: boolean } {
	const raw = rawThinking(block);
	const formatted = raw === undefined ? formatThinkingForDisplay(block.thinking, proseOnly) : block.thinking;
	return {
		text: formatted.trim(),
		visible: hasDisplayableThinking(raw ?? block.thinking, formatted),
	};
}

function isVisibleContent(
	content: AssistantMessage["content"][number],
	hideThinking: boolean,
	proseOnly: boolean,
): boolean {
	if (content.type === "text") return Boolean(canonicalizeMessage(content.text));
	if (content.type === "image") return Boolean(content.data && content.mimeType);
	return content.type === "thinking" && !hideThinking && thinkingDisplay(content, proseOnly).visible;
}

function proseBlocks(
	message: AssistantMessage,
	hideThinking: boolean,
	proseOnly: boolean,
	showImages: boolean,
	documents: Map<string, SnapshotDocument>,
): ProseBlocks {
	const blocks: ProseBlock[] = [];
	let hasRenderedContent = false;
	let thinkingIndex = 0;
	const hasVisibleContent = message.content.some(content => isVisibleContent(content, hideThinking, proseOnly));

	for (let index = 0; index < message.content.length; index++) {
		const content = message.content[index]!;
		if (content.type === "text" && canonicalizeMessage(content.text)) {
			blocks.push({
				id: `text:${index}`,
				kind: "text",
				sourceText: content.text.trim(),
				document: documentFor(documents, `text:${index}`, content.text.trim()),
				contentIndex: index,
				leadingGap: false,
				trailingGap: false,
			});
			hasRenderedContent = true;
			continue;
		}
		if (content.type === "thinking") {
			if (hideThinking) {
				thinkingIndex += 1;
				continue;
			}
			const display = thinkingDisplay(content, proseOnly);
			if (!display.visible) continue;
			const trailingGap = message.content
				.slice(index + 1)
				.some(item => isVisibleContent(item, hideThinking, proseOnly));
			blocks.push({
				id: `thinking:${index}`,
				kind: "thinking",
				sourceText: display.text,
				document: documentFor(documents, `thinking:${index}`, display.text),
				contentIndex: index,
				thinkingIndex,
				thinkingText: display.text,
				leadingGap: false,
				trailingGap,
			});
			hasRenderedContent = true;
			thinkingIndex += 1;
			continue;
		}
		if (content.type === "image" && content.data && content.mimeType && showImages) {
			blocks.push({
				id: `image:${index}`,
				kind: "image",
				image: content,
				leadingGap: hasRenderedContent,
				trailingGap: false,
			});
			hasRenderedContent = true;
		}
	}
	return { blocks, hasVisibleContent };
}

function shouldAnimateThinking(message: AssistantMessage, hidden: boolean, transient: boolean): boolean {
	if (!hidden || !transient) return false;
	let tail: "text" | "thinking" | undefined;
	for (const content of message.content) {
		if (content.type === "toolCall") return false;
		if (content.type === "text" && canonicalizeMessage(content.text)) tail = "text";
		else if (content.type === "thinking" && canonicalizeMessage(content.thinking)) tail = "thinking";
	}
	return tail === "thinking";
}

function thinkingFrame(at: number, startedAt: number): number {
	let elapsed = Math.max(0, at - startedAt);
	let period = 0;
	for (let index = 0; index < THINKING_DOTS_FRAMES.length; index++) {
		const phase = (1 - Math.cos((2 * Math.PI * index) / THINKING_DOTS_FRAMES.length)) / 2;
		period += THINKING_DOTS_FRAME_MS_MIN + (THINKING_DOTS_FRAME_MS_MAX - THINKING_DOTS_FRAME_MS_MIN) * phase;
	}
	elapsed %= period;
	for (let index = 0; index < THINKING_DOTS_FRAMES.length; index++) {
		const phase = (1 - Math.cos((2 * Math.PI * index) / THINKING_DOTS_FRAMES.length)) / 2;
		elapsed -= THINKING_DOTS_FRAME_MS_MIN + (THINKING_DOTS_FRAME_MS_MAX - THINKING_DOTS_FRAME_MS_MIN) * phase;
		if (elapsed < 0) return index;
	}
	return 0;
}

function ThinkingPulse(props: { readonly message: Accessor<AssistantMessage> }): JSX.Element {
	const tick = useClock("frame");
	const startedAt = tick();
	const [tokens, setTokens] = createSignal(0);
	const [rateLive, setRateLive] = createSignal(false);
	let lastTokenCount: number | undefined;
	let lastTokenTime = 0;

	createEffect(() => {
		const usage = props.message().usage;
		const currentTokens = usage?.reasoningTokens ?? usage?.output ?? 0;
		const now = performance.now();
		if (lastTokenCount !== undefined) {
			const delta = currentTokens - lastTokenCount;
			const elapsed = now - lastTokenTime;
			if (delta > 0 && elapsed > 0) {
				if (!rateLive()) sharedSpeedTracker.reset();
				sharedSpeedTracker.observe((delta / elapsed) * 1000, now);
				setRateLive(true);
			}
		}
		lastTokenCount = currentTokens;
		lastTokenTime = now;
		setTokens(currentTokens);
	});

	const rate = () => {
		tick();
		return Math.min(SPEED_MAX, sharedSpeedTracker.getSpeed(performance.now()));
	};
	const speedVisible = () => rateLive() && rate() >= 0.05;
	const glyph = () => THINKING_DOTS_FRAMES[thinkingFrame(tick(), startedAt)] ?? "…";

	return (
		<row gap={0}>
			<text color="thinkingText">{glyph()}</text>
			<text color="muted"> Thinking</text>
			<Show when={speedVisible()}>
				<Show when={tokens() > 0}>{() => <text color="dim">{` · ${formatNumber(tokens())}`}</text>}</Show>
				<text color="accent">{` · ${rate().toFixed(1)} toks/s`}</text>
			</Show>
		</row>
	);
}

function ThinkingExtensions(props: {
	readonly renderers: readonly AssistantThinkingRenderer[];
	readonly contentIndex: number;
	readonly thinkingIndex: number;
	readonly text: string;
}): JSX.Element {
	return (
		<For each={props.renderers}>
			{renderer => {
				try {
					return renderer({
						contentIndex: props.contentIndex,
						thinkingIndex: props.thinkingIndex,
						text: props.text,
					});
				} catch {
					return null;
				}
			}}
		</For>
	);
}

/** Shared rendering semantics for terminal assistant completion state. */
export function resolveAssistantErrorPresentation(message: AssistantMessage): AssistantErrorPresentation {
	if (message.retryRecovery?.status === "superseded") return { kind: "none" };
	if (message.retryRecovery?.status === "recovered") {
		const note = message.retryRecovery.note.replace(/\t/g, " ").replace(/\s+/g, " ").trim();
		return { kind: "compact-recovered", text: note.length > 80 ? `${note.slice(0, 79)}…` : note || "retried" };
	}
	if (message.stopReason === "aborted") {
		return shouldRenderAbortReason(message)
			? { kind: "full", text: resolveAbortLabel(message), aborted: true }
			: { kind: "none" };
	}
	if (message.stopReason === "error") return { kind: "full", text: message.errorMessage || "Error", aborted: false };
	return message.errorMessage && shouldRenderAbortReason(message)
		? { kind: "full", text: message.errorMessage, aborted: false }
		: { kind: "none" };
}

function errorDocumentText(message: string): string {
	const lines = message
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, " ")
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
	return lines.length > 0 ? lines.join("\n") : "Unknown error";
}

/** True when a completion has billable provider usage worth surfacing. */
export function assistantUsageIsBilled(usage: AssistantMessage["usage"] | undefined): boolean {
	return (
		usage !== undefined &&
		(usage.input > 0 ||
			usage.output > 0 ||
			usage.cacheRead > 0 ||
			usage.cacheWrite > 0 ||
			(usage.premiumRequests ?? 0) > 0)
	);
}

function stablePartsExtend(previous: readonly StablePart[], next: readonly StablePart[]): boolean {
	if (previous.length > next.length) return false;
	for (let index = 0; index < previous.length; index++) {
		const before = previous[index]!;
		const after = next[index]!;
		if (before.kind !== after.kind) return false;
		if (before.kind !== "spacer" && after.kind !== "spacer") {
			const last = index === previous.length - 1;
			if (last ? !after.text.startsWith(before.text) : after.text !== before.text) return false;
		}
	}
	return true;
}

function sameStableParts(left: readonly StablePart[], right: readonly StablePart[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		const before = left[index]!;
		const after = right[index]!;
		if (before.kind !== after.kind) return false;
		if (before.kind !== "spacer" && after.kind !== "spacer" && before.text !== after.text) return false;
	}
	return true;
}

function stablePartsAt(parts: readonly StablePart[], snapshot: StableSnapshot | undefined): readonly StablePart[] {
	if (!snapshot) return [];
	const selected = parts.slice(0, snapshot.partCount);
	const last = selected.at(-1);
	if (last && last.kind !== "spacer") {
		selected[selected.length - 1] = { kind: last.kind, text: last.text.slice(0, snapshot.lastTextLength) };
	}
	return selected;
}

function StableAssistantPrefix(props: {
	readonly count: Accessor<number>;
	readonly snapshots: Accessor<readonly StableSnapshot[]>;
	readonly stableParts: Accessor<readonly StablePart[]>;
	readonly linkTargets: ReadonlyMap<string, string> | undefined;
}): JSX.Element {
	const documents = new Map<string, SnapshotDocument>();
	const parts = createMemo(() => {
		const snapshots = props.snapshots();
		const count = Math.max(0, Math.trunc(props.count()));
		return stablePartsAt(props.stableParts(), snapshots[Math.min(count, snapshots.length) - 1]);
	});
	const proseOptions =
		props.linkTargets && props.linkTargets.size > 0
			? { resolveLink: (href: string) => props.linkTargets?.get(href) }
			: undefined;
	return (
		<stack>
			<For each={parts()}>
				{(part, index) =>
					part.kind === "spacer" ? (
						<br />
					) : (
						<rail
							prefix={part.kind === "thinking" ? " " : ""}
							color={part.kind === "thinking" ? "thinkingText" : "text"}
						>
							<markdown
								document={documentFor(documents, `${index()}:${part.kind}`, part.text)}
								options={part.kind === "thinking" ? THINKING_MARKDOWN_OPTIONS : proseOptions}
							/>
						</rail>
					)
				}
			</For>
		</stack>
	);
}

function stablePartsFor(
	message: AssistantMessage,
	blocks: ProseBlocks,
	transient: boolean,
	hideThinking: boolean,
	thinkingRenderers: readonly AssistantThinkingRenderer[],
	stableText: (blockId: string) => string | undefined,
): readonly StablePart[] | undefined {
	if (!transient) return undefined;
	const byContentIndex = new Map<number, ProseBlock>();
	for (const block of blocks.blocks) {
		if (block.contentIndex !== undefined) byContentIndex.set(block.contentIndex, block);
	}
	const tail = blocks.blocks.at(-1);
	const liveBlockId = tail?.kind === "image" ? undefined : tail?.id;
	const parts: StablePart[] = [];
	const finish = (): readonly StablePart[] | undefined => {
		while (parts.at(-1)?.kind === "spacer") parts.pop();
		return parts.length > 0 ? parts : undefined;
	};
	for (const [contentIndex, content] of message.content.entries()) {
		if (content.type === "image" || content.type === "toolCall") return finish();
		if (content.type === "thinking" && hideThinking) return finish();
		if (content.type !== "text" && content.type !== "thinking") continue;
		const block = byContentIndex.get(contentIndex);
		if (!block || block.kind === "image" || !block.sourceText) return finish();
		if (block.id === liveBlockId) {
			const frozen = stableText(block.id) ?? "";
			if (!block.sourceText.startsWith(frozen) || !/\S/.test(block.sourceText.slice(frozen.length))) return finish();
			const text = frozen.trim();
			if (text.length > 0) parts.push({ kind: block.kind, text });
			return finish();
		}
		parts.push({ kind: block.kind, text: block.sourceText });
		if (block.trailingGap) parts.push({ kind: "spacer" });
		if (block.kind === "thinking" && thinkingRenderers.length > 0) return finish();
	}
	return finish();
}

function createStablePublication(
	onStableRows: ((rows: readonly StableTranscriptRow[]) => void) | undefined,
	linkTargets: ReadonlyMap<string, string> | undefined,
): StablePublication {
	const [snapshots, setSnapshots] = createSignal<readonly StableSnapshot[]>([]);
	const [stableParts, setStableParts] = createSignal<readonly StablePart[]>([]);
	const stableTexts = new Map<string, string>();
	let candidate:
		| ((stableText: (blockId: string) => string | undefined) => readonly StablePart[] | undefined)
		| undefined;
	let nextRowId = 0;
	return {
		setCandidate(next) {
			candidate = next;
		},
		onStableText(blockId, text) {
			if (stableTexts.get(blockId) === text) return;
			stableTexts.set(blockId, text);
			const next = candidate?.(block => stableTexts.get(block));
			if (!next || next.length === 0) return;
			const previous = stablePartsAt(stableParts(), snapshots().at(-1));
			if ((previous.length > 0 && !stablePartsExtend(previous, next)) || sameStableParts(previous, next)) return;
			const last = next.at(-1);
			if (!last || last.kind === "spacer") return;
			const nextSnapshots = [...snapshots(), { partCount: next.length, lastTextLength: last.text.length }];
			setStableParts(next);
			setSnapshots(nextSnapshots);
			onStableRows?.(nextSnapshots.map((_, index) => ({ key: `assistant:${index + nextRowId}` })));
		},
		stableView(count) {
			return StableAssistantPrefix({ count, snapshots, stableParts, linkTargets });
		},
		reset() {
			stableTexts.clear();
			nextRowId += snapshots().length;
			setStableParts([]);
			setSnapshots([]);
			onStableRows?.([]);
		},
	};
}

/**
 * Streaming assistant presentation with a declarative immutable-prefix slot.
 * The caller mounts `view` in the mutable transcript body and `stableView` in
 * the transcript's native retained stable slot.
 */
export interface StreamingAssistantMessageView {
	readonly view: () => JSX.Element;
	readonly stableView: (count: Accessor<number>) => JSX.Element;
	readonly onResetStableRows: () => void;
}

/** Prepare streaming state outside the TUI; mount both view factories beneath its owner. */
export function createStreamingAssistantMessageView(props: AssistantMessageViewProps): StreamingAssistantMessageView {
	const publication = createStablePublication(props.onStableRows, props.linkTargets);
	return {
		view: () => AssistantMessageView({ ...props, publication }),
		stableView: publication.stableView,
		onResetStableRows: publication.reset,
	};
}

/** Provider response prose. Tool calls are rendered by adjacent ToolBlock entries. */
export function AssistantMessageView(
	props: AssistantMessageViewProps & { readonly publication?: StablePublication },
): JSX.Element {
	const { theme } = useTheme();
	const message = () => (typeof props.message === "function" ? props.message() : props.message);
	const transient = () => (typeof props.transient === "function" ? props.transient() : (props.transient ?? false));
	const documents = new Map<string, SnapshotDocument>();
	const display = createMemo(() => displayMessage(message(), props.reactionTarget, transient()));
	const proseOnlyThinking = () => sourceValue(props.proseOnlyThinking, true);
	const showImages = () => sourceValue(props.showImages, true);
	const hideThinking = () => sourceValue(props.hideThinking);
	const blockState = createMemo(() =>
		proseBlocks(display(), hideThinking(), proseOnlyThinking(), showImages(), documents),
	);
	const liveProseBlock = createMemo(() => {
		const block = blockState().blocks.at(-1);
		return block?.kind === "image" ? undefined : block;
	});
	props.publication?.setCandidate(stableText =>
		stablePartsFor(display(), blockState(), transient(), hideThinking(), props.thinkingRenderers ?? [], stableText),
	);
	const error = createMemo(() => resolveAssistantErrorPresentation(message()));
	const errorDocument = createMemo(() => {
		const presentation = error();
		return presentation.kind === "full"
			? documentFor(documents, "error", errorDocumentText(presentation.text))
			: undefined;
	});
	const proseOptions = createMemo(() => {
		const targets = props.linkTargets;
		return targets && targets.size > 0 ? { resolveLink: (href: string) => targets.get(href) } : undefined;
	});
	const pulseVisible = () => shouldAnimateThinking(display(), hideThinking(), transient());
	const hasToolCalls = () => display().content.some(content => content.type === "toolCall");
	const recoveredError = createMemo((): RecoveredAssistantErrorPresentation | undefined => {
		const presentation = error();
		return !hasToolCalls() && presentation.kind === "compact-recovered" ? presentation : undefined;
	});
	const abortedError = createMemo((): FullAssistantErrorPresentation | undefined => {
		const presentation = error();
		return !hasToolCalls() && presentation.kind === "full" && presentation.aborted ? presentation : undefined;
	});
	const providerError = createMemo((): FullAssistantErrorPresentation | undefined => {
		const presentation = error();
		return !hasToolCalls() &&
			presentation.kind === "full" &&
			!presentation.aborted &&
			(!sourceValue(props.errorPinned) || sourceValue(props.expanded))
			? presentation
			: undefined;
	});

	return (
		<stack>
			<Index each={blockState().blocks}>
				{block => (
					<>
						<Show when={block().leadingGap}>
							<br />
						</Show>
						<Show
							when={block().kind !== "image"}
							fallback={
								block().image ? (
									<image
										state={createImagePaintState({
											base64Data: block().image!.data,
											mimeType: block().image!.mimeType,
											theme: { fallbackStyle: theme().style("toolOutput") },
											options: { imageKey: `assistant:${block().id}` },
										})}
									/>
								) : null
							}
						>
							<rail
								prefix={block().kind === "thinking" ? " " : ""}
								color={block().kind === "thinking" ? "thinkingText" : "text"}
							>
								<markdown
									document={block().document!}
									transient={transient() && liveProseBlock()?.id === block().id}
									onStableText={text => props.publication?.onStableText(block().id, text)}
									options={block().kind === "thinking" ? THINKING_MARKDOWN_OPTIONS : proseOptions()}
								/>
							</rail>
							<Show when={block().kind === "thinking" && block().thinkingIndex !== undefined}>
								<ThinkingExtensions
									renderers={props.thinkingRenderers ?? []}
									contentIndex={block().contentIndex!}
									thinkingIndex={block().thinkingIndex!}
									text={block().thinkingText!}
								/>
							</Show>
						</Show>
						<Show when={block().trailingGap}>
							<br />
						</Show>
					</>
				)}
			</Index>
			<Show when={pulseVisible()}>
				<Show when={blockState().hasVisibleContent}>
					<br />
				</Show>
				<ThinkingPulse message={message} />
			</Show>
			<Show when={recoveredError()}>
				{(presentation: Accessor<RecoveredAssistantErrorPresentation>) => (
					<>
						<br />
						<text color="dim">{presentation().text}</text>
					</>
				)}
			</Show>
			<Show when={abortedError()}>
				{(presentation: Accessor<FullAssistantErrorPresentation>) => (
					<>
						<br />
						<text color="error">{presentation().text}</text>
					</>
				)}
			</Show>
			<Show when={providerError()}>
				<br />
				<rail prefix="Error: " rest="  " color="error">
					<Show when={errorDocument()}>
						{(document: Accessor<TextDocument>) => (
							<preview
								document={document()}
								edge="head"
								limit={sourceValue(props.expanded) ? Number.MAX_SAFE_INTEGER : MAX_TRANSCRIPT_ERROR_ROWS}
								unit="rows"
								hiddenLabel={hidden =>
									`… +${hidden} more line${hidden === 1 ? "" : "s"} (${expandKeyHint()} to expand)`
								}
							/>
						)}
					</Show>
				</rail>
			</Show>
		</stack>
	);
}
