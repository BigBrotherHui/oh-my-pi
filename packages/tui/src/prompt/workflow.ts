import {
	createGradientDecorator,
	createGradientHighlighter,
	type KeywordDecorator,
	type KeywordHighlighter,
} from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

const WORKFLOW_WORD = magicKeywordRegex("workflowz");

/**
 * Whether `text` contains the standalone keyword "workflowz"
 * (lowercase, prose-delimited) in prose — never inside a code block, inline
 * code span, or XML/HTML section.
 */
export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_WORD);
}

/**
 * Highlight every standalone "workflowz" in `text` for editor display
 * with a warm amber→green gradient (hue 30..150), visually distinct from
 * ultrathink's rainbow and orchestrate's teal→violet.
 */
const WORKFLOW_GRADIENT = {
	probe: /workflowz/,
	highlight: magicKeywordRegex("workflowz", "g"),
	stops: 14,
	hue: (t: number) => 30 + t * 120,
};

export const highlightWorkflow: KeywordHighlighter = createGradientHighlighter(WORKFLOW_GRADIENT);
export const decorateWorkflow: KeywordDecorator = createGradientDecorator(WORKFLOW_GRADIENT);
