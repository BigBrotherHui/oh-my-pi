import { spaces } from "../../core/out";
import type { Out } from "../../core/richtext";
import {
	type ComposerRowContext,
	type ComposerStyle,
	paintComposerContent,
	paintComposerStyled,
	paintComposerSurface,
} from "./types";

const ACCENT_RAIL = "▎";

export function paintRailRow(out: Out, ctx: ComposerRowContext): void {
	paintComposerStyled(out, ACCENT_RAIL, ctx.accentStyle);
	if (ctx.paddingX > 0) paintComposerSurface(out, spaces(ctx.paddingX), ctx);
	if (ctx.gutterStyle)
		out.push(ctx.surfaceStyle ? ctx.gutterStyle.over(ctx.surfaceStyle) : ctx.gutterStyle, ctx.gutter);
	else paintComposerSurface(out, ctx.gutter, ctx);
	paintComposerContent(out, ctx, true);
	if (ctx.imeSafeCursorTail) {
		out.br();
		return;
	}
	paintComposerSurface(out, ctx.pad, ctx);
	const rightFillCells = Math.max(0, ctx.paddingX + 1 - ctx.cursorOverflow);
	if (ctx.scrollbarThumb && rightFillCells > 0) {
		if (rightFillCells > 1) paintComposerSurface(out, spaces(rightFillCells - 1), ctx);
		paintComposerStyled(out, "█", ctx.accentStyle);
	} else if (rightFillCells > 0) {
		paintComposerSurface(out, spaces(rightFillCells), ctx);
	}
	out.br();
}

export const railComposerStyle: ComposerStyle = {
	id: "rail",
	filledSurface: true,
	sideBorders: true,
	verticalChrome: 0,
	statusAttachment: "none",
	bottomBar: "full",
	bottomBarGap: true,
	defaultPromptGutter: undefined,
	defaultPaddingX() {
		return 1;
	},
	sideChromeWidth(paddingX) {
		return paddingX + 1;
	},
	paintTop() {
		return false;
	},
	paintRow: paintRailRow,
	paintBottom() {
		return false;
	},
};
