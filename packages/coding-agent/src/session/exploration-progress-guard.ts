import type { AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { createMCPToolName } from "../mcp/tool-bridge";

const BUILTIN_READ_TOOLS = new Set(["read", "grep", "glob", "find"]);
const MCP_READ_TOOLS = new Set([
	...["list_projects", "index_status", "search_graph", "trace_path", "get_code_snippet", "check_index_coverage"].map(
		name => createMCPToolName("codebase-memory-mcp", name),
	),
	...["memory_briefing", "memory_search", "memory_get"].map(name => createMCPToolName("ai-memory", name)),
]);
const HISTORY_LIMIT = 512;

export interface ExplorationDetection {
	stage: "warning" | "restrict";
	turns: number;
}

function targetKey(call: Pick<ToolCall, "name" | "arguments">): string {
	const args = { ...call.arguments };
	delete args[INTENT_FIELD];
	delete args.__intent;
	return `${call.name}:${Bun.SHA256.hash(stableStringifyJson(args), "hex")}`;
}

/** Restricts only previously observed read-only requests after repeated unchanged results. */
export class ExplorationProgressGuard {
	readonly #evidence = new Map<string, string>();
	readonly #deniedCalls = new Set<string>();
	#idleTurns = 0;
	#warned = false;
	#restricted = false;

	resetRun(): void {
		this.#evidence.clear();
		this.#deniedCalls.clear();
		this.#resetEpisode();
	}

	#resetEpisode(): void {
		this.#idleTurns = 0;
		this.#warned = false;
		this.#restricted = false;
	}

	#isReadOnly(name: string): boolean {
		return BUILTIN_READ_TOOLS.has(name) || MCP_READ_TOOLS.has(name);
	}

	shouldBlock(call: ToolCall): boolean {
		if (!this.#isReadOnly(call.name)) {
			this.resetRun();
			return false;
		}
		if (!this.#restricted) return false;
		try {
			if (!this.#evidence.has(targetKey(call))) {
				this.#resetEpisode();
				return false;
			}
		} catch {
			this.resetRun();
			return false;
		}
		this.#deniedCalls.add(call.id);
		return true;
	}

	recordTurn(context: AgentTurnEndContext, threshold: number): ExplorationDetection | undefined {
		if (context.message.role !== "assistant") return undefined;
		const calls = context.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (!context.willContinue || calls.length === 0 || !calls.every(call => this.#isReadOnly(call.name))) {
			this.resetRun();
			return undefined;
		}
		const results = new Map(context.toolResults.map(result => [result.toolCallId, result]));
		const observations: [string, string][] = [];
		let progress = false;
		try {
			for (const call of calls) {
				if (this.#deniedCalls.delete(call.id)) continue;
				const result = results.get(call.id);
				// Missing, multimodal or non-JSON evidence cannot safely establish repetition.
				if (!result || result.content.some(block => block.type !== "text")) {
					this.resetRun();
					return undefined;
				}
				const key = targetKey(call);
				const details = result.details;
				const readEvidence =
					call.name === "read" &&
					details !== null &&
					typeof details === "object" &&
					"repeatReadEvidenceHash" in details &&
					typeof details.repeatReadEvidenceHash === "string"
						? details.repeatReadEvidenceHash
						: undefined;
				const fingerprint = Bun.SHA256.hash(
					stableStringifyJson([
						readEvidence ?? result.content,
						result.isError,
						result.useless,
						readEvidence ? null : (result.details ?? null),
					]),
					"hex",
				);
				if (this.#evidence.get(key) !== fingerprint) progress = true;
				observations.push([key, fingerprint]);
			}
		} catch {
			this.resetRun();
			return undefined;
		}
		for (const [key, fingerprint] of observations) {
			this.#evidence.delete(key);
			this.#evidence.set(key, fingerprint);
		}
		while (this.#evidence.size > HISTORY_LIMIT) this.#evidence.delete(this.#evidence.keys().next().value!);
		if (progress) {
			this.#resetEpisode();
			return undefined;
		}
		this.#idleTurns++;
		const window = Number.isFinite(threshold) ? Math.max(2, Math.trunc(threshold)) : 3;
		if (this.#idleTurns < window || this.#restricted) return undefined;
		if (!this.#warned) {
			this.#warned = true;
			return { stage: "warning", turns: this.#idleTurns };
		}
		this.#restricted = true;
		return { stage: "restrict", turns: this.#idleTurns };
	}
}
