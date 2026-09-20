import { CONTROL_HEADER_WORDS, lexJavaScript, type JavaScriptToken } from "./javascript-lexer";

type PendingBreak = "brace" | "statement" | "close";

interface ParenFrame {
	forHeader: boolean;
}

const CLOSE_CONTINUATIONS = ["else", "catch", "finally"];

function canJoinCloseWithWord(word: string, atSourceEnd: boolean): boolean {
	return CLOSE_CONTINUATIONS.some(keyword => keyword === word || (atSourceEnd && keyword.startsWith(word)));
}

function canAttachToClose(char: string): boolean {
	return "();,.)]:?+-*/%&|^<>=!".includes(char);
}

const JS_DISPLAY_MAX_LINE_WIDTH = 100;
const JS_DISPLAY_INDENT = "    ";
const BLOCK_BRACE_WORDS: Record<string, true> = {
	catch: true,
	class: true,
	do: true,
	else: true,
	finally: true,
	for: true,
	function: true,
	if: true,
	switch: true,
	try: true,
	while: true,
	with: true,
};
const OBJECT_PREFIX_WORDS: Record<string, true> = {
	const: true,
	default: true,
	let: true,
	return: true,
	throw: true,
	var: true,
	yield: true,
};

interface DisplayBraceNode {
	start: number;
	end?: number;
	object: boolean;
	children: DisplayBraceNode[];
}

function classifySourceBraces(source: string, tokens: readonly JavaScriptToken[]): boolean[] {
	const objects: boolean[] = [];
	const statementWords: string[] = [];
	let previousToken = "";
	let previousWord = "";

	for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
		const token = tokens[tokenIndex];
		if (token.kind === "whitespace" || token.kind === "line-comment" || token.kind === "block-comment") continue;
		if (token.kind === "string" || token.kind === "template" || token.kind === "regex") continue;
		if (token.kind === "word") {
			const word = source.slice(token.start, token.end);
			statementWords.push(word);
			previousWord = word;
			previousToken = word;
			continue;
		}
		if (token.kind === "number") {
			previousToken = "value";
			previousWord = "";
			continue;
		}

		const char = source[token.start];
		if (char === "{") {
			const isBlock =
				previousToken === "=>" ||
				previousToken === ")" ||
				previousToken === "}" ||
				BLOCK_BRACE_WORDS[previousWord] === true ||
				statementWords.some(word => word === "class" || word === "function" || word === "switch");
			const isObject =
				!isBlock &&
				(previousToken === "=" ||
					previousToken === ":" ||
					previousToken === "," ||
					previousToken === "(" ||
					previousToken === "[" ||
					previousToken === ";" ||
					previousToken === "" ||
					OBJECT_PREFIX_WORDS[previousWord] === true);
			objects.push(isObject);
			if (isBlock) statementWords.length = 0;
			previousToken = "{";
			previousWord = "";
			continue;
		}
		if (char === "}") {
			previousToken = "}";
			previousWord = "";
			continue;
		}
		if (char === ";") {
			statementWords.length = 0;
			previousToken = ";";
			previousWord = "";
			continue;
		}
		if (char === ")") {
			previousToken = ")";
			previousWord = "";
			continue;
		}
		if (char === "]" || char === ".") {
			previousToken = char;
			previousWord = "";
			continue;
		}
		if (char === "=" && source[token.end] === ">") {
			previousToken = "=>";
			previousWord = "";
			tokenIndex++;
			continue;
		}
		previousToken = char;
		previousWord = "";
	}
	return objects;
}

