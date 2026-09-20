import { spaces } from "../../core/out";
import type { Out } from "../../core/richtext";
import {
	type ComposerRowContext,
	type ComposerStyle,
	paintComposerContent,
	paintComposerStyled,
	paintComposerSurface,
} from "./types";

const LEFT_CAP = "▐";
const RIGHT_CAP = "▌";

export function paintFieldRow(out: Out, ctx: ComposerRowContext): void {
	paintComposerStyled(out, LEFT_CAP, ctx.accentStyle);
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
	const rightChromeCells = Math.max(1, ctx.paddingX + 1 - ctx.cursorOverflow);
	if (rightChromeCells > 1) paintComposerSurface(out, spaces(rightChromeCells - 1), ctx);
	paintComposerStyled(out, ctx.scrollbarThumb ? "█" : RIGHT_CAP, ctx.accentStyle);
	out.br();
}

export const fieldComposerStyle: ComposerStyle = {
	id: "field",
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
	paintRow: paintFieldRow,
	paintBottom() {
		return false;
	},
};
