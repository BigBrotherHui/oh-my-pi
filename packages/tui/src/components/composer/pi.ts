import { spaces } from "../../core/out";
import type { Out } from "../../core/richtext";
import { Style } from "../../core/style";
import {
	type ComposerChromeContext,
	type ComposerRowContext,
	type ComposerStyle,
	paintComposerContent,
	paintComposerStyled,
	paintComposerText,
} from "./types";

export function paintPiRule(out: Out, ctx: ComposerChromeContext): boolean {
	paintComposerStyled(out, ctx.box.horizontal.repeat(ctx.width), ctx.borderStyle);
	out.br();
	return true;
}

export function paintPiRow(out: Out, ctx: ComposerRowContext): void {
	const inset = piComposerStyle.sideChromeWidth(ctx.paddingX);
	if (inset > 0) out.push(Style.NONE, spaces(inset));
	if (ctx.gutterStyle) out.push(ctx.gutterStyle, ctx.gutter);
	else paintComposerText(out, ctx.gutter);
	paintComposerContent(out, ctx);
	paintComposerText(out, ctx.pad);
	out.br();
}

export const piComposerStyle: ComposerStyle = {
	id: "pi",
	sideBorders: false,
	verticalChrome: 2,
	statusAttachment: "none",
	bottomBar: "full",
	bottomBarGap: false,
	defaultPromptGutter: undefined,
	defaultPaddingX() {
		return 1;
	},
	sideChromeWidth(paddingX) {
		return paddingX;
	},
	paintTop: paintPiRule,
	paintRow: paintPiRow,
	paintBottom: paintPiRule,
};
