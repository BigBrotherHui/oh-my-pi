import { isRecord } from "@oh-my-pi/pi-utils";
import { createMemo, createSignal, Show, useViewport, type JSX } from "../reactive";
import { useTheme } from "../theme/reactive";
import { Card } from "../view/card";
import { JsonTree } from "../view/json-tree";
import type { ToolUIStatus } from "../view/status-icon";
import { GenericResultBody } from "./generic-result-body";
import { registerToolView } from "./registry";
import type { ToolViewDefinition, ToolViewProps } from "./view";

import type { OutputMeta } from "./output-meta";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
} from "./json-tree";

/** Content types in tool results */
export interface MCPTextContent {
	type: "text";
	text: string;
}

/** Base64-encoded image returned by an MCP tool. */
export interface MCPImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

/** Embedded text or binary resource returned by an MCP tool. */
export interface MCPResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

/** Supported MCP result content blocks retained in display metadata. */
export type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

/** Details included in MCP tool results for rendering */
export interface MCPToolDetails {
	/** Server name */
	serverName: string;
	/** Original MCP tool name */
	mcpToolName: string;
	/** Whether the call resulted in an error */
	isError?: boolean;
	/** Raw content from MCP response */
	rawContent?: MCPContent[];
	/** Structured metadata from the MCP response */
	mcpMeta?: Record<string, unknown>;
	/** Provider ID (e.g., "claude", "mcp-json") */
	provider?: string;
	/** Provider display name (e.g., "Claude Code", "MCP Config") */
	providerName?: string;
	/** Structured output metadata (set by the spill wrapper when output is truncated to an artifact). */
	meta?: OutputMeta;
}

/** Registry prefix every minted MCP tool name carries. */
export const MCP_TOOL_NAME_PREFIX = "mcp__";

/**
 * Parse an MCP tool name back to server and tool components.
 *
 * Note: This returns the normalized tool name (with server prefix stripped).
 * The original MCP tool name may have had the server name as a prefix.
 */
export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
	if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return null;

	const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx === -1) return null;

	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
	};
}

const [renderMarkdownResults, setRenderMarkdownResultsSignal] = createSignal(false);

/** Set whether plain MCP text results render as Markdown. */
export function setMcpRenderMarkdownResults(enabled: boolean): void {
	setRenderMarkdownResultsSignal(enabled);
}

function displayArgs(args: unknown): Record<string, unknown> | undefined {
	if (!isRecord(args)) return undefined;
	for (const key in args) {
		if (Object.hasOwn(args, key)) return args;
	}
	return undefined;
}

interface McpArgsPreviewProps {
	readonly args: Record<string, unknown>;
}

/** Pending-call argument preview follows the compact generic-tool argument line. */
function McpArgsPreview(props: McpArgsPreviewProps): JSX.Element {
	const { theme } = useTheme();
	const viewport = useViewport();
	const treeLast = createMemo(() => theme().tree.last);
	const inlineArgsBudget = createMemo(() => {
		const contentWidth = Math.max(0, viewport().columns);
		return Math.max(20, contentWidth - Bun.stringWidth(treeLast()) - 2);
	});

	return (
		<row gap={1}>
			<row gap={0}>
				<text> </text>
				<text color="dim">{treeLast()}</text>
			</row>
			<text color="dim" grow={1} minWidth={1} wrap="none" overflow="ellipsis">
				{formatArgsInline(props.args, inlineArgsBudget())}
			</text>
		</row>
	);
}

export function McpToolView(props: ToolViewProps<unknown, MCPToolDetails>): JSX.Element {
	const title = createMemo(() => {
		const details = props.details;
		if (details?.serverName && details?.mcpToolName) {
			return `${details.serverName}/${details.mcpToolName}`;
		}
		const parsed = parseMCPToolName(props.toolName);
		if (parsed) return `${parsed.serverName}/${parsed.toolName}`;
		return props.label || props.toolName || "MCP";
	});

	const status = createMemo((): ToolUIStatus => {
		if (props.phase !== "settled") return "pending";
		if (props.outcome === "failed" || props.details?.isError === true) return "error";
		if (props.outcome === "timed_out") return "warning";
		if (props.outcome === "cancelled" || props.outcome === "skipped") return "aborted";
		return "success";
	});

	const args = createMemo(() => displayArgs(props.args));
	const hasOutput = createMemo(() => {
		props.output.version();
		return props.output.text().trimEnd().length > 0;
	});

	const header = () => (
		<row gap={1}>
			<Show when={status() === "success"} fallback={<status value={status()} />}>
				<icon name="tool.mcp" color="accent" />
			</Show>
			<text color="accent" grow={1} minWidth={1} wrap="none" overflow="ellipsis">
				{title()}
			</text>
		</row>
	);

	const summary = () => (
		<stack gap={0}>
			<Show when={!hasOutput() && args() !== undefined}>
				<McpArgsPreview args={args()!} />
			</Show>
			<GenericResultBody
				document={props.output}
				notices={() => props.notices}
				phase={() => props.phase}
				expanded={() => false}
				textPresentation={() => (renderMarkdownResults() ? { kind: "markdown" } : { kind: "pre" })}
				emptyState="settled"
			/>
		</stack>
	);

	const expanded = () => (
		<stack gap={1}>
			<Show when={args() !== undefined}>
				<stack gap={0}>
					<text color="dim">Args</text>
					<JsonTree
						value={args()!}
						maxDepth={JSON_TREE_MAX_DEPTH_EXPANDED}
						maxLines={JSON_TREE_MAX_LINES_EXPANDED}
						maxScalarLength={JSON_TREE_SCALAR_LEN_EXPANDED}
					/>
				</stack>
			</Show>
			<GenericResultBody
				document={props.output}
				notices={() => props.notices}
				phase={() => props.phase}
				expanded={() => true}
				textPresentation={() => (renderMarkdownResults() ? { kind: "markdown" } : { kind: "pre" })}
				emptyState="settled"
			/>
		</stack>
	);

	return (
		<Card border={false} backgroundBorder={false} paddingX={0} paddingY={0}>
			{header()}
			<Show when={props.ui.expanded} fallback={summary()}>
				{expanded()}
			</Show>
		</Card>
	);
}

export const mcpToolView: ToolViewDefinition<unknown, MCPToolDetails> = {
	view: props => <McpToolView {...props} />,
	summary: props => {
		const details = props.details;
		const parsed = parseMCPToolName(props.toolName);
		const title =
			details?.serverName && details?.mcpToolName
				? `${details.serverName}/${details.mcpToolName}`
				: parsed
					? `${parsed.serverName}/${parsed.toolName}`
					: props.label || props.toolName;
		const status: ToolUIStatus =
			props.phase === "running"
				? "running"
				: props.phase !== "settled"
					? "pending"
					: props.outcome === "failed" || details?.isError === true
						? "error"
						: props.outcome === "timed_out"
							? "warning"
							: props.outcome === "cancelled" || props.outcome === "skipped"
								? "aborted"
								: "success";
		const args = displayArgs(props.args);
		let argumentCount = 0;
		if (args) for (const key in args) if (Object.hasOwn(args, key)) argumentCount++;
		const detail = args ? `${argumentCount} argument${argumentCount === 1 ? "" : "s"}` : undefined;
		return { label: title, detail, status };
	},
	framed: true,
};

registerToolView("mcp", mcpToolView);
