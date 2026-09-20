import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { Show, createSignal, type JSX } from "../reactive";
import { createToolCallModel, type ToolCallModel } from "../tools/model";
import { UsageRow, turnElapsedMs } from "../overlays/usage-row";
import { AssistantMessageView } from "./assistant-message";
import { BashExecutionView } from "./bash-execution";
import { BranchSummaryView } from "./branch-summary";
import { CacheInvalidationMarkerView, detectCacheInvalidation } from "./cache-invalidation-marker";
import { CompactionSummaryMessageView } from "./compaction-summary-message";
import {
	CustomMessageDispatchView,
	HookMessageDispatchView,
	isCustomMessageToolActivity,
} from "./custom-message-dispatch";
import { chatTranscriptDisplayPreferences as displayPreferences } from "./display-preferences";
import { EvalExecutionView } from "./eval-execution";
import { FileMentionMessageView } from "./file-mention-message";
import {
	type CustomMessage,
	type HookMessage,
	isUserTurnInitiator,
	resolveAbortLabel,
	shouldRenderAbortReason,
} from "./messages";
import { ServedModelMarkerView, ServedModelTracker } from "./served-model-marker";
import {
	ReadToolGroupView,
	createReadToolGroupState,
	groupedReadUsageCallIds,
	readArgsCollapseIntoGroup,
	type ReadToolGroupState,
} from "./read-tool-group";
import { ToolBlock } from "./tool-block";
import { TranscriptView, createTranscriptStore, type TranscriptStore } from "./transcript-store";
import { textContent, type TranscriptEntryLike, transcriptEntryMessage } from "./transcript-entry";
import { createReactionTarget, type ReactionTarget } from "./reaction";
import { canonicalizeMessage } from "./thinking-display";
import { CollapsedSyntheticMessageView, UserMessageView } from "./user-message";

/** A declarative extension message body supplied by the session host. */
export type ChatTranscriptMessageView = (props: {
	readonly message: CustomMessage<unknown>;
	readonly expanded: boolean;
}) => JSX.Element | undefined;

export type ChatTranscriptHookMessageView = (props: {
	readonly message: HookMessage<unknown>;
	readonly expanded: boolean;
}) => JSX.Element | undefined;

/** Inputs needed to replay a persisted transcript with the current reactive views. */
export interface ChatTranscriptBuilderDeps {
	readonly getMessageView?: (customType: string) => ChatTranscriptMessageView | undefined;
	readonly getHookMessageView?: (customType: string) => ChatTranscriptHookMessageView | undefined;
	readonly hideThinkingBlock?: () => boolean;
	readonly proseOnlyThinking?: () => boolean;
	/** Disable shell prompt-zone markers in alternate-screen transcript overlays. */
	readonly promptZones?: boolean;
	/** Session-scoped resolved destinations for model-authored Markdown links. */
	readonly linkTargets?: ReadonlyMap<string, string>;
}

interface ReadToolGroup {
	entryId: string;
	readonly state: ReadToolGroupState;
	readonly showContentPreview: boolean;
}

interface PendingTool {
	readonly entryId: string;
	readonly model: ToolCallModel;
	readonly readGroup?: ReadToolGroup;
}

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

interface AssistantTimeline {
	readonly beforeTools: AssistantMessage;
	readonly afterToolCalls: ReadonlyMap<string, AssistantMessage>;
}

/**
 * Replays persisted entries into the reactive transcript store.
 *
 * Every source entry retains its rendered block identities, so incremental file
 * reads update only the outstanding tool models and deep links can target the
 * first rendered row belonging to the source entry.
 */
export class ChatTranscriptBuilder {
	readonly store: TranscriptStore = createTranscriptStore();
	readonly view = () => <TranscriptView store={this.store} />;
	readonly #pendingTools = new Map<string, PendingTool>();
	readonly #toolModels = new Set<ToolCallModel>();
	readonly #expanded = createSignal(false);
	#readGroup: ReadToolGroup | undefined;
	readonly #deps: ChatTranscriptBuilderDeps;
	readonly #entryBlocks = new Map<string, string[]>();
	#reactionTarget: ReactionTarget | undefined;
	#nextEntry = 0;
	#pendingUsage: Usage | undefined;
	#pendingUsageDuration: number | undefined;
	#pendingUsageTtft: number | undefined;
	#pendingUsageTimestamp: number | undefined;
	#pendingUsageElapsed: number | undefined;
	#pendingUsageSourceId: string | undefined;
	#pendingUsageReadToolIds: readonly string[] | undefined;
	#turnStartedAt: number | undefined;
	#lastAssistantUsage: Usage | undefined;
	#servedModelTracker = new ServedModelTracker();

