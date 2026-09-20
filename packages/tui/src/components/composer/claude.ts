import type { Out } from "../../core/richtext";
import { paintTopRule } from "./rule";
import {
	type ComposerChromeContext,
	type ComposerRowContext,
	type ComposerStyle,
	paintComposerContent,
	paintComposerStyled,
	paintComposerText,
} from "./types";

export function paintClaudeRow(out: Out, ctx: ComposerRowContext): void {
	if (ctx.gutterStyle) out.push(ctx.gutterStyle, ctx.gutter);
	else paintComposerText(out, ctx.gutter);
	paintComposerContent(out, ctx);
	paintComposerText(out, ctx.pad);
	out.br();
}

export function paintClaudeBottom(out: Out, ctx: ComposerChromeContext): boolean {
	paintComposerStyled(out, ctx.box.horizontal.repeat(ctx.width), ctx.borderStyle);
	out.br();
	return true;
}

export const claudeComposerStyle: ComposerStyle = {
	id: "claude",
	sideBorders: false,
	verticalChrome: 2,
	statusAttachment: "top-rule-chip",
	bottomBar: "left",
	bottomBarGap: false,
	defaultPromptGutter: "❯ ",
	defaultPaddingX() {
		return 0;
	},
	sideChromeWidth(paddingX) {
		return paddingX;
	},
	paintTop: paintTopRule,
	paintRow: paintClaudeRow,
	paintBottom: paintClaudeBottom,
};
