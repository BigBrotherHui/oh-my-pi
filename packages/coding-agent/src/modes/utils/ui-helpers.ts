/** Reactive transcript and prompt-adjacent presentation helpers. */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { AssistantMessageView, assistantUsageIsBilled } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { BashExecutionView } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { CacheInvalidationMarkerView, detectCacheInvalidation } from "@oh-my-pi/pi-tui/chat/cache-invalidation-marker";
import { createReactionTarget, type ReactionTarget } from "@oh-my-pi/pi-tui/chat/reaction";
import { BranchSummaryView } from "@oh-my-pi/pi-tui/chat/branch-summary";
import { CompactionSummaryMessageView } from "@oh-my-pi/pi-tui/chat/compaction-summary-message";
import {
	CustomMessageDispatchView,
	HookMessageDispatchView,
	isCustomMessageToolActivity,
} from "@oh-my-pi/pi-tui/chat/custom-message-dispatch";
import { EvalExecutionView } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { FileMentionMessageView } from "@oh-my-pi/pi-tui/chat/file-mention-message";
import { UserMessageView } from "@oh-my-pi/pi-tui/chat/user-message";
import {
	ReadToolGroupSummary,
	ReadToolGroupView,
	createReadToolGroupState,
	groupedReadUsageCallIds,
	readArgsCollapseIntoGroup,
	type ReadToolGroupState,
} from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ServedModelMarkerView, ServedModelTracker } from "@oh-my-pi/pi-tui/chat/served-model-marker";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import type { TranscriptEntryInput } from "@oh-my-pi/pi-tui/chat/transcript-store";
import { materializeImageReferenceLinksSync } from "@oh-my-pi/pi-tui/prompt/image-references";
import { videoPreviewSource } from "@oh-my-pi/pi-tui/prompt/video";
import { ToolBlock, ToolBlockSummary } from "@oh-my-pi/pi-tui/chat/tool-block";
import { createToolViewSource } from "../tool-view-source";
import { turnElapsedMs, UsageRow } from "@oh-my-pi/pi-tui/overlays/usage-row";
import {
	getAssistantMessageLinkTargets,
	refreshAssistantMessageLinkTargets,
} from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";
import { NoticeView, PendingMessagesView, UpdateAvailableView } from "../reactive-message-views";
import { type JSX } from "@oh-my-pi/pi-tui/reactive";
import { createToolCallModel, type ToolCallModel } from "@oh-my-pi/pi-tui/tools/model";
import type { InteractiveModeContext } from "../../modes/types";
import type { SessionContext } from "../../session/session-context";
import { buildSkillCommandPrompt, invokeSkillCommandFromText, isKnownSkillCommand } from "../skill-command";
import { assistantHasVisibleContent, splitAssistantMessageToolTimeline } from "./assistant-timeline";

interface RenderInitialMessagesOptions {
	readonly preserveExistingChat?: boolean;
	readonly clearTerminalHistory?: boolean;
}

interface AddMessageOptions {
	readonly imageLinks?: readonly (string | undefined)[];
}

interface ReplayReadGroup {
	readonly entryId: string;
	readonly state: ReadToolGroupState;
	allocation: number;
}

interface PendingToolEntry {
	readonly entryId: string;
	readonly model: ToolCallModel;
	readonly readGroup?: ReplayReadGroup;
}

interface PendingUsage {
	readonly usage: Usage;
	readonly durationMs: number | undefined;
	readonly ttftMs: number | undefined;
	readonly timestamp: number | undefined;
	readonly turnElapsed: number | undefined;
	readonly remainingToolCallIds: Set<string>;
	readonly readGroup: ReplayReadGroup | undefined;
}

function transcriptMessageKey(message: AgentMessage): string {
	if (message.role === "toolResult") return `${message.role}\u0000${message.timestamp}\u0000${message.toolCallId}`;
	return `${message.role}\u0000${message.timestamp}`;
}

function resultAsyncStateIsRunning(message: Extract<AgentMessage, { role: "toolResult" }>): boolean {
	const details = message.details;
	if (typeof details !== "object" || details === null || Array.isArray(details) || !("async" in details)) return false;
	const async = details.async;
	return typeof async === "object" && async !== null && "state" in async && async.state === "running";
}

