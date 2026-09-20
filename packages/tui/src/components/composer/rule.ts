import type { Out } from "../../core/richtext";
import {
	type ComposerChromeContext,
	type ComposerRowContext,
	type ComposerStyle,
	paintComposerContent,
	paintComposerFitted,
	paintComposerStyled,
	paintComposerText,
} from "./types";

export function paintTopRule(out: Out, ctx: ComposerChromeContext): boolean {
	const { box, width, topBorder } = ctx;
	if (topBorder && topBorder.width > 0 && width > 2) {
		const chipWidth = Math.min(topBorder.width, width - 2);
		const leftFill = Math.max(0, width - chipWidth - 1);
		paintComposerStyled(out, box.horizontal.repeat(leftFill), ctx.borderStyle);
		if (topBorder.width > width - 2) paintComposerFitted(out, topBorder.content, width - 2);
		else paintComposerText(out, topBorder.content);
		paintComposerStyled(out, box.horizontal, ctx.borderStyle);
	} else {
		paintComposerStyled(out, box.horizontal.repeat(width), ctx.borderStyle);
	}
	out.br();
	return true;
}

export function paintRuleRow(out: Out, ctx: ComposerRowContext): void {
	if (ctx.gutterStyle) out.push(ctx.gutterStyle, ctx.gutter);
	else paintComposerText(out, ctx.gutter);
	paintComposerContent(out, ctx);
	paintComposerText(out, ctx.pad);
	out.br();
}

export const ruleComposerStyle: ComposerStyle = {
	id: "rule",
	sideBorders: false,
	verticalChrome: 1,
	statusAttachment: "top-rule-chip",
	bottomBar: "left",
	bottomBarGap: true,
	defaultPromptGutter: "❯ ",
	defaultPaddingX() {
		return 0;
	},
	sideChromeWidth(paddingX) {
		return paddingX;
	},
	paintTop: paintTopRule,
	paintRow: paintRuleRow,
	paintBottom() {
		return false;
	},
};
