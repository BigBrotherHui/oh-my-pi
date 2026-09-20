import { spaces } from "../../core/out";
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

export function paintBoxTop(out: Out, ctx: ComposerChromeContext): boolean {
	const { box, paddingX, width, topBorder } = ctx;
	paintComposerStyled(out, `${box.topLeft}${box.horizontal.repeat(paddingX)}`, ctx.borderStyle);
	const topFillWidth = Math.max(0, width - boxComposerStyle.sideChromeWidth(paddingX) * 2);
	if (!topBorder) paintComposerStyled(out, box.horizontal.repeat(topFillWidth), ctx.borderStyle);
	else if (topBorder.width <= topFillWidth) {
		paintComposerText(out, topBorder.content);
		paintComposerStyled(out, box.horizontal.repeat(topFillWidth - topBorder.width), ctx.borderStyle);
	} else {
		const truncatedWidth = paintComposerFitted(out, topBorder.content, Math.max(0, topFillWidth - 1));
		paintComposerStyled(out, box.horizontal.repeat(Math.max(0, topFillWidth - truncatedWidth)), ctx.borderStyle);
	}
	paintComposerStyled(out, `${box.horizontal.repeat(paddingX)}${box.topRight}`, ctx.borderStyle);
	out.br();
	return true;
}

export function paintBoxRow(out: Out, ctx: ComposerRowContext): void {
	const { box, paddingX, width, pad, isLastRow } = ctx;
	const rightChromeCells = Math.max(1, paddingX + 1 - ctx.cursorOverflow);
	if (isLastRow && ctx.imeSafeCursorTail) {
		paintComposerStyled(out, `${box.vertical}${spaces(paddingX)}`, ctx.borderStyle);
		if (ctx.gutterStyle) out.push(ctx.gutterStyle, ctx.gutter);
		paintComposerContent(out, ctx);
		out.br();
		paintComposerStyled(
			out,
			`${box.bottomLeft}${box.horizontal.repeat(Math.max(0, width - 2))}${box.bottomRight}`,
			ctx.borderStyle,
		);
		out.br();
		return;
	}
	if (isLastRow) {
		paintComposerStyled(
			out,
			`${box.bottomLeft}${box.horizontal}${spaces(Math.max(0, paddingX - 1))}`,
			ctx.borderStyle,
		);
		if (ctx.gutterStyle) out.push(ctx.gutterStyle, ctx.gutter);
		paintComposerContent(out, ctx);
		paintComposerText(out, pad);
		paintComposerStyled(
			out,
			`${spaces(Math.max(0, rightChromeCells - 2))}${rightChromeCells >= 2 ? box.horizontal : ""}${box.bottomRight}`,
			ctx.borderStyle,
		);
		out.br();
		return;
	}
	paintComposerStyled(out, `${box.vertical}${spaces(paddingX)}`, ctx.borderStyle);
	if (ctx.gutterStyle) out.push(ctx.gutterStyle, ctx.gutter);
	paintComposerContent(out, ctx);
	paintComposerText(out, pad);
	paintComposerStyled(
		out,
		`${spaces(Math.max(0, rightChromeCells - 1))}${ctx.scrollbarThumb ? "█" : box.vertical}`,
		ctx.borderStyle,
	);
	out.br();
}

export const boxComposerStyle: ComposerStyle = {
	id: "box",
	sideBorders: true,
	verticalChrome: 2,
	statusAttachment: "top-border",
	bottomBar: "none",
	bottomBarGap: false,
	defaultPromptGutter: undefined,
	defaultPaddingX(themePaddingX) {
		return Math.max(0, themePaddingX ?? 2);
	},
	sideChromeWidth(paddingX) {
		return paddingX + 1;
	},
	paintTop: paintBoxTop,
	paintRow: paintBoxRow,
	paintBottom() {
		return false;
	},
};