function imageLinksForMessage(
	message: Extract<AgentMessage, { role: "user" }>,
	putBlobSync: InteractiveModeContext["sessionManager"]["putBlobSync"],
): readonly (string | undefined)[] | undefined {
	if (typeof message.content === "string") return undefined;
	const images = message.content.filter(
		(content): content is ImageContent =>
			content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
	);
	const materialized = materializeImageReferenceLinksSync(images, putBlobSync);
	return images.map((image, index) => videoPreviewSource(image) ?? materialized?.[index]);
}

/**
 * Adapts session events and persisted messages to identity-stable reactive
 * transcript entries. Views never receive a paint container.
 */
export class UiHelpers {
	#nextEntry = 0;
	#readGroup: ReplayReadGroup | undefined;
	#pendingToolEntries = new Map<string, PendingToolEntry>();
	#toolModelsByEntry = new Map<string, Set<ToolCallModel>>();
	#messageEntries = new Map<AgentMessage, readonly string[]>();
	#messageEntriesByKey = new Map<string, readonly string[]>();
	#latestReactionTarget: ReactionTarget | undefined;
	#optimisticReactionTarget: ReactionTarget | undefined;
	#optimisticReactionSignature: string | undefined;
	#pendingUsage: PendingUsage | undefined;
	#turnStartedAt: number | undefined;

	constructor(private readonly ctx: InteractiveModeContext) {}

	/**
	 * Claim the last real user bubble once. The streamed assistant retains this
	 * target across its cumulative snapshots; a following replayed assistant
	 * consumes the same target only when no live stream did.
	 */
	takeReactionTargetForAssistant(): ReactionTarget | undefined {
		const target = this.#latestReactionTarget;
		this.#latestReactionTarget = undefined;
		if (this.#optimisticReactionTarget === target) {
			this.#optimisticReactionTarget = undefined;
			this.#optimisticReactionSignature = undefined;
		}
		return target;
	}

