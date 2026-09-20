/** Shared assistant transcript construction and model-authored link caching. */
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getMarkdownLinkUrls } from "../components/markdown-engine";
import { EMPTY_LINK_TARGETS } from "../render/render-utils";
import { AssistantMessageView } from "../chat/assistant-message";
import type { JSX } from "../reactive";
/** Session display capabilities supplied unchanged by the interactive host. */
export interface AssistantMessageSession {
	readonly model?: Model;
}

/** Host state required to construct and refresh assistant transcript segments. */
export interface AssistantMessageHost {
	readonly viewSession: AssistantMessageSession;
	readonly effectiveHideThinkingBlock: boolean;
	readonly assistantImagesVisible: boolean;
	readonly toolOutputExpanded: boolean;
	resolveAssistantMessageLinks(texts: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

const kMarkdownLinkTargets = Symbol("markdownLinkTargets");
type SessionWithMarkdownLinkTargets = AssistantMessageSession & {
	[kMarkdownLinkTargets]?: ReadonlyMap<string, string>;
};

function assistantTextBlocks(messages: readonly AssistantMessage[]): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		for (const content of message.content) {
			if (content.type === "text") texts.push(content.text);
		}
	}
	return texts;
}

/**
 * Resolve and cache the current session's model-authored prose links. Existing
 * entries remain available to synchronous transcript rebuilds; links present in
 * this batch are replaced atomically so missing resources cannot retain a stale
 * destination.
 */
export async function refreshAssistantMessageLinkTargets(
	ctx: AssistantMessageHost,
	messages: readonly AssistantMessage[],
): Promise<ReadonlyMap<string, string>> {
	const session: SessionWithMarkdownLinkTargets = ctx.viewSession;
	const previous = session[kMarkdownLinkTargets] ?? EMPTY_LINK_TARGETS;
	const texts = assistantTextBlocks(messages);
	const hrefs = new Set<string>();
	for (const text of texts) {
		for (const href of getMarkdownLinkUrls(text)) hrefs.add(href);
	}
	if (hrefs.size === 0) return previous;
	const resolved = await ctx.resolveAssistantMessageLinks(texts);
	let changed = false;
	for (const href of hrefs) {
		if (previous.get(href) !== resolved.get(href)) {
			changed = true;
			break;
		}
	}
	if (!changed) return previous;
	const next = new Map(previous);
	for (const href of hrefs) next.delete(href);
	for (const [href, target] of resolved) next.set(href, target);
	session[kMarkdownLinkTargets] = next;
	return next;
}

/** Current resolved destinations for synchronous component construction. */
export function getAssistantMessageLinkTargets(ctx: AssistantMessageHost): ReadonlyMap<string, string> {
	const session: SessionWithMarkdownLinkTargets = ctx.viewSession;
	return session[kMarkdownLinkTargets] ?? EMPTY_LINK_TARGETS;
}

/** Limit a session snapshot to destinations authored by one rendered segment. */
export function assistantMessageLinkTargets(
	message: AssistantMessage,
	targets: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
	const selected = new Map<string, string>();
	for (const content of message.content) {
		if (content.type !== "text") continue;
		for (const href of getMarkdownLinkUrls(content.text)) {
			const target = targets.get(href);
			if (target) selected.set(href, target);
		}
	}
	return selected;
}

/** Build the reactive assistant transcript entry with current display settings. */
export function createAssistantMessageView(ctx: AssistantMessageHost, message: AssistantMessage): JSX.Element {
	return AssistantMessageView({
		message,
		expanded: ctx.toolOutputExpanded,
		hideThinking: ctx.effectiveHideThinkingBlock,
		showImages: ctx.assistantImagesVisible,
	});
}
