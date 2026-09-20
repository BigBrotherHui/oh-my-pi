import {
	createGradientDecorator,
	createGradientHighlighter,
	type KeywordDecorator,
	type KeywordHighlighter,
} from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

const ULTRATHINK_WORD = magicKeywordRegex("ultrathink");

/**
 * Whether `text` contains the standalone keyword "ultrathink" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsUltrathink(text: string): boolean {
	return keywordInProse(text, ULTRATHINK_WORD);
}

/**
 * Rainbow-highlight every standalone "ultrathink" in `text` for editor display.
 * Sweeps red→violet (hue 0..330), stopping short of the wrap back to red so the
 * gradient resolves smoothly regardless of casing or match length.
 */
const ULTRATHINK_GRADIENT = {
	probe: /ultrathink/,
	highlight: magicKeywordRegex("ultrathink", "g"),
	stops: 14,
	hue: (t: number) => t * 330,
};

export const highlightUltrathink: KeywordHighlighter = createGradientHighlighter(ULTRATHINK_GRADIENT);
export const decorateUltrathink: KeywordDecorator = createGradientDecorator(ULTRATHINK_GRADIENT);
