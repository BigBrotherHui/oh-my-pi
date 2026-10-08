import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

/**
 * The core loop has no global tool-call cap, so without this budget a model that
 * keeps finding new things to read explores forever and never answers. These
 * tests pin the three observable steps: nothing while under the notice line,
 * one wrap-up steer near the limit, then blocked tools at the limit.
 */
describe("AgentSession tool-call budget", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-tool-call-budget-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function buildSession(options: {
		budget?: number;
		enabled?: boolean;
		toolTurns: number;
	}): { contexts: Context[]; executed: string[]; session: AgentSession; startRun: () => void } {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const executed: string[] = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => {
				executed.push("bash");
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};
		let callCount = 0;
		// The mock provider is session-scoped while a "run" is prompt-scoped, so the
		// test drives the turn counter explicitly instead of letting it drift.
		const startRun = (): void => {
			callCount = 0;
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const toolTurn = callCount < options.toolTurns;
				const toolCallId = `tc-${callCount}`;
				callCount++;
				const message: AssistantMessage = toolTurn
					? {
							role: "assistant",
							content: [
								{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `probe ${callCount}` } },
							],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Final answer." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": false,
			"model.toolCallBudget.enabled": options.enabled ?? true,
			"model.toolCallBudget.soft": options.budget ?? 4,
			"model.toolCallBudget.noticeRatio": 0.5,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const built = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});
		session = built;
		return { contexts, executed, session: built, startRun };
	}

	it("is inert when disabled", async () => {
		const { contexts, executed } = buildSession({ enabled: false, budget: 2, toolTurns: 6 });
		await session!.prompt("go");
		await session!.waitForIdle();
		expect(executed).toHaveLength(6);
		expect(JSON.stringify(contexts.at(-1)!.messages)).not.toContain("tool-call budget");
	});

	it("keeps short runs untouched", async () => {
		const { executed } = buildSession({ budget: 10, toolTurns: 3 });
		await session!.prompt("go");
		await session!.waitForIdle();
		expect(executed).toHaveLength(3);
	});

	it("injects a wrap-up steer past the notice line and blocks tools at the budget", async () => {
		const { contexts, executed } = buildSession({ budget: 4, toolTurns: 8 });
		await session!.prompt("go");
		await session!.waitForIdle();

		// Two calls run, then the notice fires on the third and the budget blocks
		// from the fifth onward, so the model is forced to answer.
		expect(executed.length).toBeLessThan(8);
		const rendered = JSON.stringify(contexts.at(-1)!.messages);
		expect(rendered).toContain("tool-call budget");
		expect(rendered).toContain("Stop exploring");
	});

	it("resets the budget for the next run", async () => {
		const { executed, startRun } = buildSession({ budget: 4, toolTurns: 8 });
		await session!.prompt("first");
		await session!.waitForIdle();
		const firstRun = executed.length;
		expect(firstRun).toBeGreaterThan(0);

		startRun();
		await session!.prompt("second");
		await session!.waitForIdle();
		expect(executed.length).toBeGreaterThan(firstRun);
	});
});
