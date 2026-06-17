import type { EvalStatusEvent } from "@oh-my-pi/pi-tui/tools/eval";
import type { MacroDefinitionLookup } from "./macro-evaluator";
import type { MacroRuntime } from "./macro-syntax";

interface RuntimeRegistration {
	revision: number;
}

type MacroEntry = Partial<Record<MacroRuntime, RuntimeRegistration>>;

const registries = new Map<string, Map<string, MacroEntry>>();
let hostRevision = 0;

function normalizeSessionId(sessionId: string): string {
	if (sessionId.startsWith("python:")) return sessionId.slice("python:".length);
	if (sessionId.startsWith("js:")) return sessionId.slice("js:".length);
	return sessionId;
}

function registryKey(sessionId: string, cwd: string): string {
	return `${normalizeSessionId(sessionId)}\0${cwd}`;
}

function normalizeRuntime(value: unknown): MacroRuntime | null {
	if (value === "py" || value === "python") return "py";
	if (value === "js" || value === "javascript") return "js";
	return null;
}

function registryFor(sessionId: string, cwd: string): Map<string, MacroEntry> {
	const key = registryKey(sessionId, cwd);
	let registry = registries.get(key);
	if (!registry) {
		registry = new Map();
		registries.set(key, registry);
	}
	return registry;
}

function registeredRuntimes(entry: MacroEntry): MacroRuntime[] {
	const runtimes: MacroRuntime[] = [];
	if (entry.py) runtimes.push("py");
	if (entry.js) runtimes.push("js");
	return runtimes;
}

/** Record and suppress kernel-emitted macro registry status events. */
export function recordMacroStatusEvent(sessionId: string, cwd: string, event: EvalStatusEvent): boolean {
	if (event.op !== "macro") return false;
	if (event.action !== "register") return true;
	const runtime = normalizeRuntime(event.runtime);
	const name = typeof event.name === "string" ? event.name : "";
	const kernelRevision = typeof event.revision === "number" && Number.isFinite(event.revision) ? event.revision : 0;
	if (!runtime || !name || kernelRevision <= 0) return true;

	const registry = registryFor(sessionId, cwd);
	const entry = registry.get(name) ?? {};
	hostRevision += 1;
	entry[runtime] = { revision: hostRevision };
	registry.set(name, entry);
	return true;
}

export function clearMacroRuntime(sessionId: string, cwd: string, runtime: MacroRuntime): void {
	const key = registryKey(sessionId, cwd);
	const registry = registries.get(key);
	if (!registry) return;
	for (const [name, entry] of registry.entries()) {
		delete entry[runtime];
		if (registeredRuntimes(entry).length === 0) registry.delete(name);
	}
	if (registry.size === 0) registries.delete(key);
}

export function clearAllMacroDefinitions(): void {
	registries.clear();
}

export function lookupMacroDefinition(sessionId: string, cwd: string, name: string): MacroDefinitionLookup {
	const registry = registries.get(registryKey(sessionId, cwd));
	const entry = registry?.get(name);
	if (!entry) return { status: "missing" };
	const runtimes = registeredRuntimes(entry);
	if (runtimes.length !== 1) return { status: "ambiguous" };
	const runtime = runtimes[0]!;
	const registration = entry[runtime];
	if (!registration) return { status: "missing" };
	return { status: "found", runtime, revision: registration.revision };
}
