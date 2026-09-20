import { Ellipsis } from "@oh-my-pi/pi-natives";
import { skipCells, takeCells } from "../../core/out";
import { cellWidth, type Out } from "../../core/richtext";
import { Style } from "../../core/style";
import { fileHyperlinkStyle } from "../../render/hyperlink";
import { shortenPath } from "../../render/render-utils";
import { truncateToWidth } from "../../utils";
import type { StyleProps } from "../../style/types";
import { Damage, type ElementImpl, type HostElement, type PaintContext } from "../types";
import { registerElement } from "../registry";
import { textPropDamage } from "./text";

/** Props for a shortened, linked filesystem path. */
export interface PathProps extends StyleProps {
	readonly value: string;
	readonly target?: string;
	/** One-based destination line for editor-aware filesystem links. */
	readonly line?: number;
	readonly overflow?: "clip" | "ellipsis" | "middle";
	readonly ellipsis?: Ellipsis;
}

function fitPath(value: string, width: number, overflow: PathProps["overflow"], ellipsis: Ellipsis): string {
	if (width <= 0) return "";
	const total = cellWidth(value);
	if (total <= width) return value;
	if (overflow === "clip") return takeCells(value, width);
	if (width === 1) return "…";
	if (overflow !== "middle") return truncateToWidth(value, width, ellipsis);
	const content = width - 1;
	const left = Math.floor(content / 2);
	const right = content - left;
	return `${takeCells(value, left)}…${skipCells(value, total - right)}`;
}

function pushPath(node: HostElement, out: Out, width: number, base: Style, ctx: PaintContext): void {
	const props = node.props as unknown as PathProps;
	const value = shortenPath(props.value);
	const shown = fitPath(
		value,
		Math.max(0, Math.trunc(width)),
		props.overflow ?? "middle",
		props.ellipsis ?? Ellipsis.Unicode,
	);
	const style = fileHyperlinkStyle(
		props.target ?? props.value,
		props.line === undefined ? undefined : { line: props.line },
		ctx.styleOf(node).over(base),
	);
	out.push(style, shown);
}

function paintPath(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	pushPath(node, out, width, Style.NONE, ctx);
	out.br();
}

/** Inline use (inside `text`): the enclosing row owns clipping, so the full shortened path is emitted. */
function paintPathInline(node: HostElement, out: Out, base: Style, ctx: PaintContext): void {
	pushPath(node, out, Number.MAX_SAFE_INTEGER, base, ctx);
}

function pathDamage(name: string): Damage {
	if (name === "target" || name === "line") return Damage.Link;
	if (name === "value") return Damage.Text;
	if (name === "overflow" || name === "ellipsis") return Damage.Layout;
	return textPropDamage(name);
}

/** Retained implementation of the linked `path` intrinsic. */
export const pathElement: ElementImpl = {
	tag: "path",
	inline: true,
	propDamage: pathDamage,
	paint: paintPath,
	paintInline: paintPathInline,
};

registerElement(pathElement);
