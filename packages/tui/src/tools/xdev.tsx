import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { decodeStreamingToolArgs } from "./argument-decoder";
import { defaultToolView } from "./default-renderer";
import { parseMCPToolName } from "./mcp";
import { parseXdUrl } from "./xd-url";

import { registerToolView, type InnerToolSelection } from "./registry";
import type { ActivitySummary, DeepReadonly, ToolViewDefinition } from "./view";

/** Mounted reactive presentation selected for a device write. */
export interface XdevMountedRenderer {
	readonly label?: string;
	readonly toolView?: ToolViewDefinition<unknown, unknown>;
}

/** Mounted tool presentation state supplied by the host's canonical tool map. */
export interface XdevMountedState {
	readonly mountedNames: ReadonlySet<string>;
	readonly tools: ReadonlyMap<string, XdevMountedRenderer>;
}

/** Result metadata consumed by delegated device rendering. */
export interface XdevRenderDispatch {
	tool: string;
	mode: "help" | "execute";
	args?: Record<string, unknown>;
	tier?: ToolTier;
	inner?: unknown;
}

/** Decode the (possibly partially streamed) inner args JSON string into display args. */
export function decodeInnerArgs(raw: unknown): Record<string, unknown> {
	return decodeStreamingToolArgs(raw);
}

/** Human label for a device write: mounted tool label, else `server/tool` for MCP names. */
export function displayDeviceLabel(name: string, mounted?: { label?: string }): string {
	if (mounted?.label) return mounted.label;
	const parsed = parseMCPToolName(name);
	if (parsed) return `${parsed.serverName}/${parsed.toolName}`;
	return name;
}

/** Salient inner-arg keys for the compact activity line: the verb first, then its object. */
const ACTIVITY_VERB_KEYS = ["action", "op", "command"] as const;
const ACTIVITY_OBJECT_KEYS = ["query", "symbol", "path", "file", "pattern", "url", "name"] as const;

/**
 * Compact `label · verb object` activity summary for a device write, so a
 * squeezed transcript row reads `LSP · references foo` instead of
 * `Write · xd://lsp`. Prose payloads (resolution devices, report_issue)
 * surface their first line instead.
 */
export function xdevActivitySummary(
	name: string,
	content: unknown,
	resolveMounted?: (name: string) => XdevMountedRenderer | undefined,
): ActivitySummary {
	const mounted = resolveMounted?.(name);
	const args = decodeInnerArgs(content);
	const pick = (keys: readonly string[]): string | undefined => {
		for (const key of keys) {
			const value = args[key];
			if (typeof value === "string" && value.length > 0) return value.split("\n", 1)[0];
		}
		return undefined;
	};
	let detail = [pick(ACTIVITY_VERB_KEYS), pick(ACTIVITY_OBJECT_KEYS)].filter(Boolean).join(" ");
	if (!detail && typeof content === "string" && !content.trimStart().startsWith("{")) {
		detail = content.trim().split("\n", 1)[0];
	}
	return { label: displayDeviceLabel(name, mounted), detail: detail || undefined, status: "info" };
}

/**
 * Coding-agent policy resolver for `resolveToolView`.
 *
 * A streamed path alone is not enough to commit the transcript to a device
 * presentation: providers can still revise it and the historical renderer
 * deliberately painted nothing until the write content began. Once content is
 * present, resolve the mounted inner tool and let its reactive definition own
 * every lifecycle state, result block, and control.
 */
export function resolveInnerXdevTool(
	args: DeepReadonly<Record<string, unknown>>,
	isMounted?: (name: string) => boolean,
): InnerToolSelection | undefined {
	const rawPath =
		typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
	if (!rawPath || args.content === undefined) return undefined;
	const parsed = parseXdUrl(rawPath);
	if (!parsed?.name) return undefined;
	if (isMounted && !isMounted(parsed.name)) return undefined;
	return {
		toolName: parsed.name,
		args: decodeInnerArgs(args.content),
		rawArgs: typeof args.content === "string" ? args.content : undefined,
	};
}

export const xdevToolView: ToolViewDefinition<unknown, unknown> = defaultToolView;
registerToolView("xdev", xdevToolView);
