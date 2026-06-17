/**
 * Macro syntax: inline, host-evaluated substitutions the model can emit in any
 * output. A macro names a value or function registered from a persistent `eval`
 * kernel via `defmacro(name, value)` and is spliced in place with its computed value.
 *
 * Grammar: marker + name + optional JSON args + closing marker.
 *   name    : a single identifier (no runtime prefix or attribute chains)
 *   args    : comma-separated JSON literals; absent `()` => value reference
 *
 * "LaTeX rule": only a complete, well-formed token expands. Anything partial or
 * unparseable is left exactly as written — scanning never throws. A marker
 * immediately preceded by a backslash is an escape and is not a macro; the
 * backslash is stripped at replace time.
 *
 * Scanning and replacement are synchronous and pure. The (async) kernel
 * evaluation happens between them: {@link scanMacros} -> evaluate keys ->
 * {@link expandMacros} with a sync resolver.
 */

export type MacroRuntime = "py" | "js";

export interface MacroRef {
	/** Offset of `@` in the source string. */
	start: number;
	/** Offset just past the closing marker. */
	end: number;
	name: string;
	/** `null` = value reference (no parens); array = call arguments (possibly empty). */
	args: unknown[] | null;
	/** Stable syntax identity for a ref before registry resolution. */
	key: string;
}

const MARKER = "@[[";
const CLOSER = "]]";
const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

/** Build the syntax memo key for a ref. Value refs and zero-arg calls stay distinct. */
export function macroKey(name: string, args: unknown[] | null): string {
	return args === null ? name : `${name}(${JSON.stringify(args)})`;
}

/**
 * Find every complete, well-formed macro token in `text`. Incomplete or
 * malformed marker occurrences are skipped (left literal). Never throws.
 */
export function scanMacros(text: string): MacroRef[] {
	const out: MacroRef[] = [];
	let i = 0;
	const n = text.length;
	while (i < n) {
		const at = text.indexOf(MARKER, i);
		if (at < 0) break;
		// Escaped markers are not macros; resume after the marker.
		if (at > 0 && text[at - 1] === "\\") {
			i = at + MARKER.length;
			continue;
		}
		const ref = parseMacro(text, at);
		if (ref) {
			out.push(ref);
			i = ref.end;
		} else {
			i = at + MARKER.length;
		}
	}
	return out;
}

/** Attempt to parse a single macro starting at `@` (index `start`). Returns null if malformed. */
function parseMacro(text: string, start: number): MacroRef | null {
	let p = start + MARKER.length;
	p = skipWs(text, p);

	if (p >= text.length || !IDENT_START.test(text[p])) return null;
	const nameStart = p;
	while (p < text.length && IDENT_CHAR.test(text[p])) p++;
	const name = text.slice(nameStart, p);

	p = skipWs(text, p);

	let args: unknown[] | null = null;
	if (text[p] === "(") {
		const argEnd = matchBalanced(text, p);
		if (argEnd < 0) return null;
		const inner = text.slice(p + 1, argEnd).trim();
		const parsed = parseArgs(inner);
		if (parsed === null) return null;
		args = parsed;
		p = argEnd + 1;
		p = skipWs(text, p);
	}

	if (text[p] !== CLOSER[0] || text[p + 1] !== CLOSER[1]) return null;
	const end = p + CLOSER.length;

	return {
		start,
		end,
		name,
		args,
		key: macroKey(name, args),
	};
}

/** Parse the inside of `(...)` as a JSON literal arg list. Returns null if not valid JSON. */
function parseArgs(inner: string): unknown[] | null {
	if (inner === "") return [];
	try {
		const value = JSON.parse(`[${inner}]`);
		return Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

/**
 * Given an opening bracket at `open` (one of `([{`), return the index of the
 * matching close, honoring nested brackets and string literals. Returns -1 if
 * unbalanced before end of string.
 */
function matchBalanced(text: string, open: number): number {
	const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
	const stack: string[] = [];
	let inStr: string | null = null;
	let escaped = false;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === inStr) inStr = null;
			continue;
		}
		if (c === '"' || c === "'") {
			inStr = c;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") {
			stack.push(pairs[c]);
			continue;
		}
		if (c === ")" || c === "]" || c === "}") {
			const expected = stack.pop();
			if (expected !== c) return -1;
			if (stack.length === 0) return i;
		}
	}
	return -1;
}

function skipWs(text: string, p: number): number {
	while (p < text.length && (text[p] === " " || text[p] === "\t" || text[p] === "\n" || text[p] === "\r")) p++;
	return p;
}

/**
 * Replace every macro span in `text`. `resolve` maps a ref to its substitution
 * text; returning `undefined` leaves the macro literal. Literal regions also
 * have the escaped marker collapsed to a literal marker.
 */
export function expandMacros(text: string, resolve: (ref: MacroRef) => string | undefined): string {
	const refs = scanMacros(text);
	if (refs.length === 0) return unescapeLiteral(text);
	let out = "";
	let cursor = 0;
	for (const ref of refs) {
		out += unescapeLiteral(text.slice(cursor, ref.start));
		const replacement = resolve(ref);
		out += replacement === undefined ? text.slice(ref.start, ref.end) : replacement;
		cursor = ref.end;
	}
	out += unescapeLiteral(text.slice(cursor));
	return out;
}

function unescapeLiteral(segment: string): string {
	return segment.includes(`\\${MARKER}`) ? segment.replaceAll(`\\${MARKER}`, MARKER) : segment;
}
