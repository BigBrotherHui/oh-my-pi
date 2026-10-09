import { describe, expect, it } from "bun:test";
import type { AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ExplorationProgressGuard } from "@oh-my-pi/pi-coding-agent/session/exploration-progress-guard";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";

const model = createMockModel({ provider: "openai", id: "test" }).model;
let sequence = 0;
function call(args: Record<string, unknown> = { path: "a.ts" }, name = "read"): ToolCall {
	return { type: "toolCall", id: String(sequence++), name, arguments: args };
}
function turn(calls: ToolCall[], text = "evidence", error = false): AgentTurnEndContext {
	return {
		message: {
			role: "assistant",
			content: calls,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
		toolResults: calls.map(c => ({
			role: "toolResult",
			toolCallId: c.id,
			toolName: c.name,
			content: [{ type: "text", text }],
			isError: error,
			timestamp: Date.now(),
		})),
		willContinue: true,
	};
}
function restrict(guard: ExplorationProgressGuard): void {
	for (let n = 0; n < 5; n++) guard.recordTurn(turn([call()]), 3);
}

describe("ExplorationProgressGuard", () => {
	it("nudges once after many read-only calls that keep finding new evidence without blocking", () => {
		const g = new ExplorationProgressGuard();
		const stages: (string | undefined)[] = [];
		for (let n = 0; n < 50; n++)
			stages.push(g.recordTurn(turn([call({ path: `f${n}.ts` })], `evidence ${n}`), 3, 45)?.stage);
		expect(stages.filter(s => s === "nudge")).toHaveLength(1);
		expect(stages.filter(s => s === "warning" || s === "restrict")).toHaveLength(0);
		// The nudge is advisory: an unseen target is never blocked, and it fires once.
		expect(g.shouldBlock(call({ path: "brand-new.ts" }))).toBe(false);
		for (let n = 0; n < 10; n++)
			expect(g.recordTurn(turn([call({ path: `g${n}.ts` })], `more ${n}`), 3, 45)).toBeUndefined();
	});

	it("resets the read-only checkpoint on any non-read tool, so coding work is unaffected", () => {
		const g = new ExplorationProgressGuard();
		for (let n = 0; n < 44; n++)
			expect(g.recordTurn(turn([call({ path: `f${n}.ts` })], `e${n}`), 3, 45)).toBeUndefined();
		expect(g.recordTurn(turn([call({ path: "answer.txt" }, "write")], "wrote"), 3, 45)).toBeUndefined();
		for (let n = 0; n < 44; n++)
			expect(g.recordTurn(turn([call({ path: `f${n}.ts` })], `e${n}`), 3, 45)).toBeUndefined();
		expect(g.shouldBlock(call())).toBe(false);
	});

	it("records no checkpoint when the threshold is disabled", () => {
		const g = new ExplorationProgressGuard();
		for (let n = 0; n < 80; n++)
			expect(g.recordTurn(turn([call({ path: `f${n}.ts` })], `e${n}`), 3, 0)).toBeUndefined();
	});

	it("warns then blocks unchanged large results even when repeated targets alternate", () => {
		const g = new ExplorationProgressGuard();
		const results = [];
		for (let n = 0; n < 6; n++)
			results.push(g.recordTurn(turn([call({ path: `${n % 2}.ts` })], "x".repeat(10000)), 3)?.stage);
		expect(results.filter(Boolean)).toEqual(["warning", "restrict"]);
		expect(g.shouldBlock(call({ path: "0.ts", i: "different explanation" }))).toBe(true);
		expect(g.shouldBlock(call({ path: "0.ts", offset: 300 }))).toBe(false);
		expect(g.shouldBlock(call({ path: "0.ts" }))).toBe(false);
	});
	it("permits over 45 changing results, ranges and pages including short useful evidence", () => {
		const g = new ExplorationProgressGuard();
		for (let n = 0; n < 60; n++) {
			expect(g.recordTurn(turn([call()], String(n)), 3)).toBeUndefined();
			expect(g.recordTurn(turn([call({ path: "a.ts", offset: n, page: n })], "id"), 3)).toBeUndefined();
		}
		expect(g.shouldBlock(call())).toBe(false);
	});
	it("treats error recovery and changed empty search results as new evidence", () => {
		const g = new ExplorationProgressGuard();
		for (let n = 0; n < 4; n++) g.recordTurn(turn([call()], "timeout", true), 3);
		expect(g.recordTurn(turn([call()], "found"), 3)).toBeUndefined();
		expect(g.recordTurn(turn([call({ pattern: "missing" }, "grep")], ""), 3)).toBeUndefined();
		expect(g.recordTurn(turn([call({ pattern: "other" }, "grep")], ""), 3)).toBeUndefined();
		expect(g.shouldBlock(call())).toBe(false);
	});
	it("resets warnings after progress and does not carry restrictions into another run", () => {
		const g = new ExplorationProgressGuard();
		for (let n = 0; n < 4; n++) g.recordTurn(turn([call()]), 3);
		g.recordTurn(turn([call()], "new evidence"), 3);
		for (let n = 0; n < 2; n++) expect(g.recordTurn(turn([call()], "new evidence"), 3)).toBeUndefined();
		expect(g.recordTurn(turn([call()], "new evidence"), 3)?.stage).toBe("warning");
		expect(g.recordTurn(turn([call()], "new evidence"), 3)?.stage).toBe("restrict");
		g.resetRun();
		expect(g.shouldBlock(call())).toBe(false);
	});
	it("does not penalize mixed edits, tests, bash, or unknown and similarly named MCP tools", () => {
		for (const name of ["edit", "write", "bash", "test", "mcp__other_search", "mcp__ai_memory_create_list"]) {
			const g = new ExplorationProgressGuard();
			restrict(g);
			expect(g.shouldBlock(call({}, name))).toBe(false);
			expect(g.shouldBlock(call())).toBe(false);
			for (let n = 0; n < 8; n++) expect(g.recordTurn(turn([call(), call({}, name)]), 3)).toBeUndefined();
		}
	});
	it("uses canonical names for explicitly read-only MCP methods", () => {
		const g = new ExplorationProgressGuard();
		const name = createMCPToolName("codebase-memory-mcp", "search_graph");
		for (let n = 0; n < 5; n++) g.recordTurn(turn([call({ project: "Dental", query: "node" }, name)]), 3);
		expect(g.shouldBlock(call({ query: "node", project: "Dental" }, name))).toBe(true);
	});
	it("missing or multimodal results clear debt; blocked results cannot masquerade as new evidence", () => {
		const g = new ExplorationProgressGuard();
		restrict(g);
		const repeated = call();
		expect(g.shouldBlock(repeated)).toBe(true);
		g.recordTurn(turn([repeated], "blocked", true), 3);
		expect(g.shouldBlock(call())).toBe(true);
		const missing = turn([call()]);
		missing.toolResults = [];
		g.recordTurn(missing, 3);
		expect(g.shouldBlock(call())).toBe(false);
		restrict(g);
		const image = turn([call()]);
		image.toolResults[0]!.content = [{ type: "image", data: "AA==", mimeType: "image/png" }];
		g.recordTurn(image, 3);
		expect(g.shouldBlock(call())).toBe(false);
	});
});