function collectDisplayBraceNodes(
	text: string,
	tokens: readonly JavaScriptToken[],
	objectFlags: readonly boolean[],
): DisplayBraceNode[] {
	const roots: DisplayBraceNode[] = [];
	const stack: DisplayBraceNode[] = [];
	let openingIndex = 0;

	for (const token of tokens) {
		if (token.kind !== "punctuation") continue;
		const char = text[token.start];
		if (char === "{") {
			const node: DisplayBraceNode = {
				start: token.start,
				object: objectFlags[openingIndex] === true,
				children: [],
			};
			openingIndex++;
			const parent = stack[stack.length - 1];
			if (parent) parent.children.push(node);
			else roots.push(node);
			stack.push(node);
			continue;
		}
		if (char === "}") {
			const node = stack.pop();
			if (node) node.end = token.start;
		}
	}
	return roots;
}

function collapseDisplayWhitespace(text: string, tokens: readonly JavaScriptToken[]): string | undefined {
	const output: string[] = [];
	let pendingSpace = false;

	for (const token of tokens) {
		const value = text.slice(token.start, token.end);
		if (token.kind === "whitespace") {
			pendingSpace = true;
			continue;
		}
		if (token.kind === "line-comment") return undefined;
		if (token.kind === "string" || token.kind === "template") {
			if (value.includes("\n") || value.includes("\r")) return undefined;
		}
		if (pendingSpace && output.length > 0) output.push(" ");
		pendingSpace = false;
		output.push(value);
	}
	return output.join("").trim();
}

function splitDisplayObjectProperties(text: string, tokens: readonly JavaScriptToken[]): string[] {
	const properties: string[] = [];
	let start = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;

	for (const token of tokens) {
		if (token.kind !== "punctuation") continue;
		const char = text[token.start];
		if (char === "(") parenDepth++;
		else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
		else if (char === "[") bracketDepth++;
		else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
		else if (char === "{") braceDepth++;
		else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
		else if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
			properties.push(text.slice(start, token.end));
			start = token.end;
		}
	}
	properties.push(text.slice(start));
	return properties;
}

function formatDisplayObjectLiterals(formatted: string, sourceObjectBraces: readonly boolean[]): string {
	const roots = collectDisplayBraceNodes(formatted, lexJavaScript(formatted), sourceObjectBraces);

	function renderRange(
		start: number,
		end: number,
		children: readonly DisplayBraceNode[],
		childIndent: string,
	): string {
		const output: string[] = [];
		let cursor = start;
		for (const child of children) {
			if (child.start < start || child.start >= end) continue;
			output.push(formatted.slice(cursor, child.start));
			output.push(renderNode(child, childIndent));
			cursor = child.end === undefined ? end : child.end + 1;
		}
		output.push(formatted.slice(cursor, end));
		return output.join("");
	}

	function renderNode(node: DisplayBraceNode, parentIndent: string): string {
		const lineStart = Math.max(0, formatted.lastIndexOf("\n", node.start - 1) + 1);
		const linePrefix = formatted.slice(lineStart, node.start);
		const ownIndent = /^[ \t]*$/.test(linePrefix) ? linePrefix : parentIndent;
		const propertyIndent = ownIndent + JS_DISPLAY_INDENT;
		const closed = node.end !== undefined;
		const end = node.end ?? formatted.length;
		if (!node.object) {
			return `{${renderRange(node.start + 1, end, node.children, propertyIndent)}${closed ? "}" : ""}`;
		}

		// Walk the body left to right and decide the layout at the FIRST decisive
		// event, so the decision is a pure function of the source prefix and never
		// flips as more code streams in:
		// - a raw newline or a multi-line block child commits lines with the
		//   original inline layout -> verbatim forever;
		// - a nested object exploding, or the flat width passing the cap,
		//   explodes this object (and, transitively, every enclosing inline
		//   object in this same render pass).
		let mode: "inline" | "verbatim" | "explode" = "inline";
		let width = node.start - lineStart + 4;
		const pieces: string[] = [];
		let cursor = node.start + 1;
		const consume = (text: string, blockLike: boolean) => {
			pieces.push(text);
			if (mode !== "inline" || text.length === 0) return;
			if (text.includes("\n") || text.includes("\r")) {
				mode = blockLike ? "verbatim" : "explode";
				return;
			}
			width += text.length;
			if (width > JS_DISPLAY_MAX_LINE_WIDTH) mode = "explode";
		};
		for (const child of node.children) {
			if (child.start < node.start + 1 || child.start >= end) continue;
			consume(formatted.slice(cursor, child.start), true);
			consume(renderNode(child, propertyIndent), !child.object);
			cursor = child.end === undefined ? end : child.end + 1;
		}
		consume(formatted.slice(cursor, end), true);
		const body = pieces.join("");

		if (mode === "inline") {
			const flat = collapseDisplayWhitespace(body, lexJavaScript(body));
			if (flat === undefined) mode = "verbatim";
			else if (!closed) return flat.length > 0 ? `{ ${flat}` : "{";
			else return flat.length > 0 ? `{ ${flat} }` : "{}";
		}
		if (mode === "verbatim") {
			return `{${body}${closed ? "}" : ""}`;
		}

		const properties = splitDisplayObjectProperties(body, lexJavaScript(body))
			.map(property => property.trim())
			.filter(property => property.length > 0);
		if (properties.length === 0) return closed ? "{}" : "{";
		const lines = properties.map(property => `${propertyIndent}${property}`);
		return `{\n${lines.join("\n")}${closed ? `\n${ownIndent}}` : ""}`;
	}

	return renderRange(0, formatted.length, roots, "");
}

