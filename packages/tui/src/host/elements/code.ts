import { Ellipsis } from "@oh-my-pi/pi-natives";
import type { JSX } from "solid-js";
import { Clip, Wrap, pipe } from "../../core/out";
import type { Out } from "../../core/richtext";
import type { Style } from "../../core/style";
import { highlightDocumentRange, type HighlightedDocumentLine } from "../../document/highlight";
import type { TextDocument } from "../../document/types";
import { resolveSyntaxRole } from "../../style/resolve";
import type { StyleProps } from "../../style/types";
import type { Theme } from "../../theme/theme";
import { registerElement } from "../registry";
import {
	Damage,
	type ElementImpl,
	type HostContext,
	type HostElement,
	type LayoutProps,
	type PaintContext,
} from "../types";
import { paintInlineValue } from "./rail";
import { textPropDamage } from "./text";

/** Props for syntax-highlighted retained document rendering. */
export interface CodeProps extends LayoutProps, StyleProps {
	readonly document: TextDocument;
	readonly language?: string;
	/** Show generated line numbers, or map document rows to source lines; null leaves an empty gutter. */
	readonly lineNumbers?: boolean | readonly (number | null)[];
	/** One-based source line represented by document row zero; independent of the display slice. */
	readonly lineNumberStart?: number;
	/** Keep streaming line-number gutters stable before the document grows. */
	readonly lineNumberMinWidth?: number;
	/** First logical line to paint, zero-based and inclusive. */
	readonly startLine?: number;
	/** Last logical line to paint, zero-based and exclusive. */
	readonly endLine?: number;
	/** Retained inline content preceding source text on logical line zero. */
	readonly firstLinePrefix?: JSX.Element;
	readonly wrap?: boolean;
}

interface CodeState {
	document?: TextDocument;
	context?: HostContext;
	unsubscribe?: () => void;
}

function propsOf(node: HostElement): CodeProps {
	return node.props as unknown as CodeProps;
}

function stateOf(node: HostElement): CodeState {
	let state = node.state as CodeState | undefined;
	if (state === undefined) {
		state = {};
		node.state = state;
	}
	return state;
}

function bindDocument(node: HostElement, document: TextDocument): void {
	const state = stateOf(node);
	if (state.document === document) return;
	state.unsubscribe?.();
	state.document = document;
	state.unsubscribe =
		state.context === undefined
			? undefined
			: document.subscribe(() => state.context?.invalidate(node, Damage.Layout));
}

function paintRoleLine(out: Out, line: HighlightedDocumentLine, base: Style, theme: Theme): void {
	let offset = 0;
	for (const range of line.roles) {
		if (range.start > offset) out.push(base, line.text.slice(offset, range.start));
		const style = range.role === "text" ? base : resolveSyntaxRole(theme, range.role).over(base);
		out.push(style, line.text.slice(range.start, range.end));
		offset = range.end;
	}
	if (offset < line.text.length) out.push(base, line.text.slice(offset));
}

function paintCode(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = propsOf(node);
	bindDocument(node, props.document);
	const count = props.document.lineCount();
	const start = Math.max(0, Math.min(count, Math.trunc(props.startLine ?? 0)));
	const end = Math.max(start, Math.min(count, Math.trunc(props.endLine ?? count)));
	const highlighted = highlightDocumentRange(props.document, props.language, start, end);
	const base = ctx.styleOf(node);
	const labels = typeof props.lineNumbers === "object" ? props.lineNumbers : undefined;
	const numbered = props.lineNumbers === true || labels !== undefined;
	const lineNumberStart = props.lineNumberStart ?? 1;
	let numberWidth = numbered ? Math.max(1, String(Math.max(1, lineNumberStart + end - 1)).length) : 0;
	if (labels) {
		numberWidth = 1;
		for (let index = start; index < end; index++) {
			const label = labels[index];
			if (label !== undefined && label !== null) numberWidth = Math.max(numberWidth, String(label).length);
		}
	}
	if (numbered) numberWidth = Math.max(numberWidth, Math.max(0, Math.trunc(props.lineNumberMinWidth ?? 0)));
	const numberStyle = ctx.theme.style("dim").over(base);
	const boundedWidth = Math.max(0, Math.trunc(width));
	const wrap = props.wrap !== false;

	for (let offset = 0; offset < highlighted.lines.length; offset++) {
		const logicalLine = start + offset;
		const line = highlighted.lines[offset]!;
		const label = labels ? labels[logicalLine] : lineNumberStart + logicalLine;
		const gutter = numbered
			? `${(label === undefined || label === null ? "" : String(label)).padStart(numberWidth, " ")} `
			: "";
		if (wrap) {
			const sink = new Wrap(out, Math.max(1, boundedWidth));
			if (gutter.length > 0) sink.push(numberStyle, gutter);
			if (logicalLine === 0) paintInlineValue(props.firstLinePrefix, sink, base, ctx);
			paintRoleLine(sink, line, base, ctx.theme);
			sink.br();
			sink.end();
			continue;
		}
		pipe(new Clip(out, boundedWidth, Ellipsis.Omit), sink => {
			if (gutter.length > 0) sink.push(numberStyle, gutter);
			if (logicalLine === 0) paintInlineValue(props.firstLinePrefix, sink, base, ctx);
			paintRoleLine(sink, line, base, ctx.theme);
			sink.br();
		});
	}
}

/** Retained implementation of the `code` intrinsic. */
export const codeElement: ElementImpl = {
	tag: "code",
	slots: ["firstLinePrefix"],
	propDamage(name) {
		if (name === "language") return Damage.Paint;
		if (name === "color" || name === "background" || name === "style" || name === "recipe") {
			return Damage.Paint;
		}
		return textPropDamage(name);
	},
	onAttach(node, context) {
		const state = stateOf(node);
		state.context = context;
		bindDocument(node, propsOf(node).document);
	},
	onDetach(node) {
		const state = stateOf(node);
		state.unsubscribe?.();
		state.unsubscribe = undefined;
		state.context = undefined;
	},
	paint: paintCode,
};

registerElement(codeElement);
