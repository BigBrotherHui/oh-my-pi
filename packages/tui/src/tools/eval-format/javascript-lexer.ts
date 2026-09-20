/** Lexical categories shared by tolerant JavaScript display-formatting passes. */
export type JavaScriptTokenKind =
	| "whitespace"
	| "word"
	| "number"
	| "string"
	| "template"
	| "regex"
	| "line-comment"
	| "block-comment"
	| "punctuation";

/** Exclusive UTF-16 source offsets and regex context for one display token. */
export interface JavaScriptToken {
	kind: JavaScriptTokenKind;
	start: number;
	end: number;
	regexAllowedBefore: boolean;
}

interface ParenFrame {
	controlHeader: boolean;
}

interface TemplateTextFrame {
	kind: "text";
}

interface TemplateExpressionFrame {
	kind: "expression";
	braceDepth: number;
	regexAllowed: boolean;
}

type TemplateFrame = TemplateTextFrame | TemplateExpressionFrame;

/** Control headers whose closing parentheses permit a statement-leading regex. */
export const CONTROL_HEADER_WORDS: Record<string, true> = {
	catch: true,
	for: true,
	if: true,
	switch: true,
	while: true,
	with: true,
};
const REGEX_PREFIX_WORDS: Record<string, true> = {
	await: true,
	case: true,
	delete: true,
	do: true,
	else: true,
	extends: true,
	in: true,
	instanceof: true,
	new: true,
	of: true,
	return: true,
	throw: true,
	typeof: true,
	void: true,
	yield: true,
};

function isIdentifierStart(char: string): boolean {
	if (!char) return false;
	const code = char.charCodeAt(0);
	return char === "$" || char === "_" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code >= 128;
}

function isIdentifierPart(char: string): boolean {
	if (!char) return false;
	const code = char.charCodeAt(0);
	return isIdentifierStart(char) || (code >= 48 && code <= 57);
}

function scanIdentifier(source: string, start: number): number {
	let index = start + 1;
	while (index < source.length && isIdentifierPart(source[index])) index++;
	return index;
}

function scanNumber(source: string, start: number): number {
	let index = start + 1;
	while (index < source.length && /[\w.]/.test(source[index])) index++;
	return index;
}

function scanQuoted(source: string, start: number): number {
	const quote = source[start];
	let index = start + 1;
	while (index < source.length) {
		if (source[index] === "\\") {
			index += index + 1 < source.length ? 2 : 1;
			continue;
		}
		if (source[index] === quote) return index + 1;
		index++;
	}
	return source.length;
}

function scanLineComment(source: string, start: number): number {
	let index = start + 2;
	while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index++;
	return index;
}

function scanBlockComment(source: string, start: number): number {
	let index = start + 2;
	while (index < source.length) {
		if (source[index] === "*" && source[index + 1] === "/") return index + 2;
		index++;
	}
	return source.length;
}

function scanRegex(source: string, start: number): number {
	let index = start + 1;
	let inCharacterClass = false;
	while (index < source.length) {
		const char = source[index];
		if (char === "\\") {
			index += index + 1 < source.length ? 2 : 1;
			continue;
		}
		if (char === "[") inCharacterClass = true;
		else if (char === "]") inCharacterClass = false;
		else if (char === "/" && !inCharacterClass) {
			index++;
			while (index < source.length && isIdentifierPart(source[index])) index++;
			return index;
		}
		index++;
	}
	return source.length;
}

