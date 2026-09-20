import { bandComposerStyle } from "./band";
import { borderlessComposerStyle } from "./borderless";
import { boxComposerStyle } from "./box";
import { claudeComposerStyle } from "./claude";
import { fieldComposerStyle } from "./field";
import { piComposerStyle } from "./pi";
import { railComposerStyle } from "./rail";
import { ruleComposerStyle } from "./rule";
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle, EditorBorderStyle } from "./types";
import type { Out } from "../../core/richtext";

const BUILTIN_COMPOSER_STYLES: Readonly<Record<string, ComposerStyle>> = {
	box: boxComposerStyle,
	band: bandComposerStyle,
	claude: claudeComposerStyle,
	pi: piComposerStyle,
	borderless: borderlessComposerStyle,
	rule: ruleComposerStyle,
	field: fieldComposerStyle,
	rail: railComposerStyle,
};
const extensionComposerStyles = new Map<string, ComposerStyle>();

export function isBuiltinComposerStyle(id: string): boolean {
	return Object.hasOwn(BUILTIN_COMPOSER_STYLES, id);
}

export function isFilledComposerStyle(style: ComposerStyle): boolean {
	return style.filledSurface ?? !isBuiltinComposerStyle(style.id);
}

export function registerComposerStyle(style: ComposerStyle): () => void {
	const id = style.id.trim();
	if (id.length === 0 || id !== style.id) throw new TypeError("Composer style id must be a non-empty trimmed string");
	if (isBuiltinComposerStyle(id)) throw new Error(`Cannot replace built-in composer style "${id}"`);
	if (extensionComposerStyles.has(id)) throw new Error(`Composer style "${id}" is already registered`);
	extensionComposerStyles.set(id, style);
	return () => {
		if (extensionComposerStyles.get(id) === style) extensionComposerStyles.delete(id);
	};
}

export function getComposerStyle(id: EditorBorderStyle): ComposerStyle {
	return extensionComposerStyles.get(id) ?? BUILTIN_COMPOSER_STYLES[id] ?? boxComposerStyle;
}

export function paintComposerTop(style: ComposerStyle, out: Out, ctx: ComposerChromeContext): boolean {
	return style.paintTop?.(out, ctx) ?? false;
}

export function paintComposerRow(style: ComposerStyle, out: Out, ctx: ComposerRowContext): void {
	style.paintRow(out, ctx);
}

export function paintComposerBottom(style: ComposerStyle, out: Out, ctx: ComposerChromeContext): boolean {
	return style.paintBottom?.(out, ctx) ?? false;
}
