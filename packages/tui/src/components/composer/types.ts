import { Ellipsis } from "@oh-my-pi/pi-natives";
import type { SymbolTheme } from "../../symbols";
import { Clip, over } from "../../core/out";
import { type Out, RichText } from "../../core/richtext";
import { Style } from "../../core/style";

/** Box-drawing glyph set used for composer chrome (the theme's `boxRound`). */
export type ComposerBox = SymbolTheme["boxRound"];

/** Built-in composer shape identifiers shipped by pi-tui. */
export const BUILTIN_EDITOR_BORDER_STYLES = [
	"box",
	"band",
	"claude",
	"pi",
	"borderless",
	"rule",
	"field",
	"rail",
] as const;

/** Identifier for a built-in composer shape. */
export type BuiltinEditorBorderStyle = (typeof BUILTIN_EDITOR_BORDER_STYLES)[number];

/** Composer shape identifier; extensions may register additional strings. */
export type EditorBorderStyle = string;

/** Run-native status content injected into the top chrome. */
export interface EditorTopBorder {
	readonly content: RichText;
	readonly width: number;
	readonly revision?: number;
}

/** Inputs shared by every chrome row. */
export interface ComposerChromeContext {
	readonly width: number;
	readonly paddingX: number;
	readonly borderStyle: Style;
	readonly accentStyle: Style;
	readonly surfaceStyle: Style;
	readonly box: ComposerBox;
	readonly topBorder?: EditorTopBorder;
}

/** Inputs for one content row. */
export interface ComposerRowContext extends ComposerChromeContext {
	readonly text: string;
	readonly content?: RichText;
	readonly contentRow?: number;
	readonly pad: string;
	readonly gutter: string;
	readonly gutterStyle?: Style;
	readonly isLastRow: boolean;
	readonly cursorOverflow: number;
	readonly imeSafeCursorTail: boolean;
	readonly scrollbarThumb: boolean;
}

export interface ComposerStyle {
	readonly id: EditorBorderStyle;
	readonly filledSurface?: boolean;
	readonly sideBorders: boolean;
	readonly verticalChrome: 0 | 1 | 2;
	readonly statusAttachment: "top-border" | "top-band" | "top-rule-chip" | "none";
	readonly bottomBar: "none" | "left" | "full";
	readonly bottomBarGap: boolean;
	readonly defaultPromptGutter: string | undefined;
	defaultPaddingX(themePaddingX: number | undefined): number;
	sideChromeWidth(paddingX: number): number;
	paintTop?(out: Out, ctx: ComposerChromeContext): boolean;
	paintRow(out: Out, ctx: ComposerRowContext): void;
	paintBottom?(out: Out, ctx: ComposerChromeContext): boolean;
}

export function paintComposerText(out: Out, text: string | RichText): void {
	if (typeof text === "string") out.push(Style.NONE, text);
	else text.replayRow(out, 0);
}

export function paintComposerStyled(out: Out, text: string, style: Style): void {
	out.push(style, text);
}

export function paintComposerContent(out: Out, ctx: ComposerRowContext, surface = false): void {
	if (ctx.content) {
		ctx.content.replayRow(surface && ctx.surfaceStyle ? over(out, ctx.surfaceStyle) : out, ctx.contentRow ?? 0);
		return;
	}
	if (surface) paintComposerSurface(out, ctx.text, ctx);
	else paintComposerText(out, ctx.text);
}

export function paintComposerSurface(out: Out, text: string, ctx: ComposerChromeContext): void {
	out.push(ctx.surfaceStyle, text);
}

export function paintComposerFitted(
	out: Out,
	source: RichText,
	width: number,
	ellipsis: Ellipsis = Ellipsis.Unicode,
): number {
	const fitted = new RichText();
	const safeWidth = Math.max(0, width);
	const clip = new Clip(fitted, safeWidth, ellipsis);
	source.replayRow(clip, 0);
	clip.br();
	if ((source.rowWidth[0] ?? 0) > safeWidth && ellipsis !== Ellipsis.Omit && fitted.runs > 0) {
		fitted.style[fitted.runs - 1] = Style.NONE;
	}
	fitted.replayRow(out, 0);
	return fitted.rowWidth[0] ?? 0;
}
