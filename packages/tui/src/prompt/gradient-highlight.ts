import { maskNonProse } from "./markdown-prose";
import { colorToAnsi, detectColorMode, FG_RESET } from "../theme/color";
import { theme } from "../theme/theme";
import { DEFAULT_COLOR, parseColor, Style, type Color } from "../core/style";

/** A gradient keyword highlighter.
 *
 * - `resetTo` is the SGR foreground sequence re-emitted after each painted
 *   keyword so surrounding text keeps its color; it defaults to a plain
 *   foreground reset (editor / default-colored text).
 * - `phase` ∈ [0, 1) rotates the gradient stops cyclically; pass `Date.now()`-
 *   derived values to animate a shimmer. Defaults to `0` (the static
 *   sent-bubble palette). */
export type KeywordHighlighter = (text: string, resetTo?: string, phase?: number) => string;

/** One styled slice produced by a gradient decoration. */
export interface GradientRun {
	readonly text: string;
	readonly style: Style;
}

/** Run-level decoration producer consumed by the whitelisted editor seam. */
export type KeywordDecorator = (text: string, base?: Style, phase?: number) => readonly GradientRun[];

/** Declarative spec for {@link createGradientHighlighter}. */
export interface GradientHighlightSpec {
	/** Cheap, stateless presence probe used to skip the boundary regex on most lines. Must be non-global. */
	probe: RegExp;
	/** Global, word-bounded match regex walked by `.replace`. */
	highlight: RegExp;
	/** Number of color stops swept across the gradient. */
	stops: number;
	/** Maps a normalized position `t` in [0, 1) to an HSL hue in degrees. */
	hue: (t: number) => number;
	/** HSL saturation percentage. Default 90. */
	saturation?: number;
	/** HSL lightness percentage. Default 62. */
	lightness?: number;
}

/**
 * Build a style producer for standalone matches of `highlight`.
 * RGB styles stay packed until the editor host emits the decorated runs.
 */
export function createGradientDecorator(spec: GradientHighlightSpec): KeywordDecorator {
	const { probe, highlight, stops, hue, saturation = 90, lightness = 62 } = spec;
	let cachedPalette: readonly Color[] | undefined;

	const palette = (): readonly Color[] => {
		if (cachedPalette !== undefined) return cachedPalette;
		const next: Color[] = [];
		for (let i = 0; i < stops; i++) {
			next.push(parseColor(`hsl(${Math.round(hue(i / stops))}, ${saturation}%, ${lightness}%)`));
		}
		cachedPalette = next;
		return next;
	};

	return (text: string, base: Style = Style.NONE, phase: number = 0): readonly GradientRun[] => {
		if (!probe.test(text)) return [{ text, style: base }];
		const wrappedPhase = ((phase % 1) + 1) % 1;
		const masked = maskNonProse(text);
		const colors = palette();
		const runs: GradientRun[] = [];
		let last = 0;
		for (const match of masked.matchAll(highlight)) {
			const start = match.index ?? 0;
			const word = text.slice(start, start + match[0].length);
			if (start > last) runs.push({ text: text.slice(last, start), style: base });
			for (let index = 0; index < word.length; index++) {
				const t = (index / word.length + wrappedPhase) % 1;
				const color = colors[Math.floor(t * colors.length) % colors.length] ?? colors[0];
				runs.push({ text: word[index]!, style: color === undefined ? base : base.with({ fg: color }) });
			}
			last = start + word.length;
		}
		if (last < text.length) runs.push({ text: text.slice(last), style: base });
		return runs;
	};
}

/**
 * Build a stateless highlighter that paints each standalone match of `highlight`
 * with a smooth HSL gradient for editor display. The returned function adds only
 * zero-width SGR escapes — the visible width is unchanged — and returns the input
 * untouched when `probe` does not match. The palette is compiled lazily and
 * memoized per active color mode.
 */
export function createGradientHighlighter(spec: GradientHighlightSpec): KeywordHighlighter {
	const decorate = createGradientDecorator(spec);
	return (text: string, resetTo: string = FG_RESET, phase: number = 0): string => {
		if (!spec.probe.test(text)) return text;
		const runs = decorate(text, Style.NONE, phase);
		if (!runs.some(run => run.style.fg !== DEFAULT_COLOR)) return text;
		const mode = typeof theme === "undefined" ? detectColorMode() : theme.getColorMode();
		let rendered = "";
		let activeColor: Color = DEFAULT_COLOR;
		for (const run of runs) {
			if (run.style.fg !== activeColor) {
				activeColor = run.style.fg;
				rendered +=
					activeColor === DEFAULT_COLOR
						? resetTo
						: colorToAnsi(`#${(activeColor & 0xffffff).toString(16).padStart(6, "0")}`, mode);
			}
			rendered += run.text;
		}
		return activeColor === DEFAULT_COLOR ? rendered : `${rendered}${resetTo}`;
	};
}
