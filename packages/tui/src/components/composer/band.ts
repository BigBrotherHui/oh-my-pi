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

export function paintBandTop(out: Out, ctx: ComposerChromeContext): boolean {
	const { topBorder, width } = ctx;
	if (topBorder?.content) {
		if (topBorder.width > width) paintComposerFitted(out, topBorder.content, width);
		else paintComposerText(out, topBorder.content);
	}
	out.br();
	return true;
}

export function paintBandRow(out: Out, ctx: ComposerRowContext): void {
	if (ctx.gutter) {
		if (ctx.gutterStyle) out.push(ctx.gutterStyle, ctx.gutter);
		else paintComposerStyled(out, ctx.gutter, ctx.borderStyle);
	}
	paintComposerContent(out, ctx);
	paintComposerText(out, ctx.pad);
	out.br();
}

export const bandComposerStyle: ComposerStyle = {
	id: "band",
	sideBorders: false,
	verticalChrome: 1,
	statusAttachment: "top-band",
	bottomBar: "none",
	bottomBarGap: false,
	defaultPromptGutter: "╰─ ",
	defaultPaddingX() {
		return 0;
	},
	sideChromeWidth() {
		return 0;
	},
	paintTop: paintBandTop,
	paintRow: paintBandRow,
	paintBottom() {
		return false;
	},
};
