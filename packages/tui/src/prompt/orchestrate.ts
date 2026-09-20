import {
	createGradientDecorator,
	createGradientHighlighter,
	type KeywordDecorator,
	type KeywordHighlighter,
} from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

const ORCHESTRATE_WORD = magicKeywordRegex("orchestrate");

/**
 * Whether `text` contains the standalone keyword "orchestrate" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsOrchestrate(text: string): boolean {
	return keywordInProse(text, ORCHESTRATE_WORD);
}

/**
 * Highlight every standalone "orchestrate" in `text` for editor display with a
 * cool teal→violet gradient (hue 150..280), visually distinct from ultrathink's
 * full-spectrum rainbow.
 */
const ORCHESTRATE_GRADIENT = {
	probe: /orchestrate/,
	highlight: magicKeywordRegex("orchestrate", "g"),
	stops: 14,
	hue: (t: number) => 150 + t * 130,
};

export const highlightOrchestrate: KeywordHighlighter = createGradientHighlighter(ORCHESTRATE_GRADIENT);
export const decorateOrchestrate: KeywordDecorator = createGradientDecorator(ORCHESTRATE_GRADIENT);
