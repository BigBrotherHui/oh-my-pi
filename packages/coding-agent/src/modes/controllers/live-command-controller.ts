import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageView } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { LiveVisualizerView, type LivePhase } from "@oh-my-pi/pi-tui/apps/live-visualizer";
import { createSignal } from "@oh-my-pi/pi-tui/reactive";
import { logger } from "@oh-my-pi/pi-utils";
import { LiveSessionController, type LiveSessionControllerOptions, type LiveTranscript } from "../../live/controller";
import { LIVE_MODEL } from "../../live/protocol";
import { vocalizer } from "../../tts/vocalizer";
import type { ReactiveStackEntry } from "../reactive-slots";
import type { InteractiveModeContext } from "../types";

type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSessionController;

const LIVE_MESSAGE_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

/** Owns the reactive visualizer and realtime session lifecycle for `/live`. */
export class LiveCommandController {
	#session: LiveSessionController | undefined;
	#settling: Promise<void> | undefined;
	#savedEditorEntries: readonly ReactiveStackEntry[] | undefined;
	#previousShowHardwareCursor: boolean | undefined;
	#previousUseTerminalCursor: boolean | undefined;
	#assistantEntry: string | undefined;
	#assistantTurn = 0;
	#assistantStartedAt = 0;
	#resumeVocalizer: (() => void) | undefined;
	readonly #phase = createSignal<LivePhase>("connecting");
	readonly #inputLevel = createSignal(0);
	readonly #transcript = createSignal("");

	constructor(
		private readonly ctx: InteractiveModeContext,
		private readonly createSession?: LiveSessionFactory,
	) {}

	get active(): boolean {
		return this.#session !== undefined || this.#settling !== undefined;
	}

	async handleCommand(): Promise<void> {
		if (this.#session) {
			await this.stop();
			return;
		}
		if (this.#settling) await this.#settling;
		await this.#start();
	}

	async stop(): Promise<void> {
		const session = this.#session;
		if (!session) {
			if (this.#settling) await this.#settling;
			return;
		}
		try {
			await session.stop();
		} catch (cause) {
			this.#finish(session, errorFrom(cause));
		} finally {
			this.#finish(session);
		}
	}

	dispose(): void {
		const session = this.#session;
		if (!session) {
			this.#restoreEditor();
			return;
		}
		this.#finish(session);
		void session
			.stop()
			.catch(cause => logger.debug("Live session teardown failed", { error: errorFrom(cause).message }));
	}

	async #start(): Promise<void> {
		this.#assistantTurn = 0;
		this.#assistantStartedAt = 0;
		this.#phase[1]("connecting");
		this.#inputLevel[1](0);
		this.#transcript[1]("");
		this.#savedEditorEntries = this.ctx.editorContainer.entries();
		this.#previousShowHardwareCursor = this.ctx.ui.getShowHardwareCursor();
		this.#previousUseTerminalCursor = this.ctx.editor.getUseTerminalCursor();
		this.ctx.ui.setShowHardwareCursor(false);
		this.ctx.editor.setUseTerminalCursor(false);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.append(() =>
			LiveVisualizerView({
				phase: this.#phase[0],
				inputLevel: this.#inputLevel[0],
				transcript: this.#transcript[0],
				onStop: () => void this.stop().catch(cause => this.ctx.showError(errorFrom(cause).message)),
				onToggleMute: () => this.#session?.toggleMute(),
				stopKeys: this.ctx.keybindings.getKeys("app.live.toggle"),
			}),
		);
		this.#resumeVocalizer = vocalizer.suspend();
		const options: LiveSessionControllerOptions = {
			session: this.ctx.session,
			extractAssistantText: message => this.ctx.extractAssistantText(message),
			voice: this.ctx.settings.get("live.voice"),
			callbacks: {
				onPhase: phase => {
					if (this.#session && this.#session === createdSession) this.#phase[1](phase);
				},
				onLevels: input => {
					if (this.#session && this.#session === createdSession) this.#inputLevel[1](input);
				},
				onTranscript: transcript => {
					if (this.#session && this.#session === createdSession) this.#presentTranscript(transcript);
				},
				onTerminal: error => {
					if (this.#session && this.#session === createdSession) this.#finish(createdSession, error);
				},
			},
		};
		const createdSession = this.createSession ? this.createSession(options) : new LiveSessionController(options);
		this.#session = createdSession;
		try {
			await createdSession.start();
		} catch (cause) {
			if (this.#session === createdSession) this.#finish(createdSession, errorFrom(cause));
		}
	}

	#presentTranscript(transcript: LiveTranscript | undefined): void {
		if (!transcript) {
			this.#transcript[1]("");
			return;
		}
		if (transcript.role === "user") {
			this.#transcript[1](transcript.text);
			return;
		}
		if (transcript.turn > this.#assistantTurn) {
			this.#finalizeAssistantTranscript();
			this.#assistantTurn = transcript.turn;
		}
		this.#assistantStartedAt ||= Date.now();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: transcript.text }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: LIVE_MODEL,
			usage: { ...LIVE_MESSAGE_USAGE },
			stopReason: "stop",
			timestamp: this.#assistantStartedAt,
		};
		const view = () =>
			AssistantMessageView({ message, expanded: () => this.ctx.toolOutputExpanded, showImages: false });
		if (!this.#assistantEntry) {
			this.#assistantEntry = `live:${this.#assistantStartedAt}`;
			this.ctx.chatContainer.append({ id: this.#assistantEntry, view, state: "active" });
		} else {
			this.ctx.chatContainer.replace(this.#assistantEntry, { view, state: transcript.final ? "settled" : "active" });
		}
		if (transcript.final) this.#finalizeAssistantTranscript();
	}

	#finalizeAssistantTranscript(): void {
		if (this.#assistantEntry) this.ctx.chatContainer.replace(this.#assistantEntry, { state: "settled" });
		this.#assistantEntry = undefined;
		this.#assistantStartedAt = 0;
	}

	#finish(session: LiveSessionController, error?: Error): void {
		if (this.#session !== session) return;
		this.#session = undefined;
		this.#restoreEditor();
		if (error) this.ctx.showError(error.message);
		const settling = session
			.stop()
			.catch(cause => logger.debug("Live session cleanup failed", { error: errorFrom(cause).message }));
		this.#settling = settling;
		void settling.finally(() => {
			if (this.#settling === settling) this.#settling = undefined;
		});
	}

	#restoreEditor(): void {
		this.#finalizeAssistantTranscript();
		const entries = this.#savedEditorEntries;
		this.#savedEditorEntries = undefined;
		if (entries) {
			this.ctx.editorContainer.clear();
			for (const entry of entries) this.ctx.editorContainer.append(entry.content);
		}
		if (this.#previousShowHardwareCursor !== undefined) {
			this.ctx.ui.setShowHardwareCursor(this.#previousShowHardwareCursor);
		}
		if (this.#previousUseTerminalCursor !== undefined) {
			this.ctx.editor.setUseTerminalCursor(this.#previousUseTerminalCursor);
		}
		this.#previousShowHardwareCursor = undefined;
		this.#previousUseTerminalCursor = undefined;
		this.#resumeVocalizer?.();
		this.#resumeVocalizer = undefined;
	}
}
