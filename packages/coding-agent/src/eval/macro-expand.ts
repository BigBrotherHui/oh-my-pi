/**
 * Wires inline macro expansion onto the agent's finalized-assistant-message
 * hook. Walks a finalized {@link AssistantMessage}, resolves every registered
 * inline macro token in its text blocks and tool-call arguments against the live
 * eval kernel that owns that macro, and splices the values in place.
 *
 * Runs once per message at finalization (the "freeze once the block is
 * complete" point) and shares a per-session value cache, so the renderer never
 * re-evaluates on redraw. Resolution only targets macros registered by
 * `defmacro`; unknown names never cold-start or probe a kernel.
 */

import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { hasLiveJsSession } from "./js/context-manager";
import { executeJs } from "./js/executor";
import { namespaceSessionId as namespaceJsSessionId } from "./js/index";
import {
	type MacroBatchRunner,
	type MacroCache,
	type MacroOutcome,
	type MacroRunners,
	type MacroSpec,
	resolveMacros,
} from "./macro-evaluator";
import { lookupMacroDefinition } from "./macro-registry";
import { expandMacros, type MacroRef, scanMacros } from "./macro-syntax";
import { executePythonWithKernel, peekLivePythonKernel } from "./py/executor";
import { namespaceSessionId as namespacePythonSessionId } from "./py/index";
import { defaultEvalSessionId } from "./session-id";

/** Upper bound on a single macro batch round-trip so a hung macro never stalls the turn. */
const MACRO_TIMEOUT_MS = 5_000;

type JsonDisplay = { type: string; data?: unknown };

/** Find the trailing JSON display output and normalize it into ordered outcomes. */
function parseOutcomes(displayOutputs: readonly JsonDisplay[]): MacroOutcome[] | null {
	for (let i = displayOutputs.length - 1; i >= 0; i -= 1) {
		const output = displayOutputs[i];
		if (output.type === "json" && Array.isArray(output.data)) {
			return output.data.map(normalizeOutcome);
		}
	}
	return null;
}

function normalizeOutcome(raw: unknown): MacroOutcome {
	if (raw && typeof raw === "object") {
		const record = raw as Record<string, unknown>;
		if (record.ok === true) return { ok: true, value: record.value };
		if (typeof record.error === "string") return { ok: false, error: record.error };
	}
	return { ok: false, error: "macro evaluation produced no result" };
}

function specPayload(specs: MacroSpec[]): string {
	return JSON.stringify(specs.map(spec => [spec.name, spec.args]));
}

function pythonSpecPayload(specs: MacroSpec[]): string {
	return `__import__("json").loads(${JSON.stringify(specPayload(specs))})`;
}

/** Recursively map every string leaf of a value, returning a new value. */
function mapStringsDeep(value: unknown, fn: (s: string) => string): unknown {
	if (typeof value === "string") return fn(value);
	if (Array.isArray(value)) return value.map(item => mapStringsDeep(item, fn));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = mapStringsDeep(item, fn);
		return out;
	}
	return value;
}

/** Visit every macro-bearing string in the message (text blocks + tool-call args). */
function forEachString(message: AssistantMessage, fn: (s: string) => void): void {
	for (const block of message.content) {
		if (block.type === "text") {
			fn(block.text);
		} else if (block.type === "toolCall") {
			mapStringsDeep(block.arguments, s => {
				fn(s);
				return s;
			});
		}
	}
}

/**
 * Build a `transformAssistantMessage` hook bound to `session`. The returned
 * function mutates the message in place and never throws (a failure leaves the
 * offending macro literal).
 */
export function createMacroExpander(
	session: ToolSession,
): (message: AssistantMessage, signal?: AbortSignal) => Promise<void> {
	const cache: MacroCache = new Map();

	const buildRunners = (base: string, cwd: string, signal?: AbortSignal): MacroRunners => {
		const py: MacroBatchRunner = async specs => {
			const sessionId = namespacePythonSessionId(base);
			const kernel = peekLivePythonKernel(sessionId, cwd);
			if (!kernel) return null;
			// Emit an explicit application/json bundle: the runner's auto-display of a
			// bare list only yields text/plain, so wrap it so the result is captured
			// as a JSON display output. `__omp_display` (raw) bypasses any user shadow
			// of `display`.
			const code = `__omp_display({"application/json": __omp_eval_macros(${pythonSpecPayload(specs)})}, raw=True)`;
			const result = await executePythonWithKernel(kernel, code, {
				cwd,
				sessionId,
				signal,
				timeoutMs: MACRO_TIMEOUT_MS,
			});
			return parseOutcomes(result.displayOutputs);
		};

		const js: MacroBatchRunner = async specs => {
			const sessionId = namespaceJsSessionId(base);
			if (!hasLiveJsSession(sessionId)) return null;
			const result = await executeJs(`__omp_eval_macros(${specPayload(specs)})`, {
				cwd,
				sessionId,
				session,
				signal,
				timeoutMs: MACRO_TIMEOUT_MS,
			});
			return parseOutcomes(result.displayOutputs);
		};

		return { py, js };
	};

	return async (message, signal) => {
		try {
			// Fast path + ref collection: skip all kernel work when nothing matches.
			const refs: MacroRef[] = [];
			forEachString(message, s => {
				if (s.includes("@[[")) refs.push(...scanMacros(s));
			});
			if (refs.length === 0) return;

			const base = session.getEvalSessionId?.() ?? defaultEvalSessionId(session);
			const cwd = session.cwd;
			const ambiguous = new Set<string>();
			const resolved = await resolveMacros(
				refs,
				name => {
					const lookup = lookupMacroDefinition(base, cwd, name);
					if (lookup.status === "ambiguous" && !ambiguous.has(name)) {
						ambiguous.add(name);
						logger.warn("macro name registered by multiple runtimes", { name });
					}
					return lookup;
				},
				buildRunners(base, cwd, signal),
				cache,
			);
			if (resolved.size === 0) return;
			const resolve = (ref: MacroRef): string | undefined => resolved.get(ref.key);

			for (const block of message.content) {
				if (block.type === "text") {
					block.text = expandMacros(block.text, resolve);
				} else if (block.type === "toolCall") {
					block.arguments = mapStringsDeep(block.arguments, s => expandMacros(s, resolve)) as Record<
						string,
						unknown
					>;
				}
			}
		} catch (err) {
			// Macro expansion must never break a turn; leave the message as-is.
			logger.warn("macro expansion failed", { error: err instanceof Error ? err.message : String(err) });
		}
	};
}
