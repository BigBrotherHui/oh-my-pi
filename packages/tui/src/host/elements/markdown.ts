import {
	MarkdownEngine,
	paintInlineMarkdown,
	type MarkdownConfiguration,
	type MarkdownLayout,
	type MarkdownOptions,
	type MarkdownTheme,
} from "../../components/markdown-engine";
import { cellWidth, type Out, RichText, RunFlag } from "../../core/richtext";
import { replayCells } from "../../core/frame";
import { Wrap, pipe } from "../../core/out";
import { Attr, Style } from "../../core/style";
import type { OutputDocument, TextDocument } from "../../document/types";
import type { StyleProps } from "../../style/types";
import { createHighlightStream, getMarkdownTheme, highlightCode, type Theme } from "../../theme/theme";
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

/** Props for retained Markdown rendering from a reactive text document. */
export interface MarkdownProps extends LayoutProps, StyleProps {
	readonly document: TextDocument;
	readonly options?: MarkdownOptions;
	/** Extra semantic reflow columns before wrapping the resulting rows to the physical allocation. */
	readonly wrapAllowance?: number;
	/** Receives the exact wrapped rows emitted by the native Markdown engine. */
	readonly onLayout?: (layout: MarkdownLayout) => void;
	/** Marks an actively appended document; only these expose a frozen Markdown prefix. */
	readonly transient?: boolean;
	/** Receives the parser-frozen source prefix of a transient document. */
	readonly onStableText?: (text: string) => void;
}

interface MarkdownState {
	document?: TextDocument;
	context?: HostContext;
	unsubscribe?: () => void;
	engine?: MarkdownEngine;
	theme?: Theme;
	options?: MarkdownOptions;
	base?: Style;
	configuration?: MarkdownConfiguration;
	layout?: MarkdownLayout;
	reflow?: RichText;
	semantic?: RichText;
	onLayout?: MarkdownProps["onLayout"];
	onStableText?: MarkdownProps["onStableText"];
	stableText?: string;
}

const EMPTY_OPTIONS: MarkdownOptions = {};

function propsOf(node: HostElement): MarkdownProps {
	return node.props as unknown as MarkdownProps;
}

function stateOf(node: HostElement): MarkdownState {
	let state = node.state as MarkdownState | undefined;
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
	state.engine = undefined;
	state.unsubscribe =
		state.context === undefined
			? undefined
			: document.subscribe(() => {
					state.context?.invalidate(node, Damage.Layout);
				});
}

function markdownThemeFor(theme: Theme): MarkdownTheme {
	const shared = getMarkdownTheme();
	return {
		...shared,
		heading: theme.style("mdHeading"),
		link: theme.style("mdLink"),
		linkUrl: theme.style("mdLinkUrl"),
		code: theme.style("mdCode"),
		codeBlock: theme.style("mdCodeBlock"),
		codeBlockBorder: theme.style("mdCodeBlockBorder"),
		quote: theme.style("mdQuote"),
		quoteBorder: theme.style("mdQuoteBorder"),
		hr: theme.style("mdHr"),
		listBullet: theme.style("mdListBullet"),
		bold: Style.NONE.plus(Attr.Bold),
		italic: Style.NONE.plus(Attr.Italic),
		underline: Style.NONE.plus(Attr.Underline),
		strikethrough: Style.NONE.plus(Attr.Strike),
		highlightCode: (code, language) => highlightCode(code, language, theme),
		createHighlightStream: language => createHighlightStream(language, theme),
	};
}

function isOutputDocument(document: TextDocument): document is OutputDocument {
	return "capture" in document && typeof document.capture === "function";
}

function configuration(node: HostElement, props: MarkdownProps, ctx: PaintContext): MarkdownConfiguration {
	const options = props.options ?? EMPTY_OPTIONS;
	const base = ctx.styleOf(node);
	const state = stateOf(node);
	if (state.configuration && state.theme === ctx.theme && state.options === options && state.base === base) {
		return state.configuration;
	}
	state.theme = ctx.theme;
	state.options = options;
	state.base = base;
	state.configuration = {
		paddingX: Math.max(0, Math.trunc(options.paddingX ?? 0)),
		paddingY: Math.max(0, Math.trunc(options.paddingY ?? 0)),
		theme: { ...markdownThemeFor(ctx.theme), resolveLink: options.resolveLink },
		defaultTextStyle: {
			...options.defaultTextStyle,
			style: options.defaultTextStyle?.style?.over(base) ?? base,
		},
		codeBlockIndent: Math.max(0, Math.trunc(options.codeBlockIndent ?? 2)),
		ignoreTight: options.ignoreTight === true,
	};
	return state.configuration;
}