	constructor(deps: ChatTranscriptBuilderDeps = {}) {
		this.#deps = deps;
		this.store.setToolActivityVisible(!displayPreferences.hideToolActivity);
	}

	#finalizeReadGroup(): void {
		this.#readGroup = undefined;
	}

	get isEmpty(): boolean {
		return this.store.entries().length === 0;
	}

	get expanded(): boolean {
		return this.#expanded[0]();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded[0]() === expanded) return;
		this.#expanded[1](expanded);
		for (const model of this.#toolModels) model.setUi({ expanded });
	}

	/** Discard prior replay state, then materialize the complete persisted sequence. */
	rebuild(entries: readonly TranscriptEntryLike[]): void {
		this.reset();
		this.append(entries);
	}

	/** Append newly persisted entries without remounting earlier transcript blocks. */
	append(entries: readonly TranscriptEntryLike[]): void {
		this.store.setToolActivityVisible(!displayPreferences.hideToolActivity);
		for (const entry of entries) this.#appendEntry(entry);
		if (this.#pendingTools.size === 0) this.#flushPendingUsage();
	}

	/** Rendered row where a persisted entry begins, after the transcript has painted. */
	rowForEntry(entryId: string): number | undefined {
		let start: number | undefined;
		for (const blockId of this.#entryBlocks.get(entryId) ?? []) {
			const row = this.store.rowForEntry(blockId);
			if (row !== undefined && (start === undefined || row < start)) start = row;
		}
		return start;
	}

	/** Tear down mutable replay state, sealing all pending activity through store removal. */
	reset(): void {
		this.store.clear();
		this.#pendingTools.clear();
		this.#toolModels.clear();
		this.#entryBlocks.clear();
		this.#readGroup = undefined;
		this.#reactionTarget = undefined;
		this.#nextEntry = 0;
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
		this.#pendingUsageTimestamp = undefined;
		this.#pendingUsageElapsed = undefined;
		this.#pendingUsageSourceId = undefined;
		this.#pendingUsageReadToolIds = undefined;
		this.#turnStartedAt = undefined;
		this.#lastAssistantUsage = undefined;
		this.#servedModelTracker = new ServedModelTracker();
	}

	dispose(): void {
		this.reset();
	}

	#appendEntry(entry: TranscriptEntryLike): void {
		const message = transcriptEntryMessage(entry);
		if (!message) return;
		this.#appendMessage(message, entry.id);
	}

	#appendMessage(message: AgentMessage, sourceId: string): void {
		if (message.role !== "toolResult") this.#flushPendingUsage();
		if (message.role !== "assistant" && message.role !== "toolResult") this.#finalizeReadGroup();

		switch (message.role) {
			case "assistant":
				this.#appendAssistant(message, sourceId);
				return;
			case "toolResult":
				this.#appendResult(message);
				return;
			case "user": {
				if (message.attribution !== "agent") this.#turnStartedAt = message.timestamp;
				const text = textContent(message.content);
				if (text.length === 0) return;
				if (message.synthetic) {
					this.#append(sourceId, () => (
						<CollapsedSyntheticMessageView
							text={text}
							expanded={this.#expanded[0]()}
							promptZones={this.#deps.promptZones}
						/>
					));
					return;
				}
				const reaction = createReactionTarget();
				this.#append(sourceId, () => (
					<UserMessageView text={text} reaction={reaction} options={{ promptZones: this.#deps.promptZones }} />
				));
				this.#reactionTarget = reaction;
				return;
			}
			case "developer":
				if (message.synthetic) this.#turnStartedAt = message.userInitiated ? message.timestamp : undefined;
				return;
			case "bashExecution":
				this.#append(sourceId, () => (
					<BashExecutionView
						command={message.command}
						output={message.output}
						exitCode={message.exitCode}
						cancelled={message.cancelled}
						expanded={this.#expanded[0]()}
						excludeFromContext={message.excludeFromContext}
						meta={message.meta}
						images={message.images}
						showImages={displayPreferences.showImages}
					/>
				));
				return;
			case "pythonExecution":
				this.#append(sourceId, () => (
					<EvalExecutionView
						language="python"
						code={message.code}
						output={message.output}
						exitCode={message.exitCode}
						cancelled={message.cancelled}
						expanded={this.#expanded[0]()}
						excludeFromContext={message.excludeFromContext}
						meta={message.meta}
					/>
				));
				return;
			case "compactionSummary":
				this.#append(sourceId, () => (
					<CompactionSummaryMessageView message={message} expanded={this.#expanded[0]()} />
				));
				return;
			case "branchSummary":
				this.#append(sourceId, () => <BranchSummaryView message={message} expanded={this.#expanded[0]()} />);
				return;
			case "fileMention":
				this.#append(sourceId, () => <FileMentionMessageView files={message.files} />);
				return;
			case "custom":
				if (isUserTurnInitiator(message)) this.#turnStartedAt = message.timestamp;
				this.#appendCustom(message, sourceId);
				return;
			case "hookMessage":
				this.#appendHook(message, sourceId);
				return;
			default:
				message satisfies never;
		}
	}

	#appendAssistant(message: AssistantMessage, sourceId: string): void {
		const timeline = splitAssistantTimeline(message);
		if (hasVisibleAssistantContent(message)) this.#finalizeReadGroup();
		const reactionTarget = this.#reactionTarget;
		this.#reactionTarget = undefined;
		this.#append(sourceId, () => (
			<AssistantMessageView
				message={timeline.beforeTools}
				reactionTarget={reactionTarget}
				expanded={this.#expanded[0]()}
				hideThinking={this.#deps.hideThinkingBlock?.()}
				proseOnlyThinking={this.#deps.proseOnlyThinking?.()}
				linkTargets={this.#deps.linkTargets}
				showImages={displayPreferences.showImages}
			/>
		));

		if (displayPreferences.cacheMissMarker) {
			const invalidation = detectCacheInvalidation(this.#lastAssistantUsage, message.usage);
			if (invalidation) this.#append(sourceId, () => <CacheInvalidationMarkerView info={invalidation} />);
		}
		if (hasBilledUsage(message.usage)) this.#lastAssistantUsage = message.usage;
		const servedModelMismatch = this.#servedModelTracker.check(message);
		if (servedModelMismatch) this.#append(sourceId, () => <ServedModelMarkerView info={servedModelMismatch} />);

		const toolError = terminalToolError(message);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			const model = createToolCallModel({ id: content.id, toolName: content.name, label: content.name });
			if (typeof content.arguments === "string" || isRecord(content.arguments))
				model.applyArgsChunk(content.arguments);
			model.markRunning();
			model.setUi({
				allocation: Number.MAX_SAFE_INTEGER,
				expanded: this.#expanded[0](),
				showImages: displayPreferences.showImages,
			});
			this.#toolModels.add(model);
			if (content.name === "read" && readArgsCollapseIntoGroup(content.arguments)) {
				const pending = this.#appendReadTool(sourceId, content.id, model, toolError !== undefined);
				if (toolError) model.applyResult({ content: [{ type: "text", text: toolError }], isError: true });
				else this.#pendingTools.set(content.id, pending);
			} else {
				this.#finalizeReadGroup();
				const entryId = this.#append(
					sourceId,
					() => (
						<Show when={this.store.toolActivityVisible()}>
							<ToolBlock model={model} />
						</Show>
					),
					toolError ? "settled" : "active",
				);
				if (toolError) model.applyResult({ content: [{ type: "text", text: toolError }], isError: true });
				else this.#pendingTools.set(content.id, { entryId, model });
			}

			const afterTool = timeline.afterToolCalls.get(content.id);
			if (afterTool) {
				this.#append(sourceId, () => (
					<AssistantMessageView
						message={afterTool}
						expanded={this.#expanded[0]()}
						hideThinking={this.#deps.hideThinkingBlock?.()}
						proseOnlyThinking={this.#deps.proseOnlyThinking?.()}
						linkTargets={this.#deps.linkTargets}
						showImages={displayPreferences.showImages}
					/>
				));
			}
		}

		this.#pendingUsage =
			displayPreferences.showTokenUsage && hasBilledUsage(message.usage) ? message.usage : undefined;
		this.#pendingUsageDuration = message.duration;
		this.#pendingUsageTtft = message.ttft;
		this.#pendingUsageTimestamp = message.timestamp;
		this.#pendingUsageElapsed = displayPreferences.showTurnTime
			? turnElapsedMs(this.#turnStartedAt, message)
			: undefined;
		this.#pendingUsageSourceId = this.#pendingUsage === undefined ? undefined : sourceId;
		this.#pendingUsageReadToolIds = this.#pendingUsage === undefined ? undefined : groupedReadUsageCallIds(message);
	}

	#appendResult(message: Extract<AgentMessage, { role: "toolResult" }>): void {
		const pending = this.#pendingTools.get(message.toolCallId);
		if (!pending) return;
		if (pending.readGroup && !this.store.canRemove(pending.entryId)) {
			this.#pendingTools.delete(message.toolCallId);
			return;
		}
		pending.model.applyResult(message);
		this.#pendingTools.delete(message.toolCallId);
		if (pending.readGroup) {
			if (pending.readGroup.state.settle(message.toolCallId) && this.store.canRemove(pending.entryId)) {
				this.store.replace(pending.entryId, { state: "settled" });
			}
			return;
		}
		this.store.replace(pending.entryId, { state: "settled" });
	}

	#appendReadTool(sourceId: string, toolCallId: string, model: ToolCallModel, settled: boolean): PendingTool {
		let group = this.#readGroup;
		if (!group || (group.entryId.length > 0 && !this.store.canRemove(group.entryId))) {
			group = {
				entryId: "",
				state: createReadToolGroupState(),
				showContentPreview: displayPreferences.readToolResultPreview,
			};
			this.#readGroup = group;
		}
		const readGroup = group;
		readGroup.state.add(toolCallId, model, !settled);
		if (readGroup.entryId.length === 0) {
			readGroup.entryId = this.#append(
				sourceId,
				() => (
					<Show when={this.store.toolActivityVisible()}>
						<ReadToolGroupView
							items={readGroup.state.items}
							expanded={this.#expanded[0]}
							showContentPreview={readGroup.showContentPreview}
						/>
					</Show>
				),
				readGroup.state.settled ? "settled" : "active",
			);
		} else {
			this.#associateBlock(sourceId, readGroup.entryId);
			this.store.replace(readGroup.entryId, { state: readGroup.state.settled ? "settled" : "active" });
		}
		return { entryId: readGroup.entryId, model, readGroup };
	}

	#appendCustom(message: CustomMessage<unknown>, sourceId: string): void {
		if (!message.display) return;
		this.#append(
			sourceId,
			() => (
				<CustomMessageDispatchView
					message={message}
					expanded={() => this.#expanded[0]()}
					toolActivityVisible={this.store.toolActivityVisible}
					getMessageView={this.#deps.getMessageView}
				/>
			),
			"settled",
			isCustomMessageToolActivity(message),
		);
	}

	#appendHook(message: HookMessage<unknown>, sourceId: string): void {
		if (!message.display) return;
		this.#append(sourceId, () => (
			<HookMessageDispatchView
				message={message}
				expanded={() => this.#expanded[0]()}
				getHookMessageView={this.#deps.getHookMessageView}
			/>
		));
	}

	#flushPendingUsage(): void {
		const usage = this.#pendingUsage;
		const sourceId = this.#pendingUsageSourceId;
		if (!usage || sourceId === undefined) {
			this.#pendingUsageReadToolIds = undefined;
			return;
		}
		const readGroup = this.#readGroup;
		const readToolIds = this.#pendingUsageReadToolIds;
		const attachToReadGroup =
			readGroup !== undefined &&
			readToolIds !== undefined &&
			readToolIds.length > 0 &&
			this.store.canRemove(readGroup.entryId) &&
			readToolIds.every(id => readGroup.state.toolCallIds.has(id));
		if (attachToReadGroup) {
			readGroup.state.addUsage({
				kind: "usage",
				usage,
				...(this.#pendingUsageDuration === undefined ? {} : { durationMs: this.#pendingUsageDuration }),
				...(this.#pendingUsageTtft === undefined ? {} : { ttftMs: this.#pendingUsageTtft }),
				...(this.#pendingUsageTimestamp === undefined ? {} : { timestamp: this.#pendingUsageTimestamp }),
				...(this.#pendingUsageElapsed === undefined ? {} : { turnElapsed: this.#pendingUsageElapsed }),
			});
		} else {
			this.#append(sourceId, () => (
				<UsageRow
					usage={usage}
					durationMs={this.#pendingUsageDuration}
					ttftMs={this.#pendingUsageTtft}
					timestamp={this.#pendingUsageTimestamp}
					turnElapsed={this.#pendingUsageElapsed}
				/>
			));
		}
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
		this.#pendingUsageTimestamp = undefined;
		this.#pendingUsageElapsed = undefined;
		this.#pendingUsageSourceId = undefined;
		this.#pendingUsageReadToolIds = undefined;
	}

	#append(
		sourceId: string,
		view: () => JSX.Element,
		state: "active" | "settled" = "settled",
		toolActivity = false,
	): string {
		const id = `${sourceId}:${this.#nextEntry++}`;
		this.store.append({ id, view, state, toolActivity });
		this.#associateBlock(sourceId, id);
		return id;
	}

	#associateBlock(sourceId: string, blockId: string): void {
		const blocks = this.#entryBlocks.get(sourceId);
		if (blocks?.includes(blockId)) return;
		if (blocks) blocks.push(blockId);
		else this.#entryBlocks.set(sourceId, [blockId]);
	}
}

function hasBilledUsage(usage: Usage): boolean {
	return (
		usage.input > 0 ||
		usage.output > 0 ||
		usage.cacheRead > 0 ||
		usage.cacheWrite > 0 ||
		(usage.premiumRequests ?? 0) > 0
	);
}

function hasVisibleAssistantContent(message: AssistantMessage): boolean {
	return message.content.some(
		content =>
			content.type === "image" ||
			(content.type === "text" && canonicalizeMessage(content.text)) ||
			(content.type === "thinking" && canonicalizeMessage(content.thinking)),
	);
}

function displayAssistantSegment(message: AssistantMessage, content: AssistantMessage["content"]): AssistantMessage {
	return {
		...message,
		content,
		stopReason: "stop",
		errorMessage: undefined,
		retryRecovery: undefined,
	};
}

function splitAssistantTimeline(message: AssistantMessage): AssistantTimeline {
	const before: AssistantMessage["content"] = [];
	const afterToolCalls = new Map<string, AssistantMessage>();
	let pendingAfterTool: AssistantMessage["content"] = [];
	let lastToolCallId: string | undefined;
	let sawToolCall = false;

	const flushAfterTool = (): void => {
		if (!lastToolCallId || pendingAfterTool.length === 0) return;
		const segment = displayAssistantSegment(message, pendingAfterTool);
		if (hasVisibleAssistantContent(segment)) afterToolCalls.set(lastToolCallId, segment);
		pendingAfterTool = [];
	};

	for (const content of message.content) {
		if (content.type === "toolCall") {
			flushAfterTool();
			sawToolCall = true;
			lastToolCallId = content.id;
			continue;
		}
		if (sawToolCall) pendingAfterTool.push(content);
		else before.push(content);
	}
	flushAfterTool();

	return {
		beforeTools: sawToolCall ? displayAssistantSegment(message, before) : message,
		afterToolCalls,
	};
}

function terminalToolError(message: AssistantMessage): string | undefined {
	if (message.retryRecovery?.status === "superseded" || message.retryRecovery?.status === "recovered")
		return undefined;
	if (message.stopReason === "aborted")
		return shouldRenderAbortReason(message) ? resolveAbortLabel(message) : undefined;
	if (message.stopReason === "error") return message.errorMessage || "Error";
	return message.errorMessage && shouldRenderAbortReason(message) ? message.errorMessage : undefined;
}
