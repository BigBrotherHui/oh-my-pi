import { Ellipsis } from "@oh-my-pi/pi-natives";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { parseAnsiRow } from "../../core/ansi";
import { Clip, Wrap, over, pipe } from "../../core/out";
import { type Out, RichText } from "../../core/richtext";
import type { Style } from "../../core/style";
import type { TextDocument } from "../../document/types";
import type { StyleProps } from "../../style/types";
import { registerElement } from "../registry";
import {
	Damage,
	type ElementImpl,
	type HostContext,
	type HostElement,
	type LayoutProps,
	type PaintContext,
} from "../types";
import { textPropDamage } from "./text";

/** Props for PTY-safe preformatted document rendering. */
export interface PreProps extends LayoutProps, StyleProps {
	readonly document: TextDocument;
	/** Interpret external ANSI explicitly; false strips escape/control sequences. */
	readonly ansi?: boolean;
	/** Cap plain or ANSI-styled display rows without touching the source document. */
	readonly maxLineCells?: number;
	readonly wrap?: boolean;
	/** Marker emitted when an unwrapped row exceeds its display budget. */
	readonly ellipsis?: Ellipsis;
	/** Explicit styling for the overflow marker, independent of document content. */
	readonly ellipsisStyle?: Style;
}

interface PreProjection {
	version: number;
	ansi: boolean;
	plain: readonly string[];
	styled?: readonly RichText[];
}

interface PreState {
	document?: TextDocument;
	context?: HostContext;
	unsubscribe?: () => void;
	projection?: PreProjection;
}

function propsOf(node: HostElement): PreProps {
	return node.props as unknown as PreProps;
}

function stateOf(node: HostElement): PreState {
	let state = node.state as PreState | undefined;
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
	state.projection = undefined;
	state.unsubscribe =
		state.context === undefined
			? undefined
			: document.subscribe(() => {
					state.projection = undefined;
					state.context?.invalidate(node, Damage.Layout);
				});
}

function projection(node: HostElement, props: PreProps): PreProjection {
	const state = stateOf(node);
	const version = props.document.version();
	const ansi = props.ansi === true;
	const cached = state.projection;
	if (cached !== undefined && cached.version === version && cached.ansi === ansi) return cached;
	const plain = new Array<string>(props.document.lineCount());
	const styled = ansi ? new Array<RichText>(plain.length) : undefined;
	for (let line = 0; line < plain.length; line++) {
		const source = props.document.line(line);
		if (styled === undefined) {
			plain[line] = sanitizeText(source);
			continue;
		}
		plain[line] = "";
		const rich = new RichText();
		parseAnsiRow(source, rich);
		rich.br();
		styled[line] = rich;
	}
	const next: PreProjection = { version, ansi, plain, styled };
	state.projection = next;
	return next;
}

function paintPre(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = propsOf(node);
	bindDocument(node, props.document);
	const projected = projection(node, props);
	const base = ctx.styleOf(node);
	const boundedWidth = Math.max(0, Math.trunc(width));
	const cappedWidth =
		props.maxLineCells === undefined
			? boundedWidth
			: Math.min(boundedWidth, Math.max(0, Math.trunc(props.maxLineCells)));
	for (let line = 0; line < projected.plain.length; line++) {
		const sink =
			props.wrap === true
				? new Wrap(out, Math.max(1, cappedWidth))
				: new Clip(out, cappedWidth, props.ellipsis ?? Ellipsis.Omit);
		if (sink instanceof Clip && props.ellipsisStyle) sink.ellipsisStyle = props.ellipsisStyle;
		pipe(sink, row => {
			const styled = projected.styled?.[line];
			if (styled === undefined) row.push(base, projected.plain[line]!);
			else styled.replayRow(over(row, base), 0);
			row.br();
		});
	}
}

/** Retained implementation of the `pre` intrinsic. */
export const preElement: ElementImpl = {
	tag: "pre",
	propDamage(name) {
		if (name === "ansi" || name === "maxLineCells" || name === "wrap" || name === "ellipsis" || name === "document")
			return Damage.Layout;
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
	paint: paintPre,
};

registerElement(preElement);
