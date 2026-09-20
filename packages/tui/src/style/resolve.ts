import type { Color } from "../core/style";
import { Style } from "../core/style";
import { isValidThemeColor, type ThemeBg, type ThemeColor } from "../theme/schema";
import type { Theme } from "../theme/theme";

/** Semantic roles emitted by document highlighters before terminal colors are resolved. */
export type SyntaxRole =
	| "text"
	| "comment"
	| "keyword"
	| "function"
	| "variable"
	| "string"
	| "number"
	| "type"
	| "operator"
	| "punctuation"
	| "added"
	| "removed"
	| "context";

const SYNTAX_TOKENS: Readonly<Record<SyntaxRole, ThemeColor>> = {
	text: "toolOutput",
	comment: "syntaxComment",
	keyword: "syntaxKeyword",
	function: "syntaxFunction",
	variable: "syntaxVariable",
	string: "syntaxString",
	number: "syntaxNumber",
	type: "syntaxType",
	operator: "syntaxOperator",
	punctuation: "syntaxPunctuation",
	added: "toolDiffAdded",
	removed: "toolDiffRemoved",
	context: "toolDiffContext",
};

/** Resolve any semantic color token, using contrast-safe foreground resolution when applicable. */
export function resolveToken(theme: Theme, token: ThemeColor | ThemeBg | Color, background?: ThemeBg | Color): Color {
	if (typeof token !== "string") return token;
	if (!isValidThemeColor(token)) return theme.bgColor(token);
	return typeof background === "string" ? theme.fgOnBgColor(token, background) : theme.fgColor(token);
}

/** Resolve a foreground token or pass an already-packed color through unchanged. */
export function resolveForeground(theme: Theme, color: ThemeColor | Color, background?: ThemeBg | Color): Color {
	return resolveToken(theme, color, background);
}

/** Resolve a background token or pass an already-packed color through unchanged. */
export function resolveBackground(theme: Theme, background: ThemeBg | Color): Color {
	return typeof background === "string" ? theme.bgColor(background) : background;
}

/** Resolve a syntax role to the interned run style used by document elements. */
export function resolveSyntaxRole(theme: Theme, role: SyntaxRole): Style {
	return Style.of({ fg: theme.fgColor(SYNTAX_TOKENS[role]) });
}
