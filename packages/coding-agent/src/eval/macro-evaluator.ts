/**
 * Cache-backed resolution of inline macros ({@link MacroRef}) against the live
 * eval kernels. Pure orchestration: the actual kernel round-trip is supplied as
 * a per-runtime {@link MacroBatchRunner} so this module stays decoupled from the
 * Python/JS executors and is unit-testable with fakes.
 *
 * Caching is per session and stores **successful values only**. A resolved
 * value is frozen for the session/runtime registration revision. Redefining a
 * macro bumps the revision and forces a fresh kernel read, while repeated use of
 * the same registered macro stays stable across re-renders and later messages.
 * Failures are never cached: a macro that is undefined now may be defined by a
 * later eval cell, and should resolve then.
 */

import type { MacroRef, MacroRuntime } from "./macro-syntax";

export interface MacroSpec {
	name: string;
	/** `null` = bare value reference; array = positional call arguments. */
	args: unknown[] | null;
}

export type MacroOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Evaluate a batch of specs in the live kernel for one runtime. Returns outcomes
 * positionally aligned with `specs`, or `null` when no live kernel exists (every
 * spec is then left unresolved). Must not throw for individual macro errors —
 * report them as `{ ok: false }` outcomes.
 */
export type MacroBatchRunner = (specs: MacroSpec[]) => Promise<MacroOutcome[] | null>;

export type MacroRunners = Partial<Record<MacroRuntime, MacroBatchRunner>>;

export type MacroDefinitionLookup =
	| { status: "found"; runtime: MacroRuntime; revision: number }
	| { status: "missing" | "ambiguous" };

export type MacroDefinitionResolver = (name: string) => MacroDefinitionLookup;

export type MacroCacheEntry = { kind: "value"; text: string };
/** Per-session memo of resolved macro values, keyed by runtime + registration revision + syntax. */
export type MacroCache = Map<string, MacroCacheEntry>;

/** Render a resolved macro value as substitution text. */
export function serializeMacroValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

function evaluationKey(ref: MacroRef, definition: Extract<MacroDefinitionLookup, { status: "found" }>): string {
	return `${definition.runtime}:${definition.revision}:${ref.key}`;
}

/**
 * Resolve every ref, consulting and filling `cache`. Returns a syntax `key -> text`
 * map containing only the macros that resolved; unresolved and ambiguous macros
 * are omitted so the caller leaves them literal. Each distinct uncached resolved
 * definition is evaluated once, and runtimes are batched into one kernel round-trip.
 */
export async function resolveMacros(
	refs: MacroRef[],
	resolveDefinition: MacroDefinitionResolver,
	runners: MacroRunners,
	cache: MacroCache,
): Promise<Map<string, string>> {
	const resolved = new Map<string, string>();
	const pending = new Map<MacroRuntime, { cacheKeys: string[]; refKeys: string[]; specs: MacroSpec[] }>();
	const queued = new Set<string>();

	for (const ref of refs) {
		const definition = resolveDefinition(ref.name);
		if (definition.status !== "found") continue;
		const cacheKey = evaluationKey(ref, definition);
		const hit = cache.get(cacheKey);
		if (hit) {
			resolved.set(ref.key, hit.text);
			continue;
		}
		if (queued.has(cacheKey)) continue;
		queued.add(cacheKey);
		let bucket = pending.get(definition.runtime);
		if (!bucket) {
			bucket = { cacheKeys: [], refKeys: [], specs: [] };
			pending.set(definition.runtime, bucket);
		}
		bucket.cacheKeys.push(cacheKey);
		bucket.refKeys.push(ref.key);
		bucket.specs.push({ name: ref.name, args: ref.args });
	}

	if (pending.size === 0) return resolved;

	await Promise.all(
		[...pending.entries()].map(async ([runtime, bucket]) => {
			const runner = runners[runtime];
			let outcomes: MacroOutcome[] | null = null;
			if (runner) {
				try {
					outcomes = await runner(bucket.specs);
				} catch {
					outcomes = null;
				}
			}
			bucket.cacheKeys.forEach((cacheKey, i) => {
				const outcome = outcomes?.[i];
				if (outcome?.ok) {
					const text = serializeMacroValue(outcome.value);
					cache.set(cacheKey, { kind: "value", text });
					resolved.set(bucket.refKeys[i]!, text);
				}
			});
		}),
	);

	return resolved;
}
