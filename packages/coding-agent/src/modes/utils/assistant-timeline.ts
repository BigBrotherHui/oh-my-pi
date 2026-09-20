import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { canonicalizeMessage } from "@oh-my-pi/pi-tui/chat/thinking-display";

export interface AssistantToolTimeline {
	readonly beforeTools: AssistantMessage;
	readonly afterToolCalls: ReadonlyMap<number, AssistantMessage>;
	readonly lastToolContentIndex: number | undefined;
}

export function assistantHasVisibleContent(message: AssistantMessage): boolean {
	return message.content.some(
		content =>
			content.type === "image" ||
			(content.type === "text" && canonicalizeMessage(content.text)) ||
			(content.type === "thinking" && canonicalizeMessage(content.thinking)),
	);
}

function displayAssistantSegment(message: AssistantMessage, content: AssistantMessage["content"]): AssistantMessage {
	return { ...message, content, stopReason: "stop", errorMessage: undefined, retryRecovery: undefined };
}

/**
 * Preserves the semantic source order around tool calls. Tool positions, not
 * provider ids, key post-tool prose because providers can assign ids late.
 */
export function splitAssistantMessageToolTimeline(message: AssistantMessage): AssistantToolTimeline {
	const before: AssistantMessage["content"] = [];
	const afterToolCalls = new Map<number, AssistantMessage>();
	let pendingAfterTool: AssistantMessage["content"] = [];
	let lastToolContentIndex: number | undefined;
	let sawToolCall = false;

	const flushAfterTool = (): void => {
		if (lastToolContentIndex === undefined || pendingAfterTool.length === 0) return;
		const segment = displayAssistantSegment(message, pendingAfterTool);
		if (assistantHasVisibleContent(segment)) afterToolCalls.set(lastToolContentIndex, segment);
		pendingAfterTool = [];
	};

	for (const [index, content] of message.content.entries()) {
		if (content.type === "toolCall") {
			flushAfterTool();
			sawToolCall = true;
			lastToolContentIndex = index;
			continue;
		}
		if (sawToolCall) pendingAfterTool.push(content);
		else before.push(content);
	}
	flushAfterTool();

	return {
		beforeTools: sawToolCall ? displayAssistantSegment(message, before) : message,
		afterToolCalls,
		lastToolContentIndex,
	};
}
