import { containsJevify, decorateJevify, highlightJevify } from "./jevify";
import { containsOrchestrate, decorateOrchestrate, highlightOrchestrate } from "./orchestrate";
import { containsUltrathink, decorateUltrathink, highlightUltrathink } from "./ultrathink";
import { containsWorkflow, decorateWorkflow, highlightWorkflow } from "./workflow";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { maskNonProse } from "./markdown-prose";
import { Style } from "../core/style";
import type { GradientRun, KeywordDecorator } from "./gradient-highlight";

/**
 * Gradient-highlight every magic keyword ("ultrathink", "orchestrate",
 * "workflowz", "jevify") that appears as standalone prose, skipping any occurrence inside a
 * code block, inline code span, or XML/HTML section. Each highlighter paints its
 * own keyword with its own gradient, so chaining is order-independent — the
 * earlier passes only inject zero-width SGR escapes (no backticks or angle
 * brackets), which never confuse the later passes' markdown masking.
 *
 * `resetTo` is the SGR foreground sequence restored after each painted keyword;
 * pass the surrounding text color when decorating already-colored content (e.g.
 * a themed message bubble) so the gradient does not bleed into the rest of the
 * line. Defaults to a plain foreground reset for default-colored editor text.
 *
 * `phase` ∈ [0, 1) cyclically rotates each gradient — the editor passes a
 * `Date.now()`-derived value to animate a Claude-Code-style shimmer while a
 * keyword is on screen and the prompt is focused; sent message bubbles omit it
 * to keep the static gradient.
 */
export function highlightMagicKeywords(text: string, resetTo?: string, phase?: number): string {
	return highlightJevify(
		highlightWorkflow(
			highlightOrchestrate(highlightUltrathink(text, resetTo, phase), resetTo, phase),
			resetTo,
			phase,
		),
		resetTo,
		phase,
	);
}

/**
 * Cheap test for "does this text contain any magic keyword as standalone prose?".
 * Short-circuits on a substring probe before paying for the markdown-aware
 * prose check, so the common "no keyword in buffer" path is just four
 * `String#indexOf`s. Used by the live editor to gate the shimmer timer.
 */
const MAGIC_DECORATORS: readonly { regex: RegExp; decorate: KeywordDecorator }[] = [
	{ regex: magicKeywordRegex("ultrathink", "g"), decorate: decorateUltrathink },
	{ regex: magicKeywordRegex("orchestrate", "g"), decorate: decorateOrchestrate },
	{ regex: magicKeywordRegex("workflowz", "g"), decorate: decorateWorkflow },
	{ regex: magicKeywordRegex("jevify", "g"), decorate: decorateJevify },
];

/** Produce styled prose slices for the editor's run-decoration seam. */
export function magicKeywordRuns(text: string, base: Style = Style.NONE, phase: number = 0): readonly GradientRun[] {
	if (!hasMagicKeyword(text)) return [{ text, style: base }];
	const masked = maskNonProse(text);
	const matches: Array<{ start: number; end: number; decorate: KeywordDecorator }> = [];
	for (const entry of MAGIC_DECORATORS) {
		entry.regex.lastIndex = 0;
		for (const match of masked.matchAll(entry.regex)) {
			const start = match.index ?? 0;
			matches.push({ start, end: start + match[0].length, decorate: entry.decorate });
		}
	}
	matches.sort((a, b) => a.start - b.start);
	const runs: GradientRun[] = [];
	let last = 0;
	for (const match of matches) {
		if (match.start < last) continue;
		if (match.start > last) runs.push({ text: text.slice(last, match.start), style: base });
		runs.push(...match.decorate(text.slice(match.start, match.end), base, phase));
		last = match.end;
	}
	if (last < text.length) runs.push({ text: text.slice(last), style: base });
	return runs;
}

export function hasMagicKeyword(text: string): boolean {
	if (
		!text.includes("ultrathink") &&
		!text.includes("orchestrate") &&
		!text.includes("workflowz") &&
		!text.includes("jevify")
	) {
		return false;
	}
	return containsUltrathink(text) || containsOrchestrate(text) || containsWorkflow(text) || containsJevify(text);
}
