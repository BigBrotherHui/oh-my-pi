import {
	type Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTurnEndContext,
	createToolScopedAbortReason,
} from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model, ToolCall } from "@oh-my-pi/pi-ai";
import { GeminiHeaderRunDetector } from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { type RepeatedToolCallDetection, ToolCallLoopGuard } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import geminiToolReminderTemplate from "../prompts/system/gemini-tool-call-reminder.md" with { type: "text" };
import explorationWrapUpTemplate from "../prompts/system/exploration-progress-wrapup.md" with { type: "text" };
import { ExplorationProgressGuard, type ExplorationDetection } from "./exploration-progress-guard";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";
import {
	renderToolCallLoopRedirect,
	TOOL_CALL_LOOP_REDIRECT_TYPE,
	toolCallLoopRedirectDetails,
} from "./tool-call-loop-redirect";

import { cfgEditStreamingAbort } from "../edit/settings";
import {
	cfgModelExplorationProgressEnabled,
	cfgModelExplorationProgressWindow,
	cfgModelLoopGuardEnabled,
	cfgModelLoopGuardToolCallReminder,
	cfgModelToolCallLoopGuardEnabled,
	cfgModelToolCallLoopGuardExemptTools,
	cfgModelToolCallLoopGuardThreshold,
} from "./settings";

const GEMINI_HEADER_INTERRUPT_REASON = "Interrupted: emit a tool call instead of more planning";
const GEMINI_TOOL_REMINDER_TYPE = "gemini-tool-call-reminder";
// Prefix of the native no-op diagnostic emitted by the Rust edit engine when a
// preview produces byte-identical content. Kept in sync with
// crates/pi-edit/src/modes/replace.rs and crates/pi-edit/src/hashline/preview.rs
// ("No changes would be made to <path>..."). Prefix match (not equality)
// because the Rust messages append the path and mode-specific suffixes.
const NO_CHANGES_PREVIEW_PREFIX = "No changes would be made";

/** Capabilities borrowed by the session's streaming and loop guards. */
export interface StreamGuardsHost {
	agent: Agent;
	settings: Settings;
	sessionManager: SessionManager;
	model(): Model | undefined;
	isDisposed(): boolean;
	promptGeneration(): number;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	schedulePostPromptTask(task: (signal: AbortSignal) => Promise<void>): void;
	discardAssistantTurn(message: AssistantMessage): void;
}

/** Guards streamed edit calls against invalid final previews. */
export class StreamingEditGuard {
	readonly #host: StreamGuardsHost;
	#abortTriggered = false;

	constructor(host: StreamGuardsHost) {
		this.#host = host;
	}

	/** Whether the current turn was aborted by streaming edit validation. */
	get abortTriggered(): boolean {
		return this.#abortTriggered;
	}

	/** Clears all turn-scoped streaming edit state. */
	reset(): void {
		this.#abortTriggered = false;
	}

	/** Aborts an edit when the native engine's final preview reports an error. */
	maybeAbort(event: AgentEvent): void {
		if (
			!cfgEditStreamingAbort.get(this.#host.settings) ||
			this.#abortTriggered ||
			event.type !== "tool_stream_update" ||
			event.toolName !== "edit"
		) {
			return;
		}
		const update = event.update;
		if (
			update === null ||
			typeof update !== "object" ||
			!("streaming" in update) ||
			update.streaming !== false ||
			!("files" in update) ||
			!Array.isArray(update.files)
		) {
			return;
		}
		const files: unknown[] = update.files;
		const failed = files.find(
			(file): file is { path: string; error: string } =>
				file !== null &&
				typeof file === "object" &&
				"path" in file &&
				typeof file.path === "string" &&
				"error" in file &&
				typeof file.error === "string" &&
				file.error.length > 0 &&
				!file.error.startsWith(NO_CHANGES_PREVIEW_PREFIX),
		);
		if (failed) this.#abortPatch(event.toolCallId, failed.path, failed.error);
	}

	#abortPatch(toolCallId: string, filePath: string, error: string): void {
		this.#abortTriggered = true;
		logger.warn("Streaming edit aborted due to patch preview failure", { toolCallId, path: filePath, error });
		const diagnostic = `Streaming edit preview failed for ${filePath}: ${error}`;
		this.#host.agent.abort(
			createToolScopedAbortReason(
				"Streaming edit preview failed",
				{ [toolCallId]: diagnostic },
				"Streaming edit preview failed",
			),
		);
	}
}

