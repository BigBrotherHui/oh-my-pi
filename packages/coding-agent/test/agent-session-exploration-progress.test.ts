import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

interface Request {
	tool: string;
	args: Record<string, unknown>;
}

type Response = Request | { answer: string };

interface Execution extends Request {
	id: string;
}

interface Observation {
	results: ToolResultMessage[];
	stages: unknown[];
	loopRedirects: number;
	executed: Execution[];
}

const repeatedRead: Request = { tool: "read", args: { path: "src/repeated.ts" } };
const usefulWrite: Request = {
	tool: "write",
	args: { path: "answer.txt", content: "A grounded answer from the available evidence." },
};

function resultText(result: ToolResultMessage): string {
	return result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

describe("AgentSession exploration progress", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-exploration-progress-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("openai", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	function buildSession(options: {
		respond: (observation: Observation) => Response;
		settings?: Record<string, unknown>;
		readEvidence?: (execution: Execution, readCount: number) => string;
		extensionRunner?: ExtensionRunner;
		trimReadPath?: boolean;
	}): {
		executed: Execution[];
		observations: Observation[];
		run: (text: string) => Promise<Observation>;
	} {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const executed: Execution[] = [];
		const observations: Observation[] = [];
		const schema = type({ "path?": "string", "command?": "string", "content?": "string" });
		const trimmedSchema = type({ "path?": "string.trim", "command?": "string", "content?": "string" });
		let readCount = 0;
		const tools: AgentTool<typeof schema>[] = ["read", "write", "bash", "inspect"].map(name => ({
			name,
			label: name,
			description: `Test ${name} tool`,
			parameters: name === "read" && options.trimReadPath ? trimmedSchema : schema,
			async execute(id, args) {
				const execution: Execution = { id, tool: name, args };
				executed.push(execution);
				const text =
					name === "read"
						? (options.readEvidence?.(execution, ++readCount) ??
							`Evidence for ${args.path}: export const value = 1;`)
						: `${name} completed successfully`;
				return { content: [{ type: "text" as const, text }] };
			},
		}));
		let runNumber = 0;
		let runPrefix = "";
		let requestCount = 0;
		let firstMessage = 0;
		let firstExecution = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				// Fail a runaway model instead of supplying a scheduled final answer.
				// The repeated-read scenarios can finish only after a real blocked result.
				if (++requestCount > 100) throw new Error("Test model exceeded 100 requests without observing convergence");
				const customMessages = agent.state.messages
					.slice(firstMessage)
					.filter((message): message is CustomMessage => message.role === "custom");
				const observation: Observation = {
					results: context.messages.filter(
						(message): message is ToolResultMessage =>
							message.role === "toolResult" && message.toolCallId.startsWith(runPrefix),
					),
					stages: customMessages
						.filter(message => message.customType === "exploration-progress-wrapup")
						.map(message => message.details),
					loopRedirects: customMessages.filter(message => message.customType === "tool-call-loop-redirect").length,
					executed: executed.slice(firstExecution),
				};
				observations.push(observation);
				const response = options.respond(observation);
				const toolTurn = "tool" in response;
				const message: AssistantMessage = {
					...createAssistantMessage(toolTurn ? "" : response.answer),
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: toolTurn
						? [
								{
									type: "toolCall",
									id: `${runPrefix}${requestCount}`,
									name: response.tool,
									arguments: response.args,
								},
							]
						: [{ type: "text", text: response.answer }],
					stopReason: toolTurn ? "toolUse" : "stop",
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
			"retry.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": false,
			// Leave the enabled settings and exploration window unset to exercise
			// default convergence, including the emergency budget being opt-in.
			...options.settings,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const built = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			extensionRunner: options.extensionRunner,
		});
		session = built;
		return {
			executed,
			observations,
			async run(text) {
				runPrefix = `run-${++runNumber}-`;
				requestCount = 0;
				firstMessage = agent.state.messages.length;
				firstExecution = executed.length;
				await built.prompt(text);
				await built.waitForIdle();
				return observations.at(-1)!;
			},
		};
	}

	function expectFinalAnswer(text: string): void {
		const lastAssistant = session!.agent.state.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(lastAssistant?.stopReason).toBe("stop");
		expect(lastAssistant?.content).toEqual([{ type: "text", text }]);
	}

	for (const window of [undefined, 2]) {
		it(`warns before blocking a repeated read and lets a useful write finish (${window ?? "default"} window)`, async () => {
			const answer = "Finished using the blocked-read feedback and the successful write.";
			const harness = buildSession({
				settings: {
					"model.toolCallLoopGuard.enabled": true,
					"model.toolCallLoopGuard.threshold": 2,
					...(window === undefined ? {} : { "model.explorationProgress.window": window }),
				},
				respond: ({ results }) => {
					const blocked = results.find(result => result.toolName === "read" && result.isError);
					if (!blocked) return repeatedRead;
					const write = results.find(result => result.toolName === "write");
					return write && !write.isError ? { answer } : usefulWrite;
				},
			});

			const final = await harness.run("Inspect the evidence and deliver an answer.");
			const warning = harness.observations.find(observation => observation.stages.length === 1)!;
			const restricted = harness.observations.find(observation => observation.stages.length === 2)!;
			const blocked = final.results.filter(result => result.isError);
			expect(warning.stages).toEqual([{ stage: "warning", turns: window ?? 3 }]);
			expect(warning.executed).toHaveLength((window ?? 3) + 1);
			expect(warning.results.every(result => !result.isError)).toBe(true);
			expect(restricted.stages).toEqual([
				{ stage: "warning", turns: window ?? 3 },
				{ stage: "restrict", turns: (window ?? 3) + 1 },
			]);
			expect(restricted.executed).toHaveLength((window ?? 3) + 2);
			expect(restricted.results.every(result => !result.isError)).toBe(true);
			expect(blocked).toHaveLength(1);
			expect(blocked[0]!.toolName).toBe("read");
			expect(resultText(blocked[0]!)).toMatch(/repeat|unchanged|exploration/i);
			// A provider-visible denial must come from beforeToolCall: the denied
			// call never invokes execute, while its subsequent write really does.
			expect(harness.executed.some(execution => execution.id === blocked[0]!.toolCallId)).toBe(false);
			const write = final.results.find(result => result.toolName === "write")!;
			expect(write.isError).toBe(false);
			expect(harness.executed.at(-1)).toEqual({ id: write.toolCallId, ...usefulWrite });
			expect(final.loopRedirects).toBeGreaterThan(0);
			expectFinalAnswer(answer);
		});
	}

	it("allows the same read on a fresh prompt after the previous run was restricted", async () => {
		let freshPrompt = false;
		const harness = buildSession({
			respond: ({ results }) => {
				if (!freshPrompt) {
					return results.some(result => result.isError)
						? { answer: "First run observed a blocked read." }
						: repeatedRead;
				}
				return results.some(result => result.toolName === "read" && !result.isError)
					? { answer: "The fresh prompt read the same evidence successfully." }
					: repeatedRead;
			},
		});
		const first = await harness.run("Read until unchanged exploration is restricted.");
		expect(first.results.filter(result => result.isError)).toHaveLength(1);
		expect(first.stages.at(-1)).toMatchObject({ stage: "restrict" });
		expectFinalAnswer("First run observed a blocked read.");

		freshPrompt = true;
		const second = await harness.run("Read that same file for a new request.");
		expect(second.results).toHaveLength(1);
		expect(second.results[0]!.isError).toBe(false);
		expect(second.executed).toEqual([{ id: second.results[0]!.toolCallId, ...repeatedRead }]);
		expect(second.stages).toEqual([]);
		expectFinalAnswer("The fresh prompt read the same evidence successfully.");
	});

	const progressRequests: Request[] = [
		{ tool: "read", args: { path: "src/new-evidence.ts" } },
		usefulWrite,
		{ tool: "bash", args: { command: "run-useful-check" } },
		{ tool: "inspect", args: { path: "new-evidence" } },
	];
	for (const progress of progressRequests) {
		it(`resets a restriction when ${progress.tool === "read" ? "a new read target" : progress.tool} makes progress`, async () => {
			const answer = "Repeated exploration resumed and was restricted only after a new warning.";
			const harness = buildSession({
				settings: { "model.explorationProgress.window": 2 },
				respond: ({ results, stages }) => {
					if (results.some(result => result.isError)) return { answer };
					const madeProgress = results.some(
						result =>
							result.toolName === progress.tool &&
							resultText(result).includes(
								progress.tool === "read" ? "src/new-evidence.ts" : `${progress.tool} completed`,
							),
					);
					// Switch targets/tools while the restriction is active, before a
					// denied read can itself affect the episode's state.
					return stages.length >= 2 && !madeProgress ? progress : repeatedRead;
				},
			});
			const final = await harness.run("Explore, make progress, and check the old target again.");
			expect(final.stages).toEqual([
				{ stage: "warning", turns: 2 },
				{ stage: "restrict", turns: 3 },
				{ stage: "warning", turns: 2 },
				{ stage: "restrict", turns: 3 },
			]);
			const progressIndex = final.executed.findIndex(
				execution =>
					execution.tool === progress.tool && JSON.stringify(execution.args) === JSON.stringify(progress.args),
			);
			expect(progressIndex).toBeGreaterThan(0);
			const progressResult = final.results.find(result => result.toolCallId === final.executed[progressIndex]!.id)!;
			expect(progressResult.isError).toBe(false);
			const resumedRead = final.executed[progressIndex + 1]!;
			expect(resumedRead).toMatchObject(repeatedRead);
			expect(final.results.find(result => result.toolCallId === resumedRead.id)!.isError).toBe(false);
			expect(final.results.filter(result => result.isError)).toHaveLength(1);
			expect(final.results.at(-1)!.toolName).toBe("read");
			expectFinalAnswer(answer);
		});
	}

	it("keeps repeated reads executable when exploration progress is explicitly disabled", async () => {
		const harness = buildSession({
			settings: {
				"model.explorationProgress.enabled": false,
				"model.toolCallLoopGuard.enabled": true,
				"model.toolCallLoopGuard.threshold": 2,
			},
			respond: ({ results }) =>
				results.filter(result => !result.isError).length >= 12
					? { answer: "All repeated reads completed." }
					: repeatedRead,
		});
		const final = await harness.run("Keep reading with convergence restrictions disabled.");
		expect(final.executed).toHaveLength(12);
		expect(final.results.filter(result => result.isError)).toEqual([]);
		expect(final.stages).toEqual([]);
		expect(final.loopRedirects).toBeGreaterThan(0);
		expectFinalAnswer("All repeated reads completed.");
	});

	it("allows more than 45 new read targets with the exact-repeat guard enabled at threshold two", async () => {
		const harness = buildSession({
			settings: {
				"model.toolCallLoopGuard.enabled": true,
				"model.toolCallLoopGuard.threshold": 2,
				// This small fuse must remain inactive unless explicitly enabled.
				"model.toolCallBudget.soft": 45,
			},
			respond: ({ results }) => {
				const successful = results.filter(result => result.toolName === "read" && !result.isError).length;
				return successful >= 50
					? { answer: "Read all 50 distinct evidence targets." }
					: { tool: "read", args: { path: `src/evidence-${successful}.ts` } };
			},
		});
		const final = await harness.run("Inspect 50 different evidence targets.");
		expect(final.executed).toHaveLength(50);
		expect(new Set(final.executed.map(execution => execution.args.path)).size).toBe(50);
		expect(final.results.filter(result => result.isError)).toEqual([]);
		expect(final.stages).toEqual([]);
		expectFinalAnswer("Read all 50 distinct evidence targets.");
	});

	it("keeps reading changed evidence past 45 calls even after the exact-repeat guard warns", async () => {
		const harness = buildSession({
			settings: {
				"model.toolCallLoopGuard.enabled": true,
				"model.toolCallLoopGuard.threshold": 2,
				"model.toolCallBudget.soft": 45,
			},
			readEvidence: (_execution, readCount) => `Evidence revision ${readCount}`,
			respond: ({ results }) =>
				results.filter(result => !result.isError).length >= 50
					? { answer: "Read 50 changing revisions despite the exact-repeat warning." }
					: repeatedRead,
		});
		const final = await harness.run("Observe changing evidence from the same read request.");
		expect(final.executed).toHaveLength(50);
		expect(final.results.filter(result => result.isError)).toEqual([]);
		expect(new Set(final.results.map(resultText)).size).toBe(50);
		expect(final.stages).toEqual([]);
		expect(final.loopRedirects).toBeGreaterThan(0);
		expectFinalAnswer("Read 50 changing revisions despite the exact-repeat warning.");
	});
});
