import { describe, expect, it } from "bun:test";
import { expandMacros, type MacroRef, macroKey, scanMacros } from "@oh-my-pi/pi-coding-agent/eval/macro-syntax";

const token = (body: string): string => `@[[${body}]]`;
const escapedToken = (body: string): string => `\\${token(body)}`;

describe("scanMacros", () => {
	it("returns nothing when there is no marker (fast path)", () => {
		expect(scanMacros("plain text, no macros here")).toEqual([]);
	});

	it("parses a simple call with one numeric arg", () => {
		const input = `10² = ${token("pow2(10)")}`;
		const refs = scanMacros(input);
		expect(refs).toHaveLength(1);
		const r = refs[0];
		expect(r.name).toBe("pow2");
		expect(r.args).toEqual([10]);
		expect(r.key).toBe("pow2([10])");
		expect("10² = ".length).toBe(r.start);
	});

	it("parses a bare value reference (no parens, args null)", () => {
		const refs = scanMacros(token("constant"));
		expect(refs).toHaveLength(1);
		expect(refs[0].args).toBeNull();
		expect(refs[0].key).toBe("constant");
	});

	it("distinguishes zero-arg call from value reference", () => {
		expect(scanMacros(token("now()"))[0].args).toEqual([]);
		expect(scanMacros(token("now"))[0].args).toBeNull();
		expect(scanMacros(token("now()"))[0].key).not.toBe(scanMacros(token("now"))[0].key);
	});

	it("rejects legacy runtime-prefixed tokens", () => {
		expect(scanMacros(token("py.x"))).toEqual([]);
		expect(scanMacros(token("js.x"))).toEqual([]);
		expect(scanMacros(token("rb.x"))).toEqual([]);
		expect(scanMacros(token("python.x"))).toEqual([]);
	});

	it("handles string args containing ) and ] without closing early", () => {
		const refs = scanMacros(token('fmt("a)b]]c", "d")'));
		expect(refs).toHaveLength(1);
		expect(refs[0].args).toEqual(["a)b]]c", "d"]);
	});

	it("handles nested array/object literal args (bracket-aware close)", () => {
		const refs = scanMacros(token('lookup({"region": ["eu", "us"]}, [1, 2])'));
		expect(refs).toHaveLength(1);
		expect(refs[0].args).toEqual([{ region: ["eu", "us"] }, [1, 2]]);
	});

	it("tolerates whitespace inside the token", () => {
		const refs = scanMacros("@[[  pow2( 10 )  ]]");
		expect(refs).toHaveLength(1);
		expect(refs[0].args).toEqual([10]);
	});

	it("finds multiple macros in one string", () => {
		const refs = scanMacros(`${token("a")} and ${token("b(1)")} done`);
		expect(refs.map(r => r.key)).toEqual(["a", "b([1])"]);
	});

	describe("LaTeX rule: incomplete/malformed left literal", () => {
		const malformed = [
			"@[[pow2(",
			"@[[pow2(10)",
			token("."),
			token("pow2.'bad'"),
			token("pow2('unterminated)"),
			token("f(1,)"),
			token("f(x)"),
		];
		for (const input of malformed) {
			it(`leaves ${JSON.stringify(input)} unmatched`, () => {
				expect(scanMacros(input)).toEqual([]);
			});
		}
	});

	it("does not match an escaped marker", () => {
		expect(scanMacros(escapedToken("x"))).toEqual([]);
	});
});

describe("macroKey", () => {
	it("is stable and arg-order sensitive", () => {
		expect(macroKey("f", [1, 2])).toBe("f([1,2])");
		expect(macroKey("f", [2, 1])).toBe("f([2,1])");
		expect(macroKey("x", null)).toBe("x");
	});
});

describe("expandMacros", () => {
	const resolve = (m: Record<string, string>) => (ref: MacroRef) => m[ref.key];

	it("splices resolved values in place", () => {
		const out = expandMacros(`10² = ${token("pow2(10)")}!`, resolve({ "pow2([10])": "100" }));
		expect(out).toBe("10² = 100!");
	});

	it("leaves a macro literal when the resolver returns undefined", () => {
		const out = expandMacros(`a ${token("nope")} b`, resolve({}));
		expect(out).toBe(`a ${token("nope")} b`);
	});

	it("expands multiple and preserves surrounding text", () => {
		const out = expandMacros(`${token("a")}/${token("b")}`, resolve({ a: "X", b: "Y" }));
		expect(out).toBe("X/Y");
	});

	it("strips the backslash from an escaped marker in literal regions", () => {
		expect(expandMacros(`literal ${escapedToken("x")} here`, resolve({}))).toBe(`literal ${token("x")} here`);
	});

	it("returns input unchanged when there are no macros", () => {
		expect(expandMacros("nothing to do", resolve({}))).toBe("nothing to do");
	});
});