/** Detects cross-turn tool loops and Gemini reasoning-header runaways. */
export class LoopGuards {
	readonly #host: StreamGuardsHost;
	#geminiHeaderDetector: GeminiHeaderRunDetector | undefined;
	#toolCallLoopGuard: ToolCallLoopGuard | undefined;
	/** True once the corrective for this loop has been injected at least once. */
	#toolCallLoopRedirectSent = false;
	#toolCallLoopGuardSettingsKey: string | undefined;
	readonly #exploration = new ExplorationProgressGuard();

	constructor(host: StreamGuardsHost) {
		this.#host = host;
	}

	/** Reset run-scoped convergence state for a fresh user prompt. */
	resetRun(): void {
		this.#toolCallLoopRedirectSent = false;
		this.#toolCallLoopGuard = undefined;
		this.#toolCallLoopGuardSettingsKey = undefined;
		this.#geminiHeaderDetector = undefined;
		this.#exploration.resetRun();
	}

	beforeToolCall(call: ToolCall): boolean {
		if (!cfgModelExplorationProgressEnabled.get(this.#host.settings)) {
			this.#exploration.resetRun();
			return false;
		}
		return this.#exploration.shouldBlock(call);
	}

	/** Records completed tool evidence before the next provider request. */
	recordTurn(messages: AgentMessage[], context: AgentTurnEndContext | undefined): void {
		if (context?.message.role !== "assistant") return;
		if (cfgModelExplorationProgressEnabled.get(this.#host.settings)) {
			const exploration = this.#exploration.recordTurn(
				context,
				cfgModelExplorationProgressWindow.get(this.#host.settings),
			);
			if (exploration) this.#injectExplorationWrapUp(messages, exploration);
		} else {
			this.#exploration.resetRun();
		}
		const detection = this.#activeToolCallLoopGuard()?.recordTurn({
			message: context.message,
			toolResults: context.toolResults,
		});
		if (!detection) {
			this.#toolCallLoopRedirectSent = false;
			return;
		}
		if (
			this.#toolCallLoopRedirectSent &&
			detection.count > cfgModelToolCallLoopGuardThreshold.get(this.#host.settings)
		)
			return;
		this.#toolCallLoopRedirectSent = true;
		this.#injectToolCallLoopRedirect(messages, detection);
	}

	/** Feeds a streamed assistant event to the Gemini header-runaway detector. */
	onAssistantEvent(message: AssistantMessage, event: AssistantMessageEvent): void {
		if (event.type === "thinking_start") {
			this.#geminiHeaderDetector = this.#geminiHeaderGuardActive() ? new GeminiHeaderRunDetector() : undefined;
			return;
		}
		const detector = this.#geminiHeaderDetector;
		if (!detector) return;
		if (event.type === "thinking_delta") {
			if (detector.push(event.delta)) this.#interruptGeminiHeaderRunaway(detector.count, message.timestamp);
			return;
		}
		if (event.type === "text_start" || event.type === "toolcall_start") detector.reset();
	}

	#injectExplorationWrapUp(messages: AgentMessage[], detection: ExplorationDetection): void {
		const content = prompt.render(explorationWrapUpTemplate, { turns: detection.turns });
		const message: CustomMessage = {
			role: "custom",
			customType: "exploration-progress-wrapup",
			content,
			display: false,
			details: detection,
			attribution: "agent",
			timestamp: Date.now(),
		};
		messages.push(message);
		if (this.#host.agent.state.messages !== messages) this.#host.agent.appendMessage(message);
		this.#host.sessionManager.appendCustomMessageEntry(
			"exploration-progress-wrapup",
			content,
			false,
			detection,
			"agent",
		);
		this.#host.emitNotice(
			"warning",
			detection.stage === "restrict"
				? "Repeated read requests are restricted; new evidence and other tools remain available."
				: "Read-only exploration repeated unchanged evidence; requested a grounded answer.",
			"exploration-progress",
		);
	}

	#activeToolCallLoopGuard(): ToolCallLoopGuard | undefined {
		if (cfgModelToolCallLoopGuardEnabled.get(this.#host.settings) !== true) {
			this.#toolCallLoopGuard = undefined;
			this.#toolCallLoopGuardSettingsKey = undefined;
			return undefined;
		}
		const threshold = cfgModelToolCallLoopGuardThreshold.get(this.#host.settings);
		const exemptTools = cfgModelToolCallLoopGuardExemptTools
			.get(this.#host.settings)
			.filter((tool): tool is string => typeof tool === "string" && tool.length > 0);
		const settingsKey = `${threshold}:${JSON.stringify(exemptTools)}`;
		if (!this.#toolCallLoopGuard || this.#toolCallLoopGuardSettingsKey !== settingsKey) {
			this.#toolCallLoopGuard = new ToolCallLoopGuard({ threshold, exemptTools });
			this.#toolCallLoopGuardSettingsKey = settingsKey;
		}
		return this.#toolCallLoopGuard;
	}

	#injectToolCallLoopRedirect(messages: AgentMessage[], detection: RepeatedToolCallDetection): void {
		logger.warn("cross-turn tool-call loop detected", { toolName: detection.toolName, count: detection.count });
		const content = renderToolCallLoopRedirect(detection);
		const details = toolCallLoopRedirectDetails(detection);
		const redirectMessage: CustomMessage = {
			role: "custom",
			customType: TOOL_CALL_LOOP_REDIRECT_TYPE,
			content,
			display: false,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		};
		messages.push(redirectMessage);
		if (this.#host.agent.state.messages !== messages) this.#host.agent.appendMessage(redirectMessage);
		this.#host.sessionManager.appendCustomMessageEntry(
			TOOL_CALL_LOOP_REDIRECT_TYPE,
			content,
			false,
			details,
			"agent",
		);
	}

	#geminiHeaderGuardActive(): boolean {
		const model = this.#host.model();
		return (
			cfgModelLoopGuardEnabled.get(this.#host.settings) === true &&
			cfgModelLoopGuardToolCallReminder.get(this.#host.settings) === true &&
			model !== undefined &&
			model.identity.class === "gemini"
		);
	}

	#interruptGeminiHeaderRunaway(headerCount: number, targetTimestamp: number): void {
		const model = this.#host.model();
		logger.warn("Gemini reasoning-header runaway; interrupting to require a tool call", {
			model: model?.id,
			provider: model?.provider,
			headers: headerCount,
		});
		this.#host.emitNotice(
			"warning",
			`Interrupted ${headerCount} planning headers with no tool call; reminded the model to issue one.`,
			"loop-guard",
		);
		this.#host.agent.abort(GEMINI_HEADER_INTERRUPT_REASON);
		const generation = this.#host.promptGeneration();
		this.#host.schedulePostPromptTask(async signal => {
			if (signal.aborted || this.#host.isDisposed() || this.#host.promptGeneration() !== generation) return;
			await this.#host.agent.waitForIdle();
			if (signal.aborted || this.#host.isDisposed() || this.#host.promptGeneration() !== generation) return;
			const aborted = this.#host.agent.state.messages.findLast(
				(message): message is AssistantMessage =>
					message.role === "assistant" && message.timestamp === targetTimestamp,
			);
			if (aborted) this.#host.discardAssistantTurn(aborted);
			const content = prompt.render(geminiToolReminderTemplate, { count: headerCount });
			const details = { headers: headerCount };
			this.#host.agent.appendMessage({
				role: "custom",
				customType: GEMINI_TOOL_REMINDER_TYPE,
				content,
				display: false,
				details,
				attribution: "agent",
				timestamp: Date.now(),
			});
			this.#host.sessionManager.appendCustomMessageEntry(
				GEMINI_TOOL_REMINDER_TYPE,
				content,
				false,
				details,
				"agent",
			);
			try {
				await this.#host.agent.continue();
			} catch (error) {
				logger.warn("gemini tool-call reminder continue failed", { error: String(error) });
			}
		});
	}
}