/**
 * Finds the next operator token eligible for spacing normalization. Angle
 * brackets and bare `*` are intentionally excluded: generics (`Map<K, V>`) and
 * generators (`function*`) would be mangled by binary-operator spacing.
 */
function scanDisplayOperator(source: string, start: number): string | undefined {
	const three = source.slice(start, start + 3);
	if (three === "===" || three === "!==" || three === "**=" || three === "&&=" || three === "||=" || three === "??=") {
		return three;
	}
	const two = source.slice(start, start + 2);
	if (
		two === "=>" ||
		two === "==" ||
		two === "!=" ||
		two === "&&" ||
		two === "||" ||
		two === "??" ||
		two === "++" ||
		two === "--" ||
		two === "+=" ||
		two === "-=" ||
		two === "*=" ||
		two === "/=" ||
		two === "%=" ||
		two === "&=" ||
		two === "|=" ||
		two === "^=" ||
		two === "**"
	) {
		return two;
	}
	return "=+-/%&|^!?:,".includes(source[start]) ? source[start] : undefined;
}

function operatorSpacing(token: string, unary: boolean, ternaryPending: boolean): { before: boolean; after: boolean } {
	if (token === ",") return { before: false, after: true };
	if (token === ":") return { before: ternaryPending, after: true };
	if (token === "?") return { before: true, after: true };
	if (token === "!" || unary || token === "++" || token === "--") {
		return { before: false, after: false };
	}
	return { before: true, after: true };
}

