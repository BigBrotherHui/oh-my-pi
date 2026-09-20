import type { JSX } from "../reactive";
import type { CustomMessage, HookMessage } from "./messages";

/** A declarative extension surface mounted under the current reactive owner. */
export type ExtensionUiView = () => JSX.Element;

/** Produces a view directly; terminal and theme are inherited through context. */
export type ExtensionUiViewFactory = () => ExtensionUiView;

export type ExtensionWidgetContent = readonly string[] | ExtensionUiView | undefined;

export interface MessageRenderOptions {
	readonly expanded: boolean;
}

/** Custom-message renderer supplied by an extension. */
export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
) => JSX.Element | undefined;

export interface AssistantThinkingRenderContext {
	readonly contentIndex: number;
	readonly thinkingIndex: number;
	readonly text: string;
}

export type AssistantThinkingRenderer = (context: AssistantThinkingRenderContext) => JSX.Element | undefined;

export interface HookMessageRenderOptions {
	readonly expanded: boolean;
}

/** Declarative renderer for an extension hook message. */
export type HookMessageRenderer<T = unknown> = (
	message: HookMessage<T>,
	options: HookMessageRenderOptions,
) => JSX.Element | undefined;