function scanTemplate(source: string, start: number): number {
	const frames: TemplateFrame[] = [{ kind: "text" }];
	let index = start + 1;

	while (index < source.length) {
		const frame = frames[frames.length - 1];
		if (!frame) return index;
		const char = source[index];
		const next = source[index + 1];

		if (frame.kind === "text") {
			if (char === "\\") {
				index += index + 1 < source.length ? 2 : 1;
			} else if (char === "`") {
				frames.pop();
				index++;
				if (frames.length === 0) return index;
				const parent = frames[frames.length - 1];
				if (parent?.kind === "expression") parent.regexAllowed = false;
			} else if (char === "$" && next === "{") {
				frames.push({ kind: "expression", braceDepth: 1, regexAllowed: true });
				index += 2;
			} else {
				index++;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			index = scanQuoted(source, index);
			frame.regexAllowed = false;
			continue;
		}
		if (char === "`") {
			frames.push({ kind: "text" });
			index++;
			continue;
		}
		if (char === "/" && next === "/") {
			index = scanLineComment(source, index);
			continue;
		}
		if (char === "/" && next === "*") {
			index = scanBlockComment(source, index);
			continue;
		}
		if (char === "/" && frame.regexAllowed) {
			index = scanRegex(source, index);
			frame.regexAllowed = false;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = scanIdentifier(source, index);
			frame.regexAllowed = REGEX_PREFIX_WORDS[source.slice(index, end)] === true;
			index = end;
			continue;
		}
		if (char >= "0" && char <= "9") {
			index = scanNumber(source, index);
			frame.regexAllowed = false;
			continue;
		}
		if (char === "{") {
			frame.braceDepth++;
			frame.regexAllowed = true;
			index++;
			continue;
		}
		if (char === "}") {
			frame.braceDepth--;
			index++;
			if (frame.braceDepth === 0) frames.pop();
			else frame.regexAllowed = false;
			continue;
		}
		if ((char === "+" && next === "+") || (char === "-" && next === "-")) {
			frame.regexAllowed = false;
			index += 2;
			continue;
		}
		if (char === ")" || char === "]" || char === ".") frame.regexAllowed = false;
		else if (!/\s/.test(char)) frame.regexAllowed = true;
		index++;
	}

	return source.length;
}

/**
 * Tokenizes tolerant JavaScript/TypeScript source without parsing it. Tokens retain
 * source offsets so callers can preserve literal text without copying it first.
 */
export function lexJavaScript(source: string): readonly JavaScriptToken[] {
	if (source.length === 0) return [];

	const tokens: JavaScriptToken[] = [];
	const parens: ParenFrame[] = [];
	let index = 0;
	let regexAllowed = true;
	let pendingFor = false;
	let lastWord = "";
	let lastTokenWasWord = false;

	const push = (kind: JavaScriptTokenKind, start: number, end: number) => {
		tokens.push({ kind, start, end, regexAllowedBefore: regexAllowed });
	};

	while (index < source.length) {
		const start = index;
		const char = source[index];
		const next = source[index + 1];

		if (/\s/.test(char)) {
			index++;
			while (index < source.length && /\s/.test(source[index])) index++;
			push("whitespace", start, index);
			continue;
		}
		if (char === "/" && next === "/") {
			index = scanLineComment(source, start);
			push("line-comment", start, index);
			continue;
		}
		if (char === "/" && next === "*") {
			index = scanBlockComment(source, start);
			push("block-comment", start, index);
			continue;
		}
		if (char === "'" || char === '"') {
			index = scanQuoted(source, start);
			push("string", start, index);
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (char === "`") {
			index = scanTemplate(source, start);
			push("template", start, index);
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (char === "/" && regexAllowed) {
			index = scanRegex(source, start);
			push("regex", start, index);
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (isIdentifierStart(char)) {
			index = scanIdentifier(source, start);
			const word = source.slice(start, index);
			push("word", start, index);
			if (word === "for") pendingFor = true;
			else if (!(pendingFor && word === "await")) pendingFor = false;
			regexAllowed = REGEX_PREFIX_WORDS[word] === true;
			lastWord = word;
			lastTokenWasWord = true;
			continue;
		}
		if (char >= "0" && char <= "9") {
			index = scanNumber(source, start);
			push("number", start, index);
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}

		index++;
		push("punctuation", start, index);
		if (char === "(") {
			const forHeader = pendingFor;
			parens.push({ controlHeader: forHeader || (lastTokenWasWord && CONTROL_HEADER_WORDS[lastWord] === true) });
			regexAllowed = true;
		} else if (char === ")") {
			regexAllowed = parens.pop()?.controlHeader ?? false;
		} else if ((char === "+" && next === "+") || (char === "-" && next === "-")) {
			regexAllowed = false;
		} else if (char === "]" || char === ".") {
			regexAllowed = false;
		} else {
			regexAllowed = true;
		}
		pendingFor = false;
		lastTokenWasWord = false;
	}

	return tokens;
}
