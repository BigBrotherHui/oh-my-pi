import type { Out } from "../../core/richtext";
import { type ComposerRowContext, type ComposerStyle, paintComposerContent, paintComposerText } from "./types";

export function paintBorderlessRow(out: Out, ctx: ComposerRowContext): void {
	if (ctx.gutterStyle) out.push(ctx.gutterStyle, ctx.gutter);
	else paintComposerText(out, ctx.gutter);
	paintComposerContent(out, ctx);
	paintComposerText(out, ctx.pad);
	out.br();
}

export const borderlessComposerStyle: ComposerStyle = {
	id: "borderless",
	sideBorders: false,
	verticalChrome: 0,
	statusAttachment: "none",
	bottomBar: "full",
	bottomBarGap: false,
	defaultPromptGutter: "❯ ",
	defaultPaddingX() {
		return 0;
	},
	sideChromeWidth() {
		return 0;
	},
	paintTop() {
		return false;
	},
	paintRow: paintBorderlessRow,
	paintBottom() {
		return false;
	},
};