	#append(view: () => JSX.Element, options: Omit<TranscriptEntryInput, "id" | "view"> = {}): string {
		const id = `message:${this.#nextEntry++}`;
		this.ctx.chatContainer.append({ id, view, state: "settled", ...options });
		return id;
	}

	#registerToolModel(entryId: string, model: ToolCallModel): void {
		let models = this.#toolModelsByEntry.get(entryId);
		if (!models) {
			models = new Set();
			this.#toolModelsByEntry.set(entryId, models);
		}
		models.add(model);
		this.ctx.toolPresentation.register(model);
	}

	#unregisterToolModels(entryIds: ReadonlySet<string>): void {
		for (const entryId of entryIds) {
			const models = this.#toolModelsByEntry.get(entryId);
			if (!models) continue;
			for (const model of models) this.ctx.toolPresentation.unregister(model);
			this.#toolModelsByEntry.delete(entryId);
		}
	}

	#recordMessageEntries(message: AgentMessage, entries: string[]): string[] {
		if (entries.length > 0) {
			this.#messageEntries.set(message, entries);
			this.#messageEntriesByKey.set(transcriptMessageKey(message), entries);
		}
		return entries;
	}

	#setReadGroupAllocation(group: ReplayReadGroup, rows: number): void {
		group.allocation = rows;
		for (const toolCallId of group.state.toolCallIds) {
			const model = this.#pendingToolEntries.get(toolCallId)?.model;
			if (model) this.ctx.toolPresentation.setAllocation(model, rows);
		}
	}

	#finalizeReadGroup(): void {
		this.#readGroup = undefined;
	}

	#queueUsage(message: AssistantMessage): void {
		if (!this.ctx.settings.get("display.showTokenUsage") || !assistantUsageIsBilled(message.usage)) return;
		const toolCallIds = new Set(
			message.content
				.filter(
					(content): content is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
						content.type === "toolCall",
				)
				.map(content => content.id),
		);
		const readCallIds = groupedReadUsageCallIds(message);
		const readGroup =
			readCallIds?.every(toolCallId => this.#readGroup?.state.toolCallIds.has(toolCallId)) === true
				? this.#readGroup
				: undefined;
		this.#pendingUsage = {
			usage: message.usage,
			durationMs: message.duration,
			ttftMs: message.ttft,
			timestamp: message.timestamp,
			turnElapsed: this.ctx.settings.get("display.showTurnTime")
				? turnElapsedMs(this.#turnStartedAt, message)
				: undefined,
			remainingToolCallIds: toolCallIds,
			readGroup,
		};
		this.#flushPendingUsage();
	}

	#flushPendingUsage(force = false): void {
		const pending = this.#pendingUsage;
		if (!pending || (!force && pending.remainingToolCallIds.size > 0)) return;
		this.#pendingUsage = undefined;
		const group = pending.readGroup;
		if (
			group &&
			pending.remainingToolCallIds.size === 0 &&
			group.state.toolCallIds.size > 0 &&
			this.ctx.chatContainer.canRemove(group.entryId)
		) {
			group.state.addUsage({
				kind: "usage",
				usage: pending.usage,
				durationMs: pending.durationMs,
				ttftMs: pending.ttftMs,
				timestamp: pending.timestamp,
				turnElapsed: pending.turnElapsed,
			});
			return;
		}
		this.#append(() =>
			UsageRow({
				usage: pending.usage,
				durationMs: pending.durationMs,
				ttftMs: pending.ttftMs,
				timestamp: pending.timestamp,
				turnElapsed: pending.turnElapsed,
			}),
		);
	}

	showStatus(message: string, options?: { readonly dim?: boolean }): void {
		this.#append(() => NoticeView({ text: message, color: options?.dim === false ? "text" : "dim" }));
	}

	addMessageToChat(message: AgentMessage, options?: AddMessageOptions): string[] {
		const helper = this;
		if (message.role !== "toolResult") this.#flushPendingUsage(true);
		if (message.role !== "assistant" && message.role !== "toolResult") this.#finalizeReadGroup();
		switch (message.role) {
			case "assistant":
				return this.#recordMessageEntries(message, this.#appendAssistant(message));
			case "toolResult":
				return this.#recordMessageEntries(message, this.#applyToolResult(message));
			case "developer":
				return [];
			case "user": {
				if (message.attribution !== "agent") this.#turnStartedAt = message.timestamp;
				const text = textContent(message.content);
				if (text.length === 0) return [];
				const synthetic = message.synthetic === true;
				const reaction = !synthetic ? this.#reactionTargetForUser(message, text) : undefined;
				return this.#recordMessageEntries(message, [
					this.#append(() =>
						UserMessageView({
							text,
							options: {
								synthetic,
								imageLinks:
									options?.imageLinks ??
									imageLinksForMessage(
										message,
										this.ctx.viewSession.sessionManager.putBlobSync.bind(this.ctx.viewSession.sessionManager),
									),
							},
							reaction,
						}),
					),
				]);
			}
			case "bashExecution":
				return this.#recordMessageEntries(message, [
					this.#append(() =>
						BashExecutionView({
							command: message.command,
							output: message.output,
							exitCode: message.exitCode,
							cancelled: message.cancelled,
							expanded: () => this.ctx.toolOutputExpanded,
							excludeFromContext: message.excludeFromContext,
							meta: message.meta,
							images: message.images,
							showImages: this.ctx.assistantImagesVisible,
						}),
					),
				]);
			case "pythonExecution":
				return this.#recordMessageEntries(message, [
					this.#append(() =>
						EvalExecutionView({
							language: "python",
							code: message.code,
							output: message.output,
							exitCode: message.exitCode,
							cancelled: message.cancelled,
							expanded: () => this.ctx.toolOutputExpanded,
							excludeFromContext: message.excludeFromContext,
							meta: message.meta,
						}),
					),
				]);
			case "compactionSummary":
				return this.#recordMessageEntries(message, [
					this.#append(() =>
						CompactionSummaryMessageView({
							message,
							get expanded() {
								return helper.ctx.toolOutputExpanded;
							},
						}),
					),
				]);
			case "branchSummary":
				return this.#recordMessageEntries(message, [
					this.#append(() =>
						BranchSummaryView({
							message,
							get expanded() {
								return helper.ctx.toolOutputExpanded;
							},
						}),
					),
				]);
			case "fileMention":
				return this.#recordMessageEntries(message, [
					this.#append(() => FileMentionMessageView({ files: message.files })),
				]);
			case "custom":
				return this.#recordMessageEntries(
					message,
					message.display
						? [
								this.#append(
									() =>
										CustomMessageDispatchView({
											message,
											expanded: () => this.ctx.toolOutputExpanded,
											toolActivityVisible: this.ctx.chatContainer.toolActivityVisible,
											getMessageView: this.ctx.session.extensionRunner?.getMessageView.bind(
												this.ctx.session.extensionRunner,
											),
										}),
									{ toolActivity: isCustomMessageToolActivity(message) },
								),
							]
						: [],
				);
			case "hookMessage":
				return this.#recordMessageEntries(
					message,
					message.display
						? [
								this.#append(() =>
									HookMessageDispatchView({
										message,
										expanded: () => this.ctx.toolOutputExpanded,
									}),
								),
							]
						: [],
				);
			default:
				message satisfies never;
				return [];
		}
	}

	#reactionTargetForUser(message: Extract<AgentMessage, { role: "user" }>, text: string): ReactionTarget {
		const imageCount =
			typeof message.content === "string" ? 0 : message.content.filter(content => content.type === "image").length;
		const signature = `${text}\u0000${imageCount}`;
		const optimisticSignature = this.ctx.optimisticUserMessageSignature;
		const target =
			(optimisticSignature === undefined && this.#optimisticReactionTarget) ||
			(optimisticSignature === signature &&
				this.#optimisticReactionSignature === signature &&
				this.#optimisticReactionTarget) ||
			createReactionTarget();
		this.#latestReactionTarget = target;
		if (optimisticSignature === signature) {
			this.#optimisticReactionTarget = target;
			this.#optimisticReactionSignature = signature;
		} else if (optimisticSignature === undefined) {
			// Canonical replacement consumes the optimistic target in place.
			this.#optimisticReactionTarget = undefined;
			this.#optimisticReactionSignature = undefined;
		}
		return target;
	}

	#readGroupForAppend(): ReplayReadGroup {
		const existing = this.#readGroup;
		if (existing && this.ctx.chatContainer.canRemove(existing.entryId)) return existing;
		const state = createReadToolGroupState();
		const showContentPreview = this.ctx.settings.get("read.toolResultPreview");
		const controller = this;
		const group: ReplayReadGroup = {
			entryId: this.#append(
				() =>
					ReadToolGroupView({
						items: state.items,
						expanded: () => controller.ctx.toolOutputExpanded,
						showContentPreview,
					}),
				{
					state: "active",
					toolActivity: true,
					onAllocation: rows => this.#setReadGroupAllocation(group, rows),
					compactView: () => ReadToolGroupSummary({ items: state.items }),
				},
			),
			state,
			allocation: 0,
		};
		this.#readGroup = group;
		return group;
	}

	#appendAssistant(message: AssistantMessage): string[] {
		const timeline = splitAssistantMessageToolTimeline(message);
		if (assistantHasVisibleContent(message)) this.#finalizeReadGroup();
		const reactionTarget = this.takeReactionTargetForAssistant();
		const entries = [
			this.#append(() =>
				AssistantMessageView({
					message: timeline.beforeTools,
					expanded: () => this.ctx.toolOutputExpanded,
					hideThinking: () => this.ctx.effectiveHideThinkingBlock,
					proseOnlyThinking: () => this.ctx.proseOnlyThinking,
					linkTargets: getAssistantMessageLinkTargets(this.ctx),
					thinkingRenderers: this.ctx.viewSession.extensionRunner?.getAssistantThinkingRenderers() ?? [],
					showImages: () => this.ctx.assistantImagesVisible,
					reactionTarget,
					transient: false,
				}),
			),
		];
		if (this.ctx.settings.get("display.cacheMissMarker")) {
			const invalidation = detectCacheInvalidation(this.ctx.lastAssistantUsage, message.usage);
			if (invalidation) entries.push(this.#append(() => CacheInvalidationMarkerView({ info: invalidation })));
		}
		if (assistantUsageIsBilled(message.usage)) this.ctx.lastAssistantUsage = message.usage;
		const servedModelMismatch = this.ctx.servedModelTracker.check(message);
		if (servedModelMismatch) entries.push(this.#append(() => ServedModelMarkerView({ info: servedModelMismatch })));
		for (const [contentIndex, content] of message.content.entries()) {
			if (content.type !== "toolCall") continue;
			const model = createToolCallModel({ id: content.id, toolName: content.name, label: content.name });
			if (
				typeof content.arguments === "string" ||
				(typeof content.arguments === "object" && content.arguments !== null)
			) {
				model.applyArgsChunk(content.arguments);
			}
			model.markRunning();
			const groupedRead = content.name === "read" && readArgsCollapseIntoGroup(content.arguments);
			const readGroup = groupedRead ? this.#readGroupForAppend() : undefined;
			if (!groupedRead) this.#finalizeReadGroup();
			const entryId =
				readGroup?.entryId ??
				this.#append(() => ToolBlock({ model, source: createToolViewSource(this.ctx, content.name) }), {
					state: "active",
					toolActivity: true,
					onAllocation: rows => this.ctx.toolPresentation.setAllocation(model, rows),
					compactView: () => ToolBlockSummary({ model, source: createToolViewSource(this.ctx, content.name) }),
				});
			this.#registerToolModel(entryId, model);
			if (readGroup) {
				const firstEntry = readGroup.state.toolCallIds.size === 0;
				readGroup.state.add(content.id, model, true);
				this.ctx.chatContainer.replace(entryId, { state: "active" });
				this.ctx.toolPresentation.setAllocation(model, readGroup.allocation);
				if (firstEntry) entries.push(entryId);
			} else {
				entries.push(entryId);
			}
			this.ctx.pendingTools.set(content.id, model);
			this.#pendingToolEntries.set(content.id, { entryId, model, readGroup });
			this.ctx.eventController.registerReplayedToolCall(
				content.id,
				model,
				entryId,
				readGroup ? { transcriptId: readGroup.entryId, state: readGroup.state } : undefined,
			);
			const afterTool = timeline.afterToolCalls.get(contentIndex);
			if (afterTool) {
				entries.push(
					this.#append(() =>
						AssistantMessageView({
							message: afterTool,
							expanded: () => this.ctx.toolOutputExpanded,
							hideThinking: () => this.ctx.effectiveHideThinkingBlock,
							proseOnlyThinking: () => this.ctx.proseOnlyThinking,
							linkTargets: getAssistantMessageLinkTargets(this.ctx),
							thinkingRenderers: this.ctx.viewSession.extensionRunner?.getAssistantThinkingRenderers() ?? [],
							showImages: () => this.ctx.assistantImagesVisible,
							transient: false,
						}),
					),
				);
			}
		}
		this.#queueUsage(message);
		return entries;
	}

	#applyToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): string[] {
		const pending = this.#pendingToolEntries.get(message.toolCallId);
		if (!pending) return [];
		const running = resultAsyncStateIsRunning(message);
		pending.model.applyResult(message, { partial: running });
		if (pending.readGroup) {
			if (pending.readGroup.state.settle(message.toolCallId) && this.ctx.chatContainer.canRemove(pending.entryId)) {
				this.ctx.chatContainer.replace(pending.entryId, { state: "settled" });
			}
		} else {
			this.ctx.chatContainer.replace(pending.entryId, { state: "settled" });
		}
		this.#pendingUsage?.remainingToolCallIds.delete(message.toolCallId);
		this.#flushPendingUsage();
		if (running) return [pending.entryId];
		this.#pendingToolEntries.delete(message.toolCallId);
		this.ctx.pendingTools.delete(message.toolCallId);
		this.ctx.eventController.releaseReplayedToolCall(message.toolCallId);
		return [pending.entryId];
	}

	renderSessionContext(sessionContext: SessionContext): void {
		this.ctx.lastAssistantUsage = undefined;
		this.ctx.servedModelTracker = new ServedModelTracker();
		for (const message of sessionContext.messages) this.addMessageToChat(message);
		this.#flushPendingUsage(true);
		this.#finalizeReadGroup();
		this.ctx.eventController.restoreLiveTranscript();
	}

	async renderSessionContextIncrementally(sessionContext: SessionContext): Promise<void> {
		this.ctx.lastAssistantUsage = undefined;
		this.ctx.servedModelTracker = new ServedModelTracker();
		await refreshAssistantMessageLinkTargets(
			this.ctx,
			sessionContext.messages.filter((message): message is AssistantMessage => message.role === "assistant"),
		);
		for (const [index, message] of sessionContext.messages.entries()) {
			this.addMessageToChat(message);
			if ((index + 1) % 32 !== 0) continue;
			await Bun.sleep(0);
		}
		this.#flushPendingUsage(true);
		this.#finalizeReadGroup();
		this.ctx.eventController.restoreLiveTranscript();
	}

	truncateTranscriptFromMessage(message: AgentMessage): boolean {
		const boundaryIds =
			this.#messageEntries.get(message) ?? this.#messageEntriesByKey.get(transcriptMessageKey(message));
		if (!boundaryIds || boundaryIds.length === 0) return false;
		const entries = this.ctx.chatContainer.entries();
		const boundaryIndex = entries.findIndex(entry => boundaryIds.includes(entry.id));
		if (boundaryIndex === -1) return false;
		const tail = entries.slice(boundaryIndex);
		if (!tail.every(entry => this.ctx.chatContainer.canRemove(entry.id))) return false;

		for (const entry of tail) this.ctx.chatContainer.remove(entry.id);
		const removed = new Set(tail.map(entry => entry.id));
		this.#unregisterToolModels(removed);
		for (const [recordedMessage, ids] of this.#messageEntries) {
			if (ids.some(id => removed.has(id))) this.#messageEntries.delete(recordedMessage);
		}
		for (const [key, ids] of this.#messageEntriesByKey) {
			if (ids.some(id => removed.has(id))) this.#messageEntriesByKey.delete(key);
		}
		for (const [toolCallId, pending] of this.#pendingToolEntries) {
			if (!removed.has(pending.entryId)) continue;
			this.#pendingToolEntries.delete(toolCallId);
			this.ctx.pendingTools.delete(toolCallId);
		}
		this.#readGroup = undefined;
		this.#pendingUsage = undefined;
		this.ctx.lastAssistantUsage = undefined;
		this.ctx.servedModelTracker = new ServedModelTracker();
		for (const remaining of this.ctx.viewSession.messages) {
			if (remaining.role !== "assistant") continue;
			if (assistantUsageIsBilled(remaining.usage)) this.ctx.lastAssistantUsage = remaining.usage;
			this.ctx.servedModelTracker.check(remaining);
		}
		return true;
	}

	async renderInitialMessages(options: RenderInitialMessagesOptions = {}): Promise<void> {
		if (!options.preserveExistingChat) {
			this.ctx.chatContainer.clear();
			this.ctx.pendingTools.clear();
			this.#readGroup = undefined;
			this.#pendingToolEntries.clear();
			this.#toolModelsByEntry.clear();
			this.ctx.toolPresentation.clear();
			this.#messageEntries.clear();
			this.#messageEntriesByKey.clear();
			this.#pendingUsage = undefined;
			this.#turnStartedAt = undefined;
		}
		const context = this.ctx.viewSession.buildTranscriptSessionContext({
			collapseCompactedHistory: this.ctx.settings.get("display.collapseCompacted"),
			keepDanglingToolCalls: this.ctx.viewSession.isStreaming,
		});
		await this.renderSessionContextIncrementally(context);
		this.ctx.initialChatRendered = true;
		if (options.clearTerminalHistory) this.ctx.ui.resetDisplay();
	}

	clearEditor(): void {
		if (this.ctx.settings.get("composer.recallClearedDrafts")) this.ctx.editor.clearDraftForRecall();
		else this.ctx.editor.clearDraft();
	}

	showError(message: string): void {
		this.#append(() => NoticeView({ text: `Error: ${message}`, color: "error" }));
	}

	showWarning(message: string, _options?: { readonly hideWithToolActivity?: boolean }): void {
		this.#append(() => NoticeView({ text: `Warning: ${message}`, color: "warning" }));
	}

	showNewVersionNotification(version: string): void {
		this.#append(() => UpdateAvailableView({ version }));
	}

	updatePendingMessagesDisplay(): void {
		this.ctx.pendingMessagesContainer.clear();
		const queued = this.ctx.viewSession.getQueuedMessages() as { steering: string[]; followUp: string[] };
		const groups = [
			{
				label: "Steering",
				messages: [
					...queued.steering,
					...this.ctx.compactionQueuedMessages.filter(entry => entry.mode === "steer").map(entry => entry.text),
				],
			},
			{
				label: "After yield",
				messages: [
					...queued.followUp,
					...this.ctx.compactionQueuedMessages.filter(entry => entry.mode === "followUp").map(entry => entry.text),
				],
			},
		].filter(group => group.messages.length > 0);
		if (groups.length === 0) return;
		this.ctx.pendingMessagesContainer.append(PendingMessagesView({ groups }));
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		this.ctx.compactionQueuedMessages.push({ text, mode, images: images && images.length > 0 ? images : undefined });
		this.ctx.editor.clearDraft(text);
		this.updatePendingMessagesDisplay();
	}

	isKnownSlashCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const commandName = text.slice(1).split(/\s/, 1)[0] ?? "";
		return Boolean(
			this.ctx.session.extensionRunner?.getCommand(commandName) ||
			this.ctx.session.customCommands.some(command => command.command.name === commandName) ||
			this.ctx.fileSlashCommands.has(commandName),
		);
	}

	async flushCompactionQueue(options?: { readonly willRetry?: boolean }): Promise<void> {
		const queued = this.ctx.compactionQueuedMessages.splice(0);
		this.updatePendingMessagesDisplay();
		for (let index = 0; index < queued.length; index++) {
			const entry = queued[index]!;
			try {
				if (
					await invokeSkillCommandFromText(this.ctx, entry.text, entry.mode, {
						queueOnly: true,
						images: entry.images,
					})
				)
					continue;
				if (isKnownSkillCommand(this.ctx, entry.text)) {
					const built = await buildSkillCommandPrompt(this.ctx, entry.text, entry.mode, entry.images);
					if (built) await this.ctx.session.promptCustomMessage(built.message, built.options);
					continue;
				}
				if (this.isKnownSlashCommand(entry.text)) {
					const forwarded = await this.ctx.session.prompt(entry.text);
					if (!forwarded && this.ctx.loopPrompt === entry.text) this.ctx.pauseLoop();
					continue;
				}
				if (options?.willRetry) {
					if (entry.mode === "steer") await this.ctx.session.steer(entry.text, entry.images);
					else await this.ctx.session.followUp(entry.text, entry.images);
					continue;
				}
				const forwarded = await this.ctx.withLocalSubmission(
					entry.text,
					() =>
						this.ctx.session.prompt(entry.text, {
							streamingBehavior: entry.mode,
							images: entry.images,
						}),
					{ imageCount: entry.images?.length ?? 0 },
				);
				if (!forwarded && this.ctx.loopPrompt === entry.text) this.ctx.pauseLoop();
			} catch {
				this.ctx.compactionQueuedMessages.unshift(...queued.slice(index));
				this.updatePendingMessagesDisplay();
				return;
			}
		}
	}

	flushPendingExecutions(): void {
		const pending = this.ctx.pendingExecutions.splice(0);
		if (pending.length === 0) return;
		const sessionId = this.ctx.sessionManager.getSessionId();
		for (const execution of pending) {
			this.ctx.pendingMessagesContainer.remove(execution.pendingId);
			if (execution.sessionId !== sessionId) continue;
			if (this.ctx.chatContainer.entries().some(entry => entry.id === execution.id)) {
				this.ctx.chatContainer.replace(execution.id, { state: execution.state });
				continue;
			}
			this.ctx.chatContainer.append({
				id: execution.id,
				view: execution.view,
				state: execution.state,
			});
		}
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		for (let index = this.ctx.viewSession.messages.length - 1; index >= 0; index--) {
			const message = this.ctx.viewSession.messages[index];
			if (message?.role === "assistant") return message;
		}
		return undefined;
	}

	extractAssistantText(message: AssistantMessage): string {
		return message.content
			.filter(
				(content): content is Extract<AssistantMessage["content"][number], { type: "text" }> =>
					content.type === "text",
			)
			.map(content => content.text)
			.join("")
			.trim();
	}
}