/** Formats JavaScript/TypeScript-like eval source for safe, stable display without requiring valid syntax. */
export function formatJavaScriptForDisplay(source: string): string {
	if (source.length === 0) return source;

	const tokens = lexJavaScript(source);
	const output: string[] = [];
	const parens: ParenFrame[] = [];
	const sourceObjectBraces = classifySourceBraces(source, tokens);
	const braceKinds: Array<"object" | "block"> = [];
	let sourceBraceIndex = 0;
	let indent = 0;
	let atLineStart = true;
	let lastChar = "";
	let pendingWhitespace = "";
	let pendingBreak: PendingBreak | undefined;
	let pendingOperatorSpace = false;
	let ternaryPending = false;
	let afterForSemicolon = false;
	let pendingFor = false;
	let lastWord = "";
	let lastTokenWasWord = false;

	function append(text: string): void {
		if (!text) return;
		output.push(text);
		lastChar = text[text.length - 1];
		const newline = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
		atLineStart = newline >= 0 ? newline === text.length - 1 : false;
	}

	function newline(): void {
		output.push("\n");
		lastChar = "\n";
		atLineStart = true;
	}

	function whitespaceWidth(text: string): number {
		let width = 0;
		for (const char of text) width += char === "\t" ? 4 - (width % 4) : 1;
		return width;
	}

	function trimTrailingHorizontalWhitespace(): void {
		for (let index = output.length - 1; index >= 0; index--) {
			const chunk = output[index];
			const trimmed = chunk.replace(/[ \t]+$/, "");
			if (trimmed !== chunk) {
				if (trimmed.length > 0) output[index] = trimmed;
				else output.splice(index, 1);
			}
			if (trimmed.length > 0 || chunk.includes("\n") || chunk.includes("\r")) break;
		}
		for (let index = output.length - 1; index >= 0; index--) {
			const chunk = output[index];
			if (chunk.length > 0) {
				lastChar = chunk[chunk.length - 1];
				return;
			}
		}
		lastChar = "";
	}

	function flushWhitespace(): void {
		if (atLineStart) {
			const width = Math.max(indent * 4, whitespaceWidth(pendingWhitespace));
			if (width > 0) append(" ".repeat(width));
		} else if (pendingWhitespace.length > 0) {
			append(" ");
		}
		pendingWhitespace = "";
	}

	function flushOperatorSpace(nextText: string): void {
		if (!pendingOperatorSpace) return;
		if (!atLineStart && lastChar !== " " && !")]},.;".includes(nextText[0] ?? "")) append(" ");
		pendingWhitespace = "";
		pendingOperatorSpace = false;
	}

	function appendOperator(token: string, before: boolean, after: boolean): void {
		trimTrailingHorizontalWhitespace();
		if (before && !atLineStart && lastChar !== " " && lastChar !== "\n") append(" ");
		append(token);
		pendingOperatorSpace = after;
	}

	function forceBreak(): void {
		pendingWhitespace = "";
		pendingOperatorSpace = false;
		if (!atLineStart) newline();
		pendingBreak = undefined;
	}

	function prepareToken(kind: "word" | "punctuation" | "value", text: string, end: number): void {
		flushOperatorSpace(text);
		if (pendingBreak === "close") {
			if (kind === "word" && canJoinCloseWithWord(text, end === source.length)) {
				pendingWhitespace = "";
				if (!atLineStart && lastChar !== " ") append(" ");
				pendingBreak = undefined;
			} else if (kind === "punctuation" && canAttachToClose(text[0])) {
				pendingWhitespace = "";
				pendingBreak = undefined;
			} else {
				forceBreak();
			}
		} else if (pendingBreak) {
			forceBreak();
		}

		if (afterForSemicolon) {
			if (text !== ";" && text !== ")" && !atLineStart && pendingWhitespace.length === 0) append(" ");
			afterForSemicolon = false;
		}
	}

	function appendComment(comment: string): void {
		if (pendingBreak) {
			if (pendingWhitespace.length > 0) append(pendingWhitespace);
			else if (!atLineStart) append(" ");
			pendingWhitespace = "";
		} else {
			flushWhitespace();
		}
		append(comment);
		if (comment.includes("\n") || comment.includes("\r")) pendingBreak = undefined;
		if (afterForSemicolon) afterForSemicolon = false;
	}

	for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
		const token = tokens[tokenIndex];
		const text = source.slice(token.start, token.end);

		if (token.kind === "whitespace") {
			for (let index = token.start; index < token.end;) {
				const char = source[index];
				if (char === "\n" || char === "\r") {
					pendingWhitespace = "";
					pendingOperatorSpace = false;
					pendingBreak = undefined;
					afterForSemicolon = false;
					newline();
					index += char === "\r" && source[index + 1] === "\n" ? 2 : 1;
					continue;
				}
				const start = index;
				while (index < token.end && /[^\S\r\n]/.test(source[index])) index++;
				pendingWhitespace += source.slice(start, index);
			}
			continue;
		}
		if (token.kind === "line-comment" || token.kind === "block-comment") {
			appendComment(text);
			continue;
		}
		if (token.kind === "string" || token.kind === "template" || token.kind === "regex" || token.kind === "number") {
			prepareToken("value", text, token.end);
			flushWhitespace();
			append(text);
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (token.kind === "word") {
			prepareToken("word", text, token.end);
			flushWhitespace();
			append(text);
			if (text === "for") pendingFor = true;
			else if (!(pendingFor && text === "await")) pendingFor = false;
			lastWord = text;
			lastTokenWasWord = true;
			continue;
		}

		const char = source[token.start];
		const next = source[token.end];
		if (char === "{") {
			const objectBrace = sourceObjectBraces[sourceBraceIndex] === true;
			sourceBraceIndex++;
			braceKinds.push(objectBrace ? "object" : "block");
			prepareToken("punctuation", char, token.end);
			const hadWhitespace = pendingWhitespace.length > 0;
			flushWhitespace();
			if (!atLineStart && !hadWhitespace && !" ([{".includes(lastChar)) append(" ");
			append(char);
			if (!objectBrace) {
				indent++;
				pendingBreak = "brace";
			}
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (char === "}") {
			const braceKind = braceKinds.pop() ?? "block";
			prepareToken("punctuation", char, token.end);
			if (braceKind === "object") {
				// Multi-line object closers keep their line indentation; inline
				// closers attach tight so the post-pass controls the spacing.
				if (atLineStart) flushWhitespace();
				else {
					pendingWhitespace = "";
					trimTrailingHorizontalWhitespace();
				}
				append(char);
				pendingBreak = undefined;
			} else {
				pendingWhitespace = "";
				if (!atLineStart) newline();
				indent = Math.max(0, indent - 1);
				flushWhitespace();
				append(char);
				pendingBreak = "close";
			}
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (char === ";") {
			prepareToken("punctuation", char, token.end);
			flushWhitespace();
			append(char);
			const frame = parens[parens.length - 1];
			if (frame?.forHeader) afterForSemicolon = true;
			else pendingBreak = "statement";
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (char === "(") {
			const forHeader = pendingFor;
			const controlHeader = forHeader || (lastTokenWasWord && CONTROL_HEADER_WORDS[lastWord] === true);
			prepareToken("punctuation", char, token.end);
			const needsSpace = controlHeader && pendingWhitespace.length === 0 && !atLineStart;
			flushWhitespace();
			if (needsSpace) append(" ");
			append(char);
			parens.push({ forHeader });
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (char === ")") {
			prepareToken("punctuation", char, token.end);
			flushWhitespace();
			append(char);
			parens.pop();
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}

		const operator = scanDisplayOperator(source, token.start);
		if (operator && !(operator === "?" && (next === "." || next === ":"))) {
			const unary = (operator === "+" || operator === "-") && token.regexAllowedBefore;
			prepareToken("punctuation", operator, token.start + operator.length);
			flushWhitespace();
			const spacing = operatorSpacing(operator, unary, ternaryPending);
			appendOperator(operator, spacing.before, spacing.after);
			if (operator === "?") ternaryPending = true;
			else if (operator === ":") ternaryPending = false;
			pendingFor = false;
			lastTokenWasWord = false;
			tokenIndex += operator.length - 1;
			continue;
		}

		prepareToken("punctuation", char, token.end);
		flushWhitespace();
		append(char);
		pendingFor = false;
		lastTokenWasWord = false;
	}

	const formatted = output.join("");
	if (!sourceObjectBraces.includes(true)) return formatted;
	try {
		return formatDisplayObjectLiterals(formatted, sourceObjectBraces);
	} catch {
		return formatted;
	}
}
