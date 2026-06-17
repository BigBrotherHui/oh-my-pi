import { describe, expect, it } from "bun:test";
import {
	type MacroBatchRunner,
	type MacroCache,
	type MacroDefinitionResolver,
	type MacroSpec,
	resolveMacros,
	serializeMacroValue,
} from "@oh-my-pi/pi-coding-agent/eval/macro-evaluator";
import type { MacroRuntime } from "@oh-my-pi/pi-coding-agent/eval/macro-syntax";
import { scanMacros } from "@oh-my-pi/pi-coding-agent/eval/macro-syntax";

const token = (body: string): string => `@[[${body}]]`;
const newCache = (): MacroCache => new Map();
const found =
	(runtime: MacroRuntime, revision = 1): MacroDefinitionResolver =>
	() => ({ status: "found", runtime, revision });
const missing: MacroDefinitionResolver = () => ({ status: "missing" });
const ambiguous: MacroDefinitionResolver = () => ({ status: "ambiguous" });

describe("serializeMacroValue", () => {
	it("passes strings through unquoted", () => {
		expect(serializeMacroValue("/tmp/run")).toBe("/tmp/run");
	});
	it("stringifies numbers and booleans", () => {
		expect(serializeMacroValue(100)).toBe("100");
		expect(serializeMacroValue(true)).toBe("true");
	});
	it("renders null/undefined as empty", () => {
		expect(serializeMacroValue(null)).toBe("");
		expect(serializeMacroValue(undefined)).toBe("");
	});
	it("JSON-encodes objects and arrays", () => {
		expect(serializeMacroValue({ a: 1 })).toBe('{"a":1}');
		expect(serializeMacroValue([1, "x"])).toBe('[1,"x"]');
	});
});

describe("resolveMacros", () => {
	it("resolves macros via the registered runtime runner and serializes values", async () => {
		const runners = {
			py: (async (specs: MacroSpec[]) =>
				specs.map(s => ({ ok: true as const, value: (s.args?.[0] as number) ** 2 }))) satisfies MacroBatchRunner,
		};
		const out = await resolveMacros(scanMacros(token("pow2(10)")), found("py"), runners, newCache());
		expect(out.get("pow2([10])")).toBe("100");
	});

	it("does not call any kernel for unregistered macros", async () => {
		let calls = 0;
		const runners = {
			py: (async () => {
				calls++;
				return null;
			}) satisfies MacroBatchRunner,
			js: (async () => {
				calls++;
				return null;
			}) satisfies MacroBatchRunner,
		};
		const out = await resolveMacros(scanMacros(`${token("x")} ${token("y")}`), missing, runners, newCache());
		expect(out.size).toBe(0);
		expect(calls).toBe(0);
	});

	it("leaves ambiguous macros unresolved without picking a runtime", async () => {
		let calls = 0;
		const runners = {
			py: (async () => {
				calls++;
				return null;
			}) satisfies MacroBatchRunner,
			js: (async () => {
				calls++;
				return null;
			}) satisfies MacroBatchRunner,
		};
		const out = await resolveMacros(scanMacros(token("dupe")), ambiguous, runners, newCache());
		expect(out.size).toBe(0);
		expect(calls).toBe(0);
	});

	it("omits per-macro errors but keeps siblings", async () => {
		const runners = {
			py: (async (specs: MacroSpec[]) =>
				specs.map(s =>
					s.name === "ok" ? { ok: true as const, value: 1 } : { ok: false as const, error: "boom" },
				)) satisfies MacroBatchRunner,
		};
		const out = await resolveMacros(scanMacros(`${token("ok")} ${token("bad")}`), found("py"), runners, newCache());
		expect(out.get("ok")).toBe("1");
		expect(out.has("bad")).toBe(false);
	});

	it("evaluates a duplicated key only once and batches per runtime", async () => {
		let calls = 0;
		const batchSizes: number[] = [];
		const runners = {
			py: (async (specs: MacroSpec[]) => {
				calls++;
				batchSizes.push(specs.length);
				return specs.map(() => ({ ok: true as const, value: "v" }));
			}) satisfies MacroBatchRunner,
		};
		const out = await resolveMacros(
			scanMacros(`${token("a")} ${token("a")} ${token("b")}`),
			found("py"),
			runners,
			newCache(),
		);
		expect(calls).toBe(1);
		expect(batchSizes).toEqual([2]);
		expect(out.get("a")).toBe("v");
		expect(out.get("b")).toBe("v");
	});

	it("freezes resolved values in the cache for the same registration revision", async () => {
		let calls = 0;
		const runners = {
			js: (async (specs: MacroSpec[]) => {
				calls++;
				return specs.map(() => ({ ok: true as const, value: calls }));
			}) satisfies MacroBatchRunner,
		};
		const cache = newCache();
		const first = await resolveMacros(scanMacros(token("now()")), found("js", 1), runners, cache);
		const second = await resolveMacros(scanMacros(token("now()")), found("js", 1), runners, cache);
		expect(calls).toBe(1);
		expect(first.get("now([])")).toBe("1");
		expect(second.get("now([])")).toBe("1");
	});

	it("re-runs when a macro registration revision changes", async () => {
		let calls = 0;
		let revision = 1;
		const runners = {
			py: (async (specs: MacroSpec[]) => {
				calls++;
				return specs.map(() => ({ ok: true as const, value: revision }));
			}) satisfies MacroBatchRunner,
		};
		const resolver: MacroDefinitionResolver = () => ({ status: "found", runtime: "py", revision });
		const cache = newCache();
		const before = await resolveMacros(scanMacros(token("value")), resolver, runners, cache);
		revision = 2;
		const after = await resolveMacros(scanMacros(token("value")), resolver, runners, cache);
		expect(calls).toBe(2);
		expect(before.get("value")).toBe("1");
		expect(after.get("value")).toBe("2");
	});

	it("does not cache failures (a later definition can resolve)", async () => {
		let defined = false;
		const resolver: MacroDefinitionResolver = () =>
			defined ? { status: "found", runtime: "py", revision: 1 } : { status: "missing" };
		const runners = {
			py: (async (specs: MacroSpec[]) =>
				specs.map(() => ({ ok: true as const, value: 42 }))) satisfies MacroBatchRunner,
		};
		const cache = newCache();
		const before = await resolveMacros(scanMacros(token("later")), resolver, runners, cache);
		expect(before.has("later")).toBe(false);
		defined = true;
		const after = await resolveMacros(scanMacros(token("later")), resolver, runners, cache);
		expect(after.get("later")).toBe("42");
	});
});
