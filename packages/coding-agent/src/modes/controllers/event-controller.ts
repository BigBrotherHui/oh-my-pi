import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import {
	assistantUsageIsBilled,
	createStreamingAssistantMessageView,
	resolveAssistantErrorPresentation,
	type StreamingAssistantMessageView,
} from "@oh-my-pi/pi-tui/chat/assistant-message";
import { CacheInvalidationMarkerView, detectCacheInvalidation } from "@oh-my-pi/pi-tui/chat/cache-invalidation-marker";
import {
	ReadToolGroupSummary,
	ReadToolGroupView,
	createReadToolGroupState,
	groupedReadUsageCallIds,
	readArgsCollapseIntoGroup,
	readArgsHaveTarget,
	type ReadToolGroupState,
} from "@oh-my-pi/pi-tui/chat/read-tool-group";
import type { ReactionTarget } from "@oh-my-pi/pi-tui/chat/reaction";
import type { StableTranscriptRow } from "@oh-my-pi/pi-tui/host/intrinsics";
import { ServedModelMarkerView, ServedModelTracker } from "@oh-my-pi/pi-tui/chat/served-model-marker";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { turnElapsedMs, UsageRow } from "@oh-my-pi/pi-tui/overlays/usage-row";
import {
	getAssistantMessageLinkTargets,
	refreshAssistantMessageLinkTargets,
} from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";
import { ToolBlock, ToolBlockSummary } from "@oh-my-pi/pi-tui/chat/tool-block";
import {
	createTtsrNotificationModel,
	TtsrNotificationView,
	type TtsrNotificationModel,
} from "@oh-my-pi/pi-tui/chat/ttsr-notification";
import { TodoReminderView } from "@oh-my-pi/pi-tui/chat/todo-reminder";
import { createToolCallModel, type ToolCallModel } from "@oh-my-pi/pi-tui/tools/model";
import type { EditMode, EditPreview, PerFileDiffPreview } from "@oh-my-pi/pi-tui/tools/edit";
import { BusyView, CommandNoticeView } from "../components/reactive-controller-views";
import { previewLine, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { createSignal, type Accessor, type Setter } from "@oh-my-pi/pi-tui/reactive";
import { isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import type { InteractiveModeContext } from "../../modes/types";
import idleRecapPrompt from "../../prompts/system/recap-user.md" with { type: "text" };
import { committedTodoPhases, nextActionableTask } from "../../tools/todo";
import { vocalizer } from "../../tts/vocalizer";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import { isSilentAbort } from "../../session/messages";
import { createToolViewSource } from "../tool-view-source";
import { decodeStreamedToolArgs, streamingStringKeysForTool } from "./tool-args-reveal";
import { assistantHasVisibleContent, splitAssistantMessageToolTimeline } from "../utils/assistant-timeline";

interface LiveReadGroup {
	readonly transcriptId: string;
	readonly state: ReadToolGroupState;
	readonly showContentPreview: boolean;
	allocation: number;
}

interface StreamingAssistantSegment {
	readonly transcriptId: string;
	readonly setMessage: Setter<AssistantMessage>;
	readonly setTransient: Setter<boolean>;
}

interface ToolEntry {
	readonly transcriptId: string;
	readonly model: ToolCallModel;
	readonly readGroup?: Pick<LiveReadGroup, "transcriptId" | "state">;
}

interface PendingUsage {
	readonly usage: Usage;
	readonly durationMs: number | undefined;
	readonly ttftMs: number | undefined;
	readonly timestamp: number | undefined;
	readonly turnElapsed: number | undefined;
	readonly remainingToolCallIds: Set<string>;
	readonly readGroup: LiveReadGroup | undefined;
}

type StreamedToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

const IDLE_RECAP_MIN_SECONDS = 1;
const IDLE_RECAP_MAX_SECONDS = 3600;

function isEditMode(value: unknown): value is EditMode {
	return (
		value === "replace" || value === "patch" || value === "hashline" || value === "apply_patch" || value === "sloppy"
	);
}

function editPreviewFromStreamUpdate(update: unknown): EditPreview | undefined {
	if (!isRecord(update) || !isEditMode(update.editMode) || !Array.isArray(update.files)) return undefined;
	const perFileDiffPreview: PerFileDiffPreview[] = [];
	for (const value of update.files) {
		if (!isRecord(value) || typeof value.path !== "string") continue;
		const preview: PerFileDiffPreview = { path: value.path };
		if (typeof value.diff === "string") preview.diff = value.diff;
		if (typeof value.error === "string") preview.error = value.error;
		if (typeof value.firstChangedLine === "number") preview.firstChangedLine = value.firstChangedLine;
		perFileDiffPreview.push(preview);
	}
	const first = perFileDiffPreview[0];
	const editDiffPreview =
		perFileDiffPreview.length === 1 && first?.diff
			? {
					diff: first.diff,
					...(first.firstChangedLine === undefined ? {} : { firstChangedLine: first.firstChangedLine }),
				}
			: perFileDiffPreview.length === 1 && first?.error
				? { error: first.error }
				: undefined;
	return { editMode: update.editMode, perFileDiffPreview, ...(editDiffPreview ? { editDiffPreview } : {}) };
}

function resultAsyncStateIsRunning(result: { readonly details?: unknown }): boolean {
	if (!isRecord(result.details) || !isRecord(result.details.async)) return false;
	return result.details.async.state === "running";
}

/** Session-event ingress for the reactive transcript. */
export class EventController {
	#toolEntries = new Map<string, ToolEntry>();
	#readGroup: LiveReadGroup | undefined;
	#pendingCompletions = new Map<string, Extract<AgentSessionEvent, { type: "tool_execution_end" }>>();
	#pendingEditPreviews = new Map<string, EditPreview>();
	#settledToolCallIds = new Set<string>();
	#startedToolCallIds = new Set<string>();
	#streamingTranscriptId: string | undefined;
	#setStreamingMessage: Setter<AssistantMessage> | undefined;
	#setStreamingTransient: Setter<boolean> | undefined;
	#setStreamingErrorPinned: Setter<boolean> | undefined;
	#streamingReactionTarget: ReactionTarget | undefined;
	#postToolAssistantSegments = new Map<number, StreamingAssistantSegment>();
	#streamedToolCallIdByContentIndex = new Map<number, string>();
	#retractedToolCallIds = new Set<string>();
	#pinnedErrorTranscriptId: string | undefined;
	#pinnedErrorMessage: AssistantMessage | undefined;
	#pinnedErrorSetter: Setter<boolean> | undefined;
	#pendingUsage: PendingUsage | undefined;
	#turnStartedAt: number | undefined;
	#lastTtsrNotification: { readonly transcriptId: string; readonly model: TtsrNotificationModel } | undefined;
	#nextStreamingId = 0;
	#idleCompactionTimer?: NodeJS.Timeout;
	#idleRecapTimer?: NodeJS.Timeout;
	#idleRecapAbort?: AbortController;

	constructor(private readonly ctx: InteractiveModeContext) {}

	subscribeToAgent(): void {
		this.ctx.unsubscribe = this.ctx.session.subscribe(event => {
			void this.handleEvent(event).catch(error => {
				this.ctx.showError(error instanceof Error ? error.message : String(error));
			});
		});
	}

	dispose(): void {
		this.#toolEntries.clear();
		this.ctx.toolPresentation.clear();
		this.#readGroup = undefined;
		this.#pendingCompletions.clear();
		this.#pendingEditPreviews.clear();
		this.#settledToolCallIds.clear();
		this.#startedToolCallIds.clear();
		this.#streamingTranscriptId = undefined;
		this.#setStreamingMessage = undefined;
		this.#setStreamingTransient = undefined;
		this.#setStreamingErrorPinned = undefined;
		this.#streamingReactionTarget = undefined;
		this.#postToolAssistantSegments.clear();
		this.#streamedToolCallIdByContentIndex.clear();
		this.#retractedToolCallIds.clear();
		this.#pinnedErrorTranscriptId = undefined;
		this.#pinnedErrorMessage = undefined;
		this.#pinnedErrorSetter = undefined;
		this.#pendingUsage = undefined;
		this.#turnStartedAt = undefined;
		this.#lastTtsrNotification = undefined;
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
	}

	hasToolExecutionStarted(toolCallId: string): boolean {
		return this.#startedToolCallIds.has(toolCallId);
	}

	resetTranscriptAnchors(): void {
		this.#toolEntries.clear();
		this.ctx.toolPresentation.clear();
		this.#readGroup = undefined;
		this.#pendingCompletions.clear();
		this.#pendingEditPreviews.clear();
		this.#settledToolCallIds.clear();
		this.#startedToolCallIds.clear();
		this.#streamingTranscriptId = undefined;
		this.#setStreamingMessage = undefined;
		this.#setStreamingTransient = undefined;
		this.#setStreamingErrorPinned = undefined;
		this.#streamingReactionTarget = undefined;
		this.#postToolAssistantSegments.clear();
		this.#streamedToolCallIdByContentIndex.clear();
		this.#retractedToolCallIds.clear();
		this.#pinnedErrorTranscriptId = undefined;
		this.#pinnedErrorMessage = undefined;
		this.#pinnedErrorSetter = undefined;
		this.#pendingUsage = undefined;
		this.#turnStartedAt = undefined;
		this.#lastTtsrNotification = undefined;
		this.ctx.lastAssistantUsage = undefined;
		this.ctx.servedModelTracker = new ServedModelTracker();
	}

	/** Restore non-persisted assistant output and ongoing tool results after history replay. */
	restoreLiveTranscript(): void {
		const message = this.ctx.viewSession.agent.state.streamMessage;
		if (message?.role === "assistant") {
			this.#upsertStreamingAssistant(message);
			this.#streamToolCalls(message);
		}
		for (const update of this.ctx.viewSession.activeToolExecutionUpdates?.() ?? []) {
			this.#updateTool(update);
		}
		for (const [toolCallId, event] of this.#pendingCompletions) {
			const entry = this.#toolEntries.get(toolCallId);
			if (!entry) continue;
			this.#settleTool(entry, event);
		}
	}

	registerReplayedToolCall(
		toolCallId: string,
		model: ToolCallModel,
		transcriptId: string,
		readGroup?: Pick<LiveReadGroup, "transcriptId" | "state">,
	): void {
		const entry = { transcriptId, model, readGroup };
		this.#toolEntries.set(toolCallId, entry);
		this.ctx.pendingTools.set(toolCallId, model);
		const completion = this.#pendingCompletions.get(toolCallId);
		if (completion) this.#settleTool(entry, completion);
	}

	releaseReplayedToolCall(toolCallId: string): void {
		this.ctx.pendingTools.delete(toolCallId);
		this.#pendingCompletions.delete(toolCallId);
		this.#pendingEditPreviews.delete(toolCallId);
		this.#settledToolCallIds.add(toolCallId);
		this.#toolEntries.delete(toolCallId);
	}

	refreshIdleCompactionTimer(): void {
		if (this.ctx.viewSession.isStreaming) {
			this.#cancelIdleCompaction();
			return;
		}
		this.#scheduleIdleCompaction();
	}

	async handleEvent(event: AgentSessionEvent): Promise<void> {
		switch (event.type) {
			case "agent_start":
				this.ctx.clearPinnedError();
				this.#restorePinnedErrorInline();
				this.#finalizeReadGroup();
				this.#cancelIdleCompaction();
				this.#cancelIdleRecap();
				this.#removeRetryLoader();
				this.ctx.statusLine.markActivityStart();
				this.ctx.ensureLoadingAnimation();
				return;
			case "agent_end":
				if (this.ctx.viewSession.isStreaming) return;
				this.#sealReadGroup();
				if (event.isTerminal === false) {
					this.#flushPendingUsage();
					await this.ctx.flushPendingModelSwitch();
					this.ctx.flushPendingExecutions();
					await this.ctx.flushCompactionQueue({ willRetry: true });
					this.ctx.flushPendingCommandOutput();
					return;
				}
				this.#settleStreamingAssistantFromAgentEnd(event);
				this.#flushPendingUsage();
				this.#removeWorkingLoader();
				this.ctx.statusLine.markActivityEnd();
				await this.ctx.flushPendingModelSwitch();
				this.ctx.flushPendingExecutions();
				await this.ctx.flushCompactionQueue({ willRetry: false });
				this.ctx.flushPendingCommandOutput();
				this.ctx.syncRetryHintRow();
				this.#scheduleIdleCompaction();
				this.#scheduleIdleRecap();
				return;
			case "message_start":
				this.#handleMessageStart(event);
				return;
			case "message_update":
				if (event.message.role === "assistant") {
					this.#ensureWorkingLoaderWhileStreaming();
					this.#vocalizeDelta(event);
					this.#upsertStreamingAssistant(event.message);
					this.#streamToolCalls(event.message);
				}
				return;
			case "message_end":
				if (event.message.role === "assistant") {
					if (event.message.stopReason === "aborted") vocalizer.clear();
					else if (this.ctx.settings.get("speech.mode") !== "yield") vocalizer.flush();
					this.#settleStreamingAssistant(event.message);
				}
				return;
			case "turn_end":
				this.#handleTurnEnd(event);
				return;
			case "tool_execution_start":
				this.#ensureWorkingLoaderWhileStreaming();
				this.#startTool(event);
				return;
			case "tool_execution_update":
				this.#updateTool(event);
				return;
			case "tool_stream_update":
				this.#updateStreamedToolPreview(event);
				return;
			case "tool_execution_end":
				this.#endTool(event);
				return;
			case "notice":
				if (event.level === "error") this.ctx.showError(event.message);
				else if (event.level === "warning") this.ctx.showWarning(event.message);
				else this.ctx.showStatus(event.message);
				return;
			case "todo_reminder":
				this.ctx.setTodos(event.todos);
				this.ctx.chatContainer.append({
					id: `todo-reminder:${this.#nextStreamingId++}`,
					view: () =>
						TodoReminderView({
							todos: event.todos,
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							visible: this.ctx.chatContainer.toolActivityVisible,
						}),
					state: "settled",
				});
				return;
			case "todo_auto_clear":
				this.ctx.setTodos([]);
				return;
			case "irc_message":
				this.ctx.addMessageToChat(event.message);
				return;
			case "thinking_level_changed":
			case "model_changed":
			case "advisor_cost_changed":
			case "advisor_yielded":
				this.ctx.statusLine.ingestSession();
				return;
			case "auto_compaction_start":
				this.#handleAutoCompactionStart(event);
				return;
			case "auto_compaction_end":
				await this.#handleAutoCompactionEnd(event);
				return;
			case "auto_retry_start":
				this.#handleAutoRetryStart(event);
				return;
			case "auto_retry_end":
				this.#handleAutoRetryEnd(event);
				return;
			case "retry_fallback_applied":
				this.ctx.showWarning(`Fallback: ${event.from} -> ${event.to}`);
				return;
			case "retry_fallback_succeeded":
				this.ctx.showStatus(`Fallback succeeded on ${event.model}`);
				return;
			case "ttsr_triggered":
				this.#handleTtsrTriggered(event);
				return;
			case "config_warnings_changed":
			case "goal_updated":
				return;
		}
	}

	#handleTtsrTriggered(event: Extract<AgentSessionEvent, { type: "ttsr_triggered" }>): void {
		const previous = this.#lastTtsrNotification;
		const lastEntry = this.ctx.chatContainer.entries().at(-1);
		if (
			previous &&
			lastEntry?.id === previous.transcriptId &&
			this.ctx.chatContainer.canRemove(previous.transcriptId)
		) {
			previous.model.addRules(event.rules);
			return;
		}

		const model = createTtsrNotificationModel(event.rules);
		const controller = this;
		const transcriptId = `ttsr:${this.#nextStreamingId++}`;
		this.ctx.chatContainer.append({
			id: transcriptId,
			view: () =>
				TtsrNotificationView({
					get rules() {
						return model.rules;
					},
					get expanded() {
						return controller.ctx.toolOutputExpanded;
					},
					get visible() {
						return controller.ctx.chatContainer.toolActivityVisible();
					},
				}),
			state: "settled",
			toolActivity: true,
		});
		this.#lastTtsrNotification = { transcriptId, model };
	}

	#handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): void {
		if (event.message.role === "assistant") {
			this.#ensureWorkingLoaderWhileStreaming();
			return;
		}
		if (event.message.role === "user") {
			if (event.message.attribution !== "agent") this.#turnStartedAt = event.message.timestamp;
			vocalizer.clear();
			const text = textContent(event.message.content);
			const imageCount =
				typeof event.message.content === "string"
					? 0
					: event.message.content.filter(content => content.type === "image").length;
			const signature = `${text}\u0000${imageCount}`;
			const wasOptimistic = this.ctx.optimisticUserMessageSignature === signature;
			const matchedLocalSubmission = this.ctx.locallySubmittedUserSignatures.delete(signature);
			const replacesOptimistic =
				this.ctx.optimisticUserMessageSignature !== undefined && !wasOptimistic && !matchedLocalSubmission;
			if (wasOptimistic) {
				// The optimistic card is already the canonical visible message.
				this.ctx.clearOptimisticUserMessage();
			} else if (replacesOptimistic) {
				this.ctx.replaceOptimisticUserMessage(event.message);
			} else {
				this.ctx.addMessageToChat(event.message);
			}
			if (!event.message.synthetic) this.ctx.updatePendingMessagesDisplay();
		} else {
			// message_start is the sole owner for every non-streamed message.
			// message_end repeats that same object for user/tool lifecycle closure.
			this.ctx.addMessageToChat(event.message);
		}
	}

	#removeWorkingLoader(): void {
		if (this.ctx.loadingAnimation) this.ctx.statusContainer.remove(this.ctx.loadingAnimation);
		this.ctx.loadingAnimation = undefined;
	}

	#removeAutoCompactionLoader(): void {
		if (this.ctx.autoCompactionLoader) this.ctx.statusContainer.remove(this.ctx.autoCompactionLoader);
		this.ctx.autoCompactionLoader = undefined;
	}

	#removeRetryLoader(): void {
		if (this.ctx.retryLoader) this.ctx.statusContainer.remove(this.ctx.retryLoader);
		this.ctx.retryLoader = undefined;
	}

	#ensureWorkingLoaderWhileStreaming(): void {
		if (!this.ctx.viewSession.isStreaming || this.ctx.autoCompactionLoader || this.ctx.retryLoader) return;
		if (
			this.ctx.loadingAnimation &&
			!this.ctx.statusContainer.entries().some(entry => entry.id === this.ctx.loadingAnimation)
		) {
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.ensureLoadingAnimation();
	}

	#maintenanceEscHint(): string {
		return this.ctx.focusedAgentId ? "" : " (esc to cancel)";
	}

	#handleAutoCompactionStart(event: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>): void {
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.#removeWorkingLoader();
		this.#removeAutoCompactionLoader();
		const reason =
			event.reason === "overflow"
				? "Context overflow detected, "
				: event.reason === "incomplete"
					? "Response incomplete, "
					: event.reason === "idle"
						? "Idle "
						: "";
		const action =
			event.action === "remote"
				? "Auto server compaction"
				: event.action === "handoff"
					? "Auto-handoff"
					: event.action === "shake"
						? "Auto-shake"
						: event.action === "snapcompact"
							? "Auto-snapcompact"
							: "Auto context-full maintenance";
		this.ctx.autoCompactionLoader = this.ctx.statusContainer.append(
			BusyView({ message: `${reason}${action}…${this.#maintenanceEscHint()}` }),
		);
	}

	async #handleAutoCompactionEnd(event: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>): Promise<void> {
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.#removeAutoCompactionLoader();
		const handoff = event.action === "handoff";
		const remote = event.action === "remote";
		const shake = event.action === "shake";
		const snapcompact = event.action === "snapcompact";
		if (event.aborted) {
			this.ctx.showStatus(
				handoff
					? "Auto-handoff cancelled"
					: remote
						? "Auto server compaction cancelled"
						: shake
							? "Auto-shake cancelled"
							: snapcompact
								? "Auto-snapcompact cancelled"
								: "Auto context-full maintenance cancelled",
			);
		} else if (shake) {
			if (event.errorMessage) {
				if (!event.skipped) {
					this.ctx.rebuildChatFromMessages();
					this.ctx.statusLine.ingestSession();
				}
				this.ctx.showWarning(event.errorMessage);
			} else if (!event.skipped) {
				this.ctx.lastAssistantUsage = undefined;
				this.ctx.rebuildChatFromMessages();
				this.ctx.statusLine.ingestSession();
				this.ctx.showStatus("Auto-shake completed");
			}
		} else if (event.result) {
			this.ctx.lastAssistantUsage = undefined;
			this.ctx.rebuildChatFromMessages();
			this.ctx.statusLine.ingestSession();
			if (settings.get("display.collapseCompacted")) this.ctx.ui.resetDisplay();
		} else if (event.errorMessage) {
			this.ctx.showWarning(event.errorMessage);
		} else if (handoff) {
			this.ctx.clearTransientSessionUi();
			this.ctx.lastAssistantUsage = undefined;
			await this.ctx.renderInitialMessages();
			this.ctx.statusLine.ingestSession();
			await this.ctx.reloadTodos();
			this.ctx.ui.resetDisplay();
			this.ctx.showStatus("Auto-handoff completed");
		} else if (!event.skipped) {
			this.ctx.showWarning(
				snapcompact
					? "Auto-snapcompact maintenance failed; continuing without maintenance"
					: remote
						? "Auto server compaction failed; continuing without maintenance"
						: "Auto context-full maintenance failed; continuing without maintenance",
			);
		}
		await this.ctx.flushCompactionQueue({ willRetry: event.willRetry });
		this.#ensureWorkingLoaderWhileStreaming();
	}

	#handleAutoRetryStart(event: Extract<AgentSessionEvent, { type: "auto_retry_start" }>): void {
		this.#removeWorkingLoader();
		this.#removeRetryLoader();
		this.ctx.retryLoader = this.ctx.statusContainer.append(
			BusyView({ message: `Retrying (${event.attempt}/${event.maxAttempts})…${this.#maintenanceEscHint()}` }),
		);
	}

	#handleAutoRetryEnd(event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>): void {
		this.#removeRetryLoader();
		if (!event.success && event.finalError)
			this.ctx.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError}`);
		this.#ensureWorkingLoaderWhileStreaming();
	}

	#settleStreamingAssistantFromAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		if (!this.#streamingTranscriptId) return;
		for (let index = event.messages.length - 1; index >= 0; index--) {
			const message = event.messages[index];
			if (message?.role !== "assistant") continue;
			this.#settleStreamingAssistant(message);
			return;
		}
	}

	#assistantView(
		message: AssistantMessage | Accessor<AssistantMessage>,
		reactionTarget: ReactionTarget | undefined,
		transient: boolean | Accessor<boolean>,
		onStableRows: (rows: readonly StableTranscriptRow[]) => void,
		errorPinned: boolean | Accessor<boolean> = false,
	): StreamingAssistantMessageView {
		return createStreamingAssistantMessageView({
			message,
			expanded: () => this.ctx.toolOutputExpanded,
			hideThinking: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			linkTargets: getAssistantMessageLinkTargets(this.ctx),
			thinkingRenderers: this.ctx.viewSession.extensionRunner?.getAssistantThinkingRenderers() ?? [],
			showImages: () => this.ctx.assistantImagesVisible,
			errorPinned,
			reactionTarget,
			transient,
			onStableRows,
		});
	}

	#restorePinnedErrorInline(): void {
		if (!this.#pinnedErrorTranscriptId || !this.#pinnedErrorMessage) return;
		this.#pinnedErrorSetter?.(false);
		this.#pinnedErrorTranscriptId = undefined;
		this.#pinnedErrorMessage = undefined;
		this.#pinnedErrorSetter = undefined;
	}

	async #refreshSettledAssistantLinks(message: AssistantMessage): Promise<void> {
		await refreshAssistantMessageLinkTargets(this.ctx, [message]);
	}

	#queueUsage(message: AssistantMessage): void {
		if (!this.ctx.settings.get("display.showTokenUsage") || !assistantUsageIsBilled(message.usage)) return;
		const toolCallIds = new Set(
			message.content
				.filter((content): content is StreamedToolCall => content.type === "toolCall")
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
			this.ctx.chatContainer.canRemove(group.transcriptId)
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
		const id = `usage:${this.#nextStreamingId++}`;
		this.ctx.chatContainer.append({
			id,
			view: () =>
				UsageRow({
					usage: pending.usage,
					durationMs: pending.durationMs,
					ttftMs: pending.ttftMs,
					timestamp: pending.timestamp,
					turnElapsed: pending.turnElapsed,
				}),
			state: "settled",
		});
	}

	#upsertStreamingAssistant(message: AssistantMessage): void {
		const timeline = splitAssistantMessageToolTimeline(message);
		if (this.#streamedToolCallIdByContentIndex.size === 0 && assistantHasVisibleContent(timeline.beforeTools)) {
			this.#finalizeReadGroup();
		}
		const transient = timeline.lastToolContentIndex === undefined;
		if (!this.#streamingTranscriptId) {
			this.#streamingReactionTarget = this.ctx.takeReactionTargetForAssistant();
			const [source, setSource] = createSignal(timeline.beforeTools);
			const [isTransient, setTransient] = createSignal(transient);
			const [errorPinned, setErrorPinned] = createSignal(false);
			const id = `streaming:${this.#nextStreamingId++}`;
			const assistant = this.#assistantView(
				source,
				this.#streamingReactionTarget,
				isTransient,
				stableRows => this.ctx.chatContainer.replace(id, { stableRows }),
				errorPinned,
			);
			this.#setStreamingMessage = setSource;
			this.#setStreamingTransient = setTransient;
			this.#setStreamingErrorPinned = setErrorPinned;
			this.ctx.chatContainer.append({
				id,
				view: assistant.view,
				stableView: assistant.stableView,
				onResetStableRows: assistant.onResetStableRows,
				mode: "appendOnly",
				state: transient ? "active" : "settled",
			});
			this.#streamingTranscriptId = id;
			return;
		}
		this.#setStreamingMessage?.(timeline.beforeTools);
		this.#setStreamingTransient?.(transient);
		if (!transient) this.ctx.chatContainer.replace(this.#streamingTranscriptId, { state: "settled" });
	}

	#settleStreamingAssistant(message: AssistantMessage): void {
		this.#upsertStreamingAssistant(message);
		this.#streamToolCalls(message);
		const presentation = resolveAssistantErrorPresentation(message);
		const errorPinned = message.stopReason === "error" && presentation.kind === "full" && !isSilentAbort(message);
		const transcriptId = this.#streamingTranscriptId;
		if (!transcriptId) return;
		if (message.stopReason === "aborted" && isSilentAbort(message) && this.ctx.viewSession.isTtsrAbortPending) {
			this.#retractNeverExecutedToolPreviews();
		}
		this.#setStreamingMessage?.(splitAssistantMessageToolTimeline(message).beforeTools);
		this.#setStreamingTransient?.(false);
		this.ctx.chatContainer.replace(transcriptId, { state: "settled" });
		for (const segment of this.#postToolAssistantSegments.values()) {
			segment.setTransient(false);
			this.ctx.chatContainer.replace(segment.transcriptId, { state: "settled" });
		}
		if (errorPinned) {
			this.#setStreamingErrorPinned?.(true);
			this.#pinnedErrorTranscriptId = transcriptId;
			this.#pinnedErrorMessage = message;
			this.#pinnedErrorSetter = this.#setStreamingErrorPinned;
			this.ctx.showPinnedError(presentation.text);
		}
		void this.#refreshSettledAssistantLinks(message);
		this.#appendAssistantDecorations(message);
		this.#queueUsage(message);
		this.#streamingTranscriptId = undefined;
		this.#setStreamingMessage = undefined;
		this.#setStreamingTransient = undefined;
		this.#setStreamingErrorPinned = undefined;
		this.#streamingReactionTarget = undefined;
		this.#postToolAssistantSegments.clear();
		this.#streamedToolCallIdByContentIndex.clear();
	}

	#appendAssistantDecorations(message: AssistantMessage): void {
		if (this.ctx.settings.get("display.cacheMissMarker")) {
			const invalidation = detectCacheInvalidation(this.ctx.lastAssistantUsage, message.usage);
			if (invalidation) {
				this.ctx.chatContainer.append({
					id: `cache-miss:${this.#nextStreamingId++}`,
					view: () => CacheInvalidationMarkerView({ info: invalidation }),
					state: "settled",
				});
			}
		}
		if (assistantUsageIsBilled(message.usage)) this.ctx.lastAssistantUsage = message.usage;
		const servedModelMismatch = this.ctx.servedModelTracker.check(message);
		if (servedModelMismatch) {
			this.ctx.chatContainer.append({
				id: `served-model:${this.#nextStreamingId++}`,
				view: () => ServedModelMarkerView({ info: servedModelMismatch }),
				state: "settled",
			});
		}
	}

	#streamToolCalls(message: AssistantMessage): void {
		const timeline = splitAssistantMessageToolTimeline(message);
		for (const [contentIndex, content] of message.content.entries()) {
			if (content.type !== "toolCall") continue;
			this.#streamToolCall(content, contentIndex);
			const segment = timeline.afterToolCalls.get(contentIndex);
			if (segment)
				this.#upsertPostToolAssistantSegment(contentIndex, segment, contentIndex === timeline.lastToolContentIndex);
		}
	}

	#upsertPostToolAssistantSegment(contentIndex: number, message: AssistantMessage, transient: boolean): void {
		const existing = this.#postToolAssistantSegments.get(contentIndex);
		if (existing) {
			existing.setMessage(message);
			existing.setTransient(transient);
			if (!transient) this.ctx.chatContainer.replace(existing.transcriptId, { state: "settled" });
			return;
		}
		this.#finalizeReadGroup();
		const [source, setSource] = createSignal(message);
		const [isTransient, setTransient] = createSignal(transient);
		const transcriptId = `streaming:after-tool:${this.#nextStreamingId++}`;
		const assistant = this.#assistantView(source, undefined, isTransient, stableRows =>
			this.ctx.chatContainer.replace(transcriptId, { stableRows }),
		);
		this.ctx.chatContainer.append({
			id: transcriptId,
			view: assistant.view,
			stableView: assistant.stableView,
			onResetStableRows: assistant.onResetStableRows,
			mode: "appendOnly",
			state: transient ? "active" : "settled",
		});
		this.#postToolAssistantSegments.set(contentIndex, { transcriptId, setMessage: setSource, setTransient });
	}

	#streamToolCall(call: StreamedToolCall, contentIndex: number): void {
		const requestedId = call.id || `stream:${this.#streamingTranscriptId ?? "assistant"}:${contentIndex}`;
		const previousId = this.#streamedToolCallIdByContentIndex.get(contentIndex);
		if (previousId !== undefined && previousId !== requestedId)
			this.#migrateStreamedToolCallId(previousId, requestedId);
		this.#streamedToolCallIdByContentIndex.set(contentIndex, requestedId);
		if (this.#retractedToolCallIds.has(requestedId) || this.#settledToolCallIds.has(requestedId)) return;
		const rawArgs = getStreamingPartialJson(call);
		const decodedArgs =
			rawArgs === undefined
				? call.arguments
				: decodeStreamedToolArgs(rawArgs, {
						rawInput: call.customWireName !== undefined,
						fullArgs: call.arguments,
						streamingStringKeys: streamingStringKeysForTool(call.name, call.customWireName !== undefined),
					});
		if (call.name === "read" && !readArgsHaveTarget(decodedArgs)) return;
		let entry = this.#toolEntries.get(requestedId);
		if (!entry) entry = this.#createToolEntry(requestedId, call.name, decodedArgs);
		if (rawArgs !== undefined) entry.model.applyArgsChunk(rawArgs);
		entry.model.applyArgsChunk(decodedArgs);
	}

	#migrateStreamedToolCallId(previousId: string, nextId: string): void {
		const entry = this.#toolEntries.get(previousId);
		if (entry) {
			this.#toolEntries.delete(previousId);
			this.#toolEntries.set(nextId, entry);
		}
		const pending = this.#pendingCompletions.get(previousId);
		if (pending) {
			this.#pendingCompletions.delete(previousId);
			this.#pendingCompletions.set(nextId, pending);
		}
		const preview = this.#pendingEditPreviews.get(previousId);
		if (preview) {
			this.#pendingEditPreviews.delete(previousId);
			this.#pendingEditPreviews.set(nextId, preview);
		}
		const model = this.ctx.pendingTools.get(previousId);
		if (model) {
			this.ctx.pendingTools.delete(previousId);
			this.ctx.pendingTools.set(nextId, model);
		}
		if (this.#startedToolCallIds.delete(previousId)) this.#startedToolCallIds.add(nextId);
		if (this.#settledToolCallIds.delete(previousId)) this.#settledToolCallIds.add(nextId);
		if (this.#retractedToolCallIds.delete(previousId)) this.#retractedToolCallIds.add(nextId);
	}

	#createToolEntry(toolCallId: string, toolName: string, args: Record<string, unknown>): ToolEntry {
		this.#settledToolCallIds.delete(toolCallId);
		const model = createToolCallModel({ id: toolCallId, toolName, label: toolName });
		model.applyArgsChunk(args);
		const groupedRead = toolName === "read" && readArgsCollapseIntoGroup(args);
		const readGroup = groupedRead ? this.#readGroupForAppend() : undefined;
		if (!groupedRead) this.#finalizeReadGroup();
		const transcriptId = readGroup?.transcriptId ?? `tool:${toolCallId}`;
		if (readGroup) {
			readGroup.state.add(toolCallId, model, true);
			this.ctx.chatContainer.replace(transcriptId, { state: "active" });
		} else {
			this.ctx.chatContainer.append({
				id: transcriptId,
				view: () => ToolBlock({ model, source: createToolViewSource(this.ctx, toolName) }),
				compactView: () => ToolBlockSummary({ model, source: createToolViewSource(this.ctx, toolName) }),
				state: "active",
				toolActivity: true,
				onAllocation: rows => this.ctx.toolPresentation.setAllocation(model, rows),
			});
		}
		const entry = { transcriptId, model, readGroup };
		this.#toolEntries.set(toolCallId, entry);
		this.ctx.pendingTools.set(toolCallId, model);
		this.ctx.toolPresentation.register(model);
		if (readGroup) this.ctx.toolPresentation.setAllocation(model, readGroup.allocation);
		const preview = this.#pendingEditPreviews.get(toolCallId);
		if (preview) {
			model.setUi({ edit: preview });
			this.#pendingEditPreviews.delete(toolCallId);
		}
		const completion = this.#pendingCompletions.get(toolCallId);
		if (completion) this.#settleTool(entry, completion);
		return entry;
	}

	#startTool(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): void {
		if (this.#retractedToolCallIds.has(event.toolCallId)) return;
		this.#startedToolCallIds.add(event.toolCallId);
		if (!this.ctx.session.isAborting && "intent" in event && typeof event.intent === "string") {
			this.ctx.setWorkingMessage(event.intent);
		}
		const existing = this.#toolEntries.get(event.toolCallId);
		if (existing) {
			existing.model.applyArgsChunk(event.args, { snapshot: true });
			existing.model.markRunning();
			return;
		}
		const entry = this.#createToolEntry(event.toolCallId, event.toolName, event.args);
		entry.model.markRunning();
	}

	#updateStreamedToolPreview(event: Extract<AgentSessionEvent, { type: "tool_stream_update" }>): void {
		if (
			(event.toolName !== "edit" && event.toolName !== "apply_patch") ||
			this.#settledToolCallIds.has(event.toolCallId)
		) {
			return;
		}
		const preview = editPreviewFromStreamUpdate(event.update);
		if (!preview) return;
		const entry = this.#toolEntries.get(event.toolCallId);
		if (entry && entry.model.phase !== "settled") {
			entry.model.setUi({ edit: preview });
			return;
		}
		this.#pendingEditPreviews.set(event.toolCallId, preview);
	}

	#finalizeReadGroup(): void {
		this.#readGroup = undefined;
	}

	#sealReadGroup(): void {
		const group = this.#readGroup;
		if (!group) return;
		group.state.seal();
		if (this.ctx.chatContainer.canRemove(group.transcriptId)) {
			this.ctx.chatContainer.replace(group.transcriptId, { state: "settled" });
		}
		this.#readGroup = undefined;
	}

	#setReadGroupAllocation(group: LiveReadGroup, rows: number): void {
		group.allocation = rows;
		for (const entry of this.#toolEntries.values()) {
			if (entry.readGroup?.transcriptId === group.transcriptId) {
				this.ctx.toolPresentation.setAllocation(entry.model, rows);
			}
		}
	}

	#readGroupForAppend(): LiveReadGroup {
		const existing = this.#readGroup;
		if (existing && this.ctx.chatContainer.canRemove(existing.transcriptId)) return existing;
		const state = createReadToolGroupState();
		const group: LiveReadGroup = {
			transcriptId: `read-group:${this.#nextStreamingId++}`,
			state,
			showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
			allocation: 0,
		};
		const controller = this;
		this.ctx.chatContainer.append({
			id: group.transcriptId,
			view: () =>
				ReadToolGroupView({
					items: state.items,
					expanded: () => controller.ctx.toolOutputExpanded,
					showContentPreview: group.showContentPreview,
				}),
			compactView: () => ReadToolGroupSummary({ items: state.items }),
			state: "active",
			toolActivity: true,
			onAllocation: rows => this.#setReadGroupAllocation(group, rows),
		});
		this.#readGroup = group;
		return group;
	}

	#updateTool(event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>): void {
		if (this.#retractedToolCallIds.has(event.toolCallId)) return;
		const entry = this.#toolEntries.get(event.toolCallId);
		if (!entry || (entry.readGroup && !this.ctx.chatContainer.canRemove(entry.readGroup.transcriptId))) return;
		entry.model.applyResult(event.partialResult, { partial: true });
	}

	#endTool(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
		if (this.#retractedToolCallIds.delete(event.toolCallId)) return;
		this.#startedToolCallIds.delete(event.toolCallId);
		if (event.toolName === "todo") {
			const phases = committedTodoPhases({ ...event.result, isError: event.isError });
			if (phases) this.ctx.setTodos(phases);
		}
		const details = event.result.details;
		if (!event.isError && event.toolName === "write" && isRecord(details) && isRecord(details.xdev)) {
			const xdev = details.xdev;
			const inner = isRecord(xdev.inner) ? xdev.inner : undefined;
			if (
				xdev.tool === "propose" &&
				xdev.mode === "execute" &&
				inner &&
				typeof inner.planFilePath === "string" &&
				typeof inner.title === "string" &&
				typeof inner.planExists === "boolean"
			) {
				void this.ctx
					.handlePlanApproval({
						planFilePath: inner.planFilePath,
						title: inner.title,
						planExists: inner.planExists,
					})
					.catch(error => {
						logger.warn("Plan approval dispatch failed", {
							error: error instanceof Error ? error.message : String(error),
						});
					});
			}
		}
		const entry = this.#toolEntries.get(event.toolCallId);
		if (!entry) {
			this.#pendingCompletions.set(event.toolCallId, event);
			return;
		}
		this.#settleTool(entry, event);
	}

	#vocalizeDelta(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
		if (!this.ctx.settings.get("speech.enabled")) return;
		const delta = event.assistantMessageEvent;
		const mode = this.ctx.settings.get("speech.mode");
		if (delta.type === "text_delta" && (mode === "assistant" || mode === "all")) vocalizer.pushDelta(delta.delta);
		else if (delta.type === "thinking_delta" && mode === "all") vocalizer.pushDelta(delta.delta);
	}

	#handleTurnEnd(event: Extract<AgentSessionEvent, { type: "turn_end" }>): void {
		if (!this.ctx.settings.get("speech.enabled")) return;
		if (this.ctx.settings.get("speech.mode") !== "yield") {
			vocalizer.flush();
			return;
		}
		if (event.message.role !== "assistant" || event.message.stopReason === "aborted") return;
		const text = textContent(event.message.content);
		if (text) vocalizer.speak(text);
	}

	#retractNeverExecutedToolPreviews(): void {
		const removedTranscriptIds = new Set<string>();
		for (const [toolCallId, entry] of this.#toolEntries) {
			this.#retractedToolCallIds.add(toolCallId);
			removedTranscriptIds.add(entry.transcriptId);
			this.ctx.pendingTools.delete(toolCallId);
			this.ctx.toolPresentation.unregister(entry.model);
		}
		for (const transcriptId of removedTranscriptIds) {
			if (this.ctx.chatContainer.canRemove(transcriptId)) this.ctx.chatContainer.remove(transcriptId);
		}
		this.#toolEntries.clear();
		this.#pendingCompletions.clear();
		this.#pendingEditPreviews.clear();
		for (const segment of this.#postToolAssistantSegments.values()) {
			if (this.ctx.chatContainer.canRemove(segment.transcriptId))
				this.ctx.chatContainer.remove(segment.transcriptId);
		}
		this.#postToolAssistantSegments.clear();
	}

	#cancelIdleCompaction(): void {
		if (this.#idleCompactionTimer) {
			clearTimeout(this.#idleCompactionTimer);
			this.#idleCompactionTimer = undefined;
		}
	}

	#cancelIdleRecap(): void {
		if (this.#idleRecapTimer) {
			clearTimeout(this.#idleRecapTimer);
			this.#idleRecapTimer = undefined;
		}
		if (this.#idleRecapAbort) {
			this.#idleRecapAbort.abort();
			this.#idleRecapAbort = undefined;
		}
	}

	#scheduleIdleCompaction(): void {
		this.#cancelIdleCompaction();
		if (this.ctx.viewSession.isCompacting) return;

		const idleSettings = settings.getGroup("compaction");
		if (!idleSettings.idleEnabled || this.ctx.editor.getText().trim()) return;

		const threshold = idleSettings.idleThresholdTokens;
		if (threshold <= 0 || this.#currentContextTokens() < threshold) return;

		const timeoutMs = Math.max(60, Math.min(3600, idleSettings.idleTimeoutSeconds)) * 1000;
		this.#idleCompactionTimer = setTimeout(() => {
			this.#idleCompactionTimer = undefined;
			if (this.ctx.viewSession.isStreaming || this.ctx.viewSession.isCompacting) return;
			if (this.ctx.editor.getText().trim() || this.#currentContextTokens() < threshold) return;
			void this.ctx.viewSession.runIdleCompaction();
		}, timeoutMs);
		this.#idleCompactionTimer.unref?.();
	}

	#scheduleIdleRecap(): void {
		this.#cancelIdleRecap();
		if (this.ctx.viewSession.isCompacting) return;

		const recapSettings = settings.getGroup("recap");
		if (!recapSettings.enabled || this.ctx.editor.getText().trim()) return;

		const timeoutMs =
			Math.max(IDLE_RECAP_MIN_SECONDS, Math.min(IDLE_RECAP_MAX_SECONDS, recapSettings.idleSeconds)) * 1000;
		this.#idleRecapTimer = setTimeout(() => {
			this.#idleRecapTimer = undefined;
			void this.#runIdleRecap();
		}, timeoutMs);
		this.#idleRecapTimer.unref?.();
	}

	async #runIdleRecap(): Promise<void> {
		if (!this.#idleConditionsHold()) return;
		if (!this.ctx.viewSession.model || this.ctx.viewSession.messages.length === 0) return;

		const promptText = prompt.render(idleRecapPrompt, {
			goal: this.#idleRecapGoalText() ?? "",
			task: nextActionableTask(this.ctx.todoPhases)?.content ?? "",
		});
		const abort = new AbortController();
		this.#idleRecapAbort = abort;
		try {
			const { replyText } = await this.ctx.viewSession.runEphemeralTurn({ promptText, signal: abort.signal });
			if (this.#idleRecapAbort !== abort || abort.signal.aborted || !this.#idleConditionsHold()) return;
			const recap = previewLine(replyText, TRUNCATE_LENGTHS.RECAP);
			if (!recap) return;
			this.ctx.present(CommandNoticeView({ text: `※ recap: ${recap}`, color: "dim", italic: true }));
		} catch (error) {
			if (!abort.signal.aborted) logger.debug("Idle recap turn failed", { error: String(error) });
		} finally {
			if (this.#idleRecapAbort === abort) this.#idleRecapAbort = undefined;
		}
	}

	#idleConditionsHold(): boolean {
		return (
			!this.ctx.viewSession.isStreaming && !this.ctx.viewSession.isCompacting && !this.ctx.editor.getText().trim()
		);
	}

	#idleRecapGoalText(): string | undefined {
		const goal = this.ctx.viewSession.getGoalModeState?.()?.goal.objective.trim();
		if (goal) return goal;
		const title = this.ctx.sessionManager.getSessionName()?.trim();
		return title || undefined;
	}

	#currentContextTokens(): number {
		return this.ctx.viewSession.getContextUsage()?.tokens ?? 0;
	}

	#settleTool(entry: ToolEntry, event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
		const running = resultAsyncStateIsRunning(event.result);
		entry.model.applyResult({ ...event.result, isError: event.isError }, { partial: running });
		if (entry.readGroup) {
			if (entry.readGroup.state.settle(event.toolCallId) && this.ctx.chatContainer.canRemove(entry.transcriptId)) {
				this.ctx.chatContainer.replace(entry.transcriptId, { state: "settled" });
			}
		} else {
			this.ctx.chatContainer.replace(entry.transcriptId, { state: "settled" });
		}
		this.#pendingCompletions.delete(event.toolCallId);
		this.#pendingUsage?.remainingToolCallIds.delete(event.toolCallId);
		this.#flushPendingUsage();
		// A returned job handle can retire while its model still receives background updates.
		if (running) return;
		this.ctx.pendingTools.delete(event.toolCallId);
		this.#pendingEditPreviews.delete(event.toolCallId);
		this.#settledToolCallIds.add(event.toolCallId);
		this.#toolEntries.delete(event.toolCallId);
	}
}
