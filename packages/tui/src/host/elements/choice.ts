import type { JSX } from "solid-js";
import { pipe, spaces, Wrap } from "../../core/out";
import { cellWidth, RichText } from "../../core/richtext";
import { registerElement } from "../registry";
import { Damage, type ElementImpl, type HostElement } from "../types";

/** Props for a checkbox or radio label. */
export interface ChoiceProps {
	readonly kind: "radio" | "checkbox";
	readonly checked?: boolean;
	readonly disabled?: boolean;
	readonly children?: JSX.Element;
}

interface ChoiceState {
	readonly source: RichText;
	readonly wrapped: RichText;
}

function choiceState(node: HostElement): ChoiceState {
	const state = node.state as ChoiceState | undefined;
	if (state?.source instanceof RichText && state.wrapped instanceof RichText) return state;
	const created = { source: new RichText(), wrapped: new RichText() };
	node.state = created;
	return created;
}

const choiceElement: ElementImpl = {
	tag: "choice",
	propDamage: name => (name === "checked" || name === "disabled" || name === "color" ? Damage.Paint : Damage.Layout),
	paint(node, out, width, ctx) {
		const props = node.props as unknown as ChoiceProps;
		const checked = props.checked ?? false;
		const glyph =
			props.kind === "radio"
				? checked
					? ctx.theme.radio.selected
					: ctx.theme.radio.unselected
				: checked
					? ctx.theme.checkbox.checked
					: ctx.theme.checkbox.unchecked;
		const base = ctx.styleOf(node);
		const glyphStyle = ctx.theme.style(props.disabled ? "dim" : checked ? "accent" : "muted").over(base);
		const prefixWidth = cellWidth(glyph) + 1;
		const contentWidth = Math.max(0, width - prefixWidth);
		const state = choiceState(node);
		state.source.clear();
		state.wrapped.clear();
		for (const child of node.children) ctx.paintChild(child, state.source, contentWidth);
		state.source.finish();
		pipe(new Wrap(state.wrapped, Math.max(1, contentWidth)), sink => state.source.replay(sink));
		state.wrapped.finish();
		if (state.wrapped.rows === 0) {
			out.push(glyphStyle, glyph);
			out.br();
			return;
		}
		for (let row = 0; row < state.wrapped.rows; row++) {
			if (row === 0) {
				out.push(glyphStyle, glyph);
				out.push(base, " ");
			} else {
				out.push(base, spaces(prefixWidth));
			}
			state.wrapped.replayRow(out, row);
			out.br();
		}
		state.source.clear();
		state.wrapped.clear();
	},
};

registerElement(choiceElement);
