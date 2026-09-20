import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { BusyView } from "../../../src/modes/components/reactive-controller-views";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { createReactiveStack } from "@oh-my-pi/pi-coding-agent/modes/reactive-slots";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

describe("/handoff command", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows a cancellable loader while handoff generation is running", async () => {
		const handoffStarted = Promise.withResolvers<void>();
		const handoffDone = Promise.withResolvers<{ document: string }>();
		let isGeneratingHandoff = false;
		const statusContainer = createReactiveStack();
		const abortHandoff = vi.fn();
		// InputController installs the real Esc handler; CommandController should
		// leave it in place while showing the handoff loader.
		const originalOnEscape = vi.fn(() => {
			if (isGeneratingHandoff) abortHandoff();
		});
		const resetDisplay = vi.fn();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				handoff: vi.fn(async () => {
					isGeneratingHandoff = true;
					handoffStarted.resolve();
					try {
						return await handoffDone.promise;
					} finally {
						isGeneratingHandoff = false;
					}
				}),
				abortHandoff,
			},
			loadingAnimation: undefined,
			statusContainer,
			ui: { resetDisplay },
			editor: { onEscape: originalOnEscape },
			rebuildChatFromMessages: vi.fn(),
			statusLine: { ingestSession: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		const commandPromise = controller.handleHandoffCommand("focus on tests");
		await handoffStarted.promise;

		expect(statusContainer.entries()).toHaveLength(1);
		expect(ctx.editor.onEscape).toBe(originalOnEscape);
		ctx.editor.onEscape?.();
		expect(abortHandoff).toHaveBeenCalledTimes(1);

		handoffDone.resolve({ document: "## Goal\nContinue" });
		await commandPromise;

		expect(statusContainer.entries()).toHaveLength(0);
		expect(ctx.editor.onEscape).toBe(originalOnEscape);
		expect(ctx.session.handoff).toHaveBeenCalledWith("focus on tests");
	});

	it("clears a working loader mounted while the completed handoff rebuilds the transcript", async () => {
		const statusContainer = createReactiveStack();
		let lateWorkingLoader: string | undefined;
		let loadingAnimation: string | undefined;
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				isStreaming: false,
				handoff: vi.fn(async () => ({ document: "## Goal\nContinue" })),
			},
			get loadingAnimation() {
				return loadingAnimation;
			},
			set loadingAnimation(value: string | undefined) {
				loadingAnimation = value;
			},
			statusContainer,
			ui: { resetDisplay: vi.fn() },
			clearTransientSessionUi: vi.fn(() => {
				loadingAnimation = undefined;
				statusContainer.clear();
			}),
			renderInitialMessages: vi.fn(async () => {
				// Simulate a delayed agent_start event landing while transcript replay yields.
				lateWorkingLoader = statusContainer.append(BusyView({ message: "Working…" }));
				loadingAnimation = lateWorkingLoader;
			}),
			statusLine: { ingestSession: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			present: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(lateWorkingLoader).toBeDefined();
		expect(loadingAnimation).toBeUndefined();
		expect(statusContainer.entries()).toHaveLength(0);
	});

	it("recreates a fresh working loader when a new turn is streaming after handoff", async () => {
		const statusContainer = createReactiveStack();
		let staleWorkingLoader = "";
		let freshWorkingLoader = "";
		let loadingAnimation: string | undefined;
		let isStreaming = false;
		let loaderAtEnsureCall: string | undefined | "unset" = "unset";
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				get isStreaming() {
					return isStreaming;
				},
				handoff: vi.fn(async () => ({ document: "## Goal\nContinue" })),
			},
			get loadingAnimation() {
				return loadingAnimation;
			},
			set loadingAnimation(value: string | undefined) {
				loadingAnimation = value;
			},
			statusContainer,
			ui: { resetDisplay: vi.fn() },
			clearTransientSessionUi: vi.fn(() => {
				loadingAnimation = undefined;
				statusContainer.clear();
			}),
			renderInitialMessages: vi.fn(async () => {
				// A new turn begins and a delayed agent_start mounts its loader while
				// handoff cleanup is still running.
				isStreaming = true;
				staleWorkingLoader = statusContainer.append(BusyView({ message: "Working…" }));
				loadingAnimation = staleWorkingLoader;
			}),
			ensureLoadingAnimation: vi.fn(() => {
				loaderAtEnsureCall = loadingAnimation;
				freshWorkingLoader = statusContainer.append(BusyView({ message: "Working…" }));
				loadingAnimation = freshWorkingLoader;
			}),
			statusLine: { ingestSession: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			present: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		// The replay's stale entry must be dropped before ensureLoadingAnimation
		// builds a fresh row for the newly-streaming turn.
		expect(staleWorkingLoader).not.toBe("");
		expect(loaderAtEnsureCall).toBeUndefined();
		expect(ctx.ensureLoadingAnimation).toHaveBeenCalledTimes(1);
		expect(loadingAnimation).toBe(freshWorkingLoader);
		expect(statusContainer.entries().map(entry => entry.id)).toEqual([freshWorkingLoader]);
	});

	it("preserves a retry loader that replaces the handoff overlay during replay", async () => {
		const statusContainer = createReactiveStack();
		let isStreaming = false;
		let activeRetryLoader = "";
		const ensureLoadingAnimation = vi.fn();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				get isStreaming() {
					return isStreaming;
				},
				handoff: vi.fn(async () => ({ document: "## Goal\nContinue" })),
			},
			loadingAnimation: undefined,
			autoCompactionLoader: undefined,
			get retryLoader() {
				return activeRetryLoader;
			},
			set retryLoader(value: string | undefined) {
				activeRetryLoader = value ?? "";
			},
			statusContainer,
			ui: { resetDisplay: vi.fn() },
			clearTransientSessionUi: vi.fn(() => {
				statusContainer.clear();
			}),
			renderInitialMessages: vi.fn(async () => {
				isStreaming = true;
				activeRetryLoader = statusContainer.append(BusyView({ message: "Retrying…" }));
			}),
			ensureLoadingAnimation,
			statusLine: { ingestSession: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			present: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(statusContainer.entries().map(entry => entry.id)).toEqual([activeRetryLoader]);
		expect(activeRetryLoader).not.toBe("");
		expect(ensureLoadingAnimation).not.toHaveBeenCalled();
	});

	it("surfaces a provider failure named AbortError as a real error, not a cancellation", async () => {
		// Regression: the catch used to map any name==="AbortError" error to
		// "Handoff cancelled". session.handoff() now normalizes genuine cancellations
		// to the exact "Handoff cancelled" message and re-throws real provider failures
		// verbatim, so the controller must report those as a failure.
		const providerError = new Error("Deepseek stream stalled");
		providerError.name = "AbortError";
		const showError = vi.fn();
		const statusContainer = createReactiveStack();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				handoff: vi.fn(async () => {
					throw providerError;
				}),
				abortHandoff: vi.fn(),
			},
			loadingAnimation: undefined,
			statusContainer,
			ui: { resetDisplay: vi.fn() },
			editor: { onEscape: vi.fn() },
			showError,
			showStatus: vi.fn(),
			showWarning: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(showError).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith("Handoff failed: Deepseek stream stalled");
	});

	it("refuses to hand off while a response is streaming", async () => {
		// Bug: /handoff dispatches before the streaming-queue branch, so without a
		// guard it resets the agent mid-turn and the live stream keeps emitting into
		// the torn-down session. Streaming must short-circuit with a warning.
		const handoff = vi.fn();
		const showWarning = vi.fn();
		const statusContainer = createReactiveStack();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: { isStreaming: true, handoff },
			loadingAnimation: undefined,
			statusContainer,
			ui: { resetDisplay: vi.fn() },
			showWarning,
			showError: vi.fn(),
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(handoff).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledTimes(1);
		expect(statusContainer.entries()).toHaveLength(0);
	});

	it("preserves idle auto-compaction UI instead of starting handoff", async () => {
		const statusContainer = createReactiveStack();
		const autoCompactionLoader = statusContainer.append(BusyView({ message: "Compacting context…" }));
		const handoff = vi.fn(async () => {
			throw new Error("Compaction already in progress");
		});
		const showWarning = vi.fn();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: { isStreaming: false, isCompacting: true, handoff },
			loadingAnimation: undefined,
			autoCompactionLoader,
			retryLoader: undefined,
			statusContainer,
			ui: { resetDisplay: vi.fn() },
			showWarning,
			showError: vi.fn(),
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(handoff).not.toHaveBeenCalled();
		expect(statusContainer.entries().map(entry => entry.id)).toEqual([autoCompactionLoader]);
		expect(showWarning).toHaveBeenCalledWith(
			"Wait for context compaction to finish or cancel it before handing off.",
		);
	});
});
