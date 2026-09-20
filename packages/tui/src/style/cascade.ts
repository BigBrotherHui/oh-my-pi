import { Attr, type Color, linkId, Style } from "../core/style";
import { Damage, type HostElement, type PaintContext } from "../host/types";
import type { ThemeBg, ThemeColor } from "../theme/schema";
import type { Theme } from "../theme/theme";
import { getRecipe } from "./recipes";
import { resolveBackground, resolveForeground } from "./resolve";
import type { StyleProps, TextStyleProps } from "./types";

interface CascadeState {
	style: Style;
	color: ThemeColor | Color | undefined;
	background: ThemeBg | Color | undefined;
}

interface StyleCacheEntry extends CascadeState {
	theme: Theme;
	inheritedKey: string;
}

const kStyleCache = Symbol("host.styleCache");

interface StyledHostElement extends HostElement {
	[kStyleCache]?: StyleCacheEntry;
}

const ATTR_PROPS: readonly (readonly [keyof TextStyleProps, Attr])[] = [
	["bold", Attr.Bold],
	["dim", Attr.Dim],
	["italic", Attr.Italic],
	["underline", Attr.Underline],
	["undercurl", Attr.Undercurl],
	["strike", Attr.Strike],
	["inverse", Attr.Inverse],
	["blink", Attr.Blink],
];

function applyProps(state: CascadeState, props: StyleProps | undefined, theme: Theme): void {
	if (props === undefined) return;
	let colorsChanged = false;
	if (props.background !== undefined) {
		state.background = props.background;
		colorsChanged = true;
	}
	if (props.color !== undefined) {
		state.color = props.color;
		colorsChanged = true;
	}
	if (colorsChanged) {
		const bg = state.background === undefined ? state.style.bg : resolveBackground(theme, state.background);
		const fg = state.color === undefined ? state.style.fg : resolveForeground(theme, state.color, state.background);
		state.style = state.style.with({ fg, bg });
	}

	let attrs = state.style.attrs;
	for (const [name, attr] of ATTR_PROPS) {
		const value = props[name];
		if (value === true) attrs |= attr;
		else if (value === false) attrs &= ~attr;
	}
	if (attrs !== state.style.attrs) state.style = state.style.withAttrs(attrs);
	if (props.link !== undefined) state.style = state.style.withLink(linkId(props.link));
}

function inheritText(state: CascadeState, parent: StyleCacheEntry, theme: Theme): void {
	state.color = parent.color ?? parent.style.fg;
	const fg = resolveForeground(theme, state.color, state.background);
	state.style = state.style.with({
		fg,
		attrs: parent.style.attrs,
		ul: parent.style.ul,
		link: parent.style.link,
	});
}

function inheritanceKey(entry: StyleCacheEntry): string {
	const color = entry.color;
	return `${entry.style.id}:${typeof color}:${String(color)}`;
}

function computeStyle(node: HostElement, theme: Theme): StyleCacheEntry {
	const state: CascadeState = {
		style: Style.NONE,
		color: undefined,
		background: undefined,
	};

	applyProps(state, node.impl.defaultStyle, theme);
	const parent = node.parent === null ? undefined : resolveEntry(node.parent, theme);
	if (parent !== undefined) inheritText(state, parent, theme);
	applyProps(state, node.impl.variantStyle?.(node), theme);

	const recipeName = node.props.recipe;
	if (typeof recipeName === "string") applyProps(state, getRecipe(recipeName), theme);

	const local = node.props.style;
	if (local instanceof Style) {
		state.style = local;
		state.color = undefined;
		state.background = undefined;
	}
	applyProps(state, node.props as StyleProps, theme);

	return { ...state, theme, inheritedKey: parent === undefined ? "" : inheritanceKey(parent) };
}

function resolveEntry(node: HostElement, theme: Theme): StyleCacheEntry {
	const styledNode = node as StyledHostElement;
	const previous = styledNode[kStyleCache];
	const paintDirty = (node.damage & (Damage.Paint | Damage.Link)) !== 0;
	if (previous !== undefined && previous.theme === theme && !paintDirty) {
		const parent = node.parent === null ? undefined : resolveEntry(node.parent, theme);
		const inheritedKey = parent === undefined ? "" : inheritanceKey(parent);
		if (previous.inheritedKey === inheritedKey) return previous;
	}
	const resolved = computeStyle(node, theme);
	styledNode[kStyleCache] = resolved;
	return resolved;
}

/** Resolve the contract cascade for an element to an interned run style. */
export function resolveStyle(node: HostElement, ctx: Pick<PaintContext, "theme">): Style {
	return resolveEntry(node, ctx.theme).style;
}