function sameLayout(left: MarkdownLayout | undefined, right: MarkdownLayout): boolean {
	return (
		left?.width === right.width &&
		left.rows.length === right.rows.length &&
		left.rows.every((row, index) => row === right.rows[index])
	);
}

function paintMarkdown(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = propsOf(node);
	bindDocument(node, props.document);
	const config = configuration(node, props, ctx);
	const state = stateOf(node);
	const source = props.document.text();
	const transient = props.transient ?? (isOutputDocument(props.document) && props.document.capture() === "streaming");
	let engine = state.engine;
	if (engine === undefined) {
		engine = new MarkdownEngine(source, config);
		state.engine = engine;
	}
	engine.configure(source, config, transient);
	const notifyStableText = (): void => {
		const stableText = engine.stableText;
		if (state.stableText !== stableText || state.onStableText !== props.onStableText) {
			state.stableText = stableText;
			state.onStableText = props.onStableText;
			props.onStableText?.(stableText);
		}
	};
	const physicalWidth = Math.max(0, Math.trunc(width));
	const notifyLayout = (layout: MarkdownLayout): void => {
		const changed = !sameLayout(state.layout, layout);
		const listenerChanged = state.onLayout !== props.onLayout;
		state.layout = layout;
		state.onLayout = props.onLayout;
		if (changed || listenerChanged) props.onLayout?.(layout);
	};
	const allowance = Number.isFinite(props.wrapAllowance) ? Math.max(0, Math.trunc(props.wrapAllowance ?? 0)) : 0;
	if (allowance === 0) {
		engine.paint(out, physicalWidth, notifyLayout);
		notifyStableText();
		return;
	}
	const semantic = (state.semantic ??= new RichText());
	semantic.clear();
	engine.paint(semantic, physicalWidth + allowance);
	semantic.finish();
	const reflow = (state.reflow ??= new RichText());
	reflow.clear();
	pipe(new Wrap(reflow, Math.max(1, physicalWidth)), sink => {
		for (let row = 0; row < semantic.rows; row++) {
			let width = semantic.rowWidth[row]!;
			for (let run = semantic.rowEnd[row]! - 1; run >= semantic.rowStart(row); run--) {
				if (semantic.flags[run] !== RunFlag.None) break;
				const text = semantic.text[run]!;
				const trimmed = text.trimEnd();
				width -= cellWidth(text) - cellWidth(trimmed);
				if (trimmed.length > 0) break;
			}
			replayCells(sink, semantic, row, 0, width);
			sink.br();
		}
	});
	reflow.finish();
	reflow.replay(out);
	const rows: string[] = [];
	for (let row = 0; row < reflow.rows; row++) rows.push(reflow.rowText(row));
	notifyLayout({ width: physicalWidth, rows });
	notifyStableText();
}

/** Retained implementation of the `markdown` intrinsic. */
export const markdownElement: ElementImpl = {
	tag: "markdown",
	inline: true,
	paintInline(node, out, base, ctx) {
		const props = propsOf(node);
		bindDocument(node, props.document);
		const config = configuration(node, props, ctx);
		paintInlineMarkdown(out, props.document.text(), config.theme, config.defaultTextStyle?.style?.over(base) ?? base);
	},
	propDamage(name) {
		if (name === "onLayout" || name === "onStableText") return Damage.None;
		if (name === "document" || name === "options" || name === "transient") return Damage.Layout;
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
		state.engine = undefined;
		state.layout = undefined;
		state.onLayout = undefined;
		state.onStableText = undefined;
		state.stableText = undefined;
	},
	paint: paintMarkdown,
};

registerElement(markdownElement);
