import { takeCells } from "../../core/out";
import { cellWidth } from "../../core/richtext";
import type { Style } from "../../core/style";
import { registerElement } from "../registry";
import { Damage, type ElementImpl } from "../types";

/** One tab in a controlled tab strip. */
export interface TabItem {
	readonly id: string;
	readonly label: string;
	readonly short?: string;
	readonly disabled?: boolean;
}

/** Props for a width-aware controlled tab strip. */
export interface TabsProps {
	readonly tabs: readonly TabItem[];
	readonly active?: string;
	readonly label?: string;
	readonly showHint?: boolean;
	readonly hint?: string;
	/** When false, keep one row and collapse to the active tab if the complete strip cannot fit. */
	readonly wrap?: boolean;
}

interface Chunk {
	readonly text: string;
	readonly style: Style;
}

function chunkText(text: string, width: number): string {
	if (cellWidth(text) <= width) return text;
	if (width <= 1) return width === 1 ? "…" : "";
	return `${takeCells(text, width - 1)}…`;
}

const tabsElement: ElementImpl = {
	tag: "tabs",
	propDamage: name => (name === "active" || name === "color" || name === "background" ? Damage.Paint : Damage.Layout),
	paint(node, out, width, ctx) {
		const props = node.props as unknown as TabsProps;
		const base = ctx.styleOf(node);
		const fullWidth =
			props.tabs.reduce((sum, tab) => sum + cellWidth(` ${tab.label} `), 0) +
			Math.max(0, props.tabs.length - 1) * 2 +
			(props.label ? cellWidth(`${props.label}:  `) : 0);
		const compact = fullWidth > width;
		const chunks: Chunk[] = [];
		if (props.label) chunks.push({ text: `${props.label}:  `, style: ctx.theme.style("muted").over(base) });
		for (let index = 0; index < props.tabs.length; index++) {
			const tab = props.tabs[index]!;
			if (index > 0) chunks.push({ text: "  ", style: base });
			const active = tab.id === props.active;
			const label = compact && !active && tab.short ? tab.short : tab.label;
			const style = tab.disabled
				? ctx.theme.style("dim").over(base)
				: active
					? ctx.theme.style("accent").over(base)
					: ctx.theme.style("muted").over(base);
			chunks.push({ text: ` ${label} `, style });
		}
		if (props.wrap === false && chunks.reduce((sum, chunk) => sum + cellWidth(chunk.text), 0) > width) {
			chunks.length = 0;
			if (props.label) chunks.push({ text: `${props.label}:  `, style: ctx.theme.style("muted").over(base) });
			const active = props.tabs.find(tab => tab.id === props.active) ?? props.tabs[0];
			if (active)
				chunks.push({
					text: ` ${active.label} `,
					style: ctx.theme.style(active.disabled ? "dim" : "accent").over(base),
				});
		}
		if (props.showHint) {
			const hint = `  ${props.hint ?? "(tab to cycle)"}`;
			if (
				props.wrap !== false ||
				chunks.reduce((sum, chunk) => sum + cellWidth(chunk.text), 0) + cellWidth(hint) <= width
			)
				chunks.push({ text: hint, style: ctx.theme.style("dim").over(base) });
		}
		let used = 0;
		for (const chunk of chunks) {
			const chunkWidth = cellWidth(chunk.text);
			if (props.wrap !== false && used > 0 && used + chunkWidth > width) {
				out.br();
				used = 0;
			}
			const available = Math.max(0, width - used);
			const text = chunkText(chunk.text, available);
			out.push(chunk.style, text);
			used += cellWidth(text);
		}
		out.br();
	},
};

registerElement(tabsElement);
