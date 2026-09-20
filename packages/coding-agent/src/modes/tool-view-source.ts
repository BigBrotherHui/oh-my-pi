import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { stripXdUrlPrefix, XD_URL_PREFIX } from "@oh-my-pi/pi-tui/tools/xd-url";
import type { InnerToolSelection, ToolViewSource } from "@oh-my-pi/pi-tui/tools/registry";
import type { ToolViewDefinition } from "@oh-my-pi/pi-tui/tools/view";
import type { InteractiveModeContext } from "./types";

type PresentableTool = AgentTool & {
	readonly label?: string;
	readonly toolView?: ToolViewDefinition<unknown, unknown>;
};

function isPresentableTool(tool: AgentTool | undefined): tool is PresentableTool {
	return tool !== undefined && ("toolView" in tool || "label" in tool);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function deviceArgs(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		try {
			return asRecord(JSON.parse(value));
		} catch {
			return undefined;
		}
	}
	return asRecord(value);
}

/**
 * The sole coding-agent policy bridge for transcript tool presentations.
 * Mounted `xd://` devices are selected only from the session's approved mount
 * set; the TUI receives the selected view and never recreates that policy.
 */
export function createToolViewSource(
	ctx: InteractiveModeContext,
	toolName: string,
	ownerSession: InteractiveModeContext["viewSession"] = ctx.viewSession,
): ToolViewSource {
	const outerTool = ownerSession.getToolByName(toolName);
	const outerView = isPresentableTool(outerTool) ? outerTool.toolView : undefined;
	return {
		...(outerView ? { toolView: outerView } : {}),
		resolveInnerTool(args): InnerToolSelection | undefined {
			if (toolName !== "write") return undefined;
			const path = args.path;
			if (typeof path !== "string" || !path.toLowerCase().startsWith(XD_URL_PREFIX)) return undefined;
			const name = stripXdUrlPrefix(path);
			const mountedName = ownerSession.getMountedXdevToolNames().find(candidate => candidate === name);
			if (!mountedName) return undefined;
			const mountedTool = ownerSession.getToolByName(mountedName);
			if (!mountedTool) return undefined;
			const presentation = isPresentableTool(mountedTool) ? mountedTool : undefined;
			const innerArgs = deviceArgs(args.content);
			if (!innerArgs) return undefined;
			return {
				toolName: mountedName,
				args: innerArgs,
				...(typeof args.content === "string" ? { rawArgs: args.content } : {}),
				label: presentation?.label,
				toolView: presentation?.toolView,
			};
		},
	};
}
