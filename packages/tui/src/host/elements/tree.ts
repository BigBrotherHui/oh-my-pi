import type { JSX } from "solid-js";
import { spaces, takeCells } from "../../core/out";
import { cellWidth, RichText } from "../../core/richtext";
import { Damage, type ElementImpl, type HostElement } from "../types";
import { registerElement } from "../registry";

/** Props for a host tree that prefixes each direct child with themed guides. */
export interface TreeProps {
	readonly children?: JSX.Element;
	readonly guides?: boolean;
	readonly indent?: number;
	/** Fraction of the continuous guide path filled before its closing tail. */
	readonly progress?: number;
	readonly tailWidth?: number;
}

function scratchFor(node: HostElement): RichText {
	if (node.state instanceof RichText) return node.state;
	const scratch = new RichText();
	node.state = scratch;
	return scratch;
}

const treeElement: ElementImpl = {
	tag: "tree",
	propDamage: () => Damage.Layout,
	paint(node, out, width, ctx) {
		const props = node.props as TreeProps;
		const guides = props.guides ?? true;
		if (!guides) {
			for (const child of node.children) ctx.paintChild(child, out, width);
			return;
		}
		const indent = Math.max(1, Math.trunc(props.indent ?? 3));
		const guideStyle = ctx.theme.style("dim");
		const scratch = scratchFor(node);
		const progressing = props.progress !== undefined;
		const tailWidth = Math.min(width, Math.max(1, Math.trunc(props.tailWidth ?? 6)));
		let totalRows = 0;
		let lastVisible = -1;
		const firstPrefixWidth = Math.max(
			indent,
			cellWidth(ctx.theme.tree.branch),
			cellWidth(ctx.theme.tree.last),
			cellWidth(ctx.theme.tree.vertical),
		);
		const childWidth = Math.max(0, width - firstPrefixWidth);
		for (let index = 0; index < node.children.length; index++) {
			const rows = ctx.measureChild(node.children[index]!, childWidth);
			if (rows > 0) lastVisible = index;
			totalRows += rows;
		}
		const fraction = Math.max(0, Math.min(1, props.progress ?? 0));
		const pathLength = totalRows + tailWidth;
		const filled =
			fraction === 0
				? 0
				: fraction === 1
					? pathLength
					: Math.max(1, Math.min(pathLength - 1, Math.round(fraction * pathLength)));
		let pathRow = 0;
		for (let index = 0; index < node.children.length; index++) {
			const child = node.children[index]!;
			const last = !progressing && index === lastVisible;
			const firstGuide = last ? ctx.theme.tree.last : ctx.theme.tree.branch;
			const continuationGuide = last ? "" : ctx.theme.tree.vertical;
			const continuationWidth = firstPrefixWidth;
			scratch.clear();
			ctx.paintChild(child, scratch, childWidth);
			scratch.finish();
			ctx.placeChild(child, { row: pathRow, col: firstPrefixWidth, width: childWidth, height: scratch.rows });
			for (let row = 0; row < scratch.rows; row++) {
				const guide = row === 0 ? firstGuide : continuationGuide;
				const prefixWidth = row === 0 ? firstPrefixWidth : continuationWidth;
				const style = progressing && pathRow < filled ? ctx.theme.style("accent") : guideStyle;
				if (guide) out.push(style, guide);
				out.push(style, spaces(Math.max(0, prefixWidth - cellWidth(guide))));
				pathRow++;
				scratch.replayRow(out, row);
				out.br();
			}
		}
		if (progressing && tailWidth > 0) {
			const tail = takeCells(ctx.theme.tree.hook + ctx.theme.tree.horizontal.repeat(tailWidth), tailWidth);
			const accentTail = takeCells(tail, Math.max(0, filled - totalRows));
			out.push(ctx.theme.style("accent"), accentTail);
			out.push(guideStyle, tail.slice(accentTail.length));
			out.br();
		}
		scratch.clear();
	},
};

registerElement(treeElement);
