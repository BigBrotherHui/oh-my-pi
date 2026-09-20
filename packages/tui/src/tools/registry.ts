import type { DeepReadonly, ToolViewDefinition, ToolViewProps } from "./view";
import type { ToolCallModel } from "./model";

/** Inner tool selected by a coding-agent-owned xd:// mountability resolver. */
export interface InnerToolSelection {
	readonly toolName: string;
	readonly args: Record<string, unknown>;
	readonly rawArgs?: string;
	readonly label?: string;
	readonly toolView?: ToolViewDefinition<unknown, unknown>;
}

/** Extension and delegation inputs used to select a tool presentation. */
export interface ToolViewSource<TArgs = unknown, TDetails = unknown> {
	/** Extension-supplied presentation, preferred over the static registry. */
	readonly toolView?: ToolViewDefinition<TArgs, TDetails>;
	/** Outer call model required when xd:// delegation produces an inner presentation. */
	readonly model?: ToolCallModel;
	/**
	 * Coding-agent policy hook. It returns an inner tool only after the host has
	 * approved that device for mounting; this package never reimplements that policy.
	 */
	readonly resolveInnerTool?: (args: DeepReadonly<Record<string, unknown>>) => InnerToolSelection | undefined;
}

/** A selected view definition plus a readonly delegated presentation for xd:// calls. */
export interface ResolvedToolView {
	readonly definition: ToolViewDefinition<unknown, unknown>;
	readonly model?: ToolViewProps<Record<string, unknown>, unknown>;
	/** Changes only when the selected definition or approved inner identity changes. */
	readonly identity?: string;
}

/** Reactive tool presentations keyed by their canonical tool names. */
export const toolViews = new Map<string, ToolViewDefinition<unknown, unknown>>();

/** Register or replace the reactive presentation for a tool name. */
export function registerToolView<TArgs, TDetails>(name: string, definition: ToolViewDefinition<TArgs, TDetails>): void {
	if (name.length === 0) throw new Error("Tool view name must not be empty");
	toolViews.set(name, definition as unknown as ToolViewDefinition<unknown, unknown>);
}

function fallbackDefinition(toolName: string): ToolViewDefinition<unknown, unknown> {
	const exact = toolViews.get(toolName);
	if (exact) return exact;
	if (toolName.startsWith("mcp__")) {
		const mcp = toolViews.get("mcp");
		if (mcp) return mcp;
	}
	const fallback = toolViews.get("default");
	if (fallback) return fallback;
	throw new Error(`No tool view is registered for ${toolName}, and the default view is missing`);
}

function selectInner(
	outer: ToolCallModel,
	resolve: NonNullable<ToolViewSource["resolveInnerTool"]>,
): InnerToolSelection | undefined {
	try {
		return resolve(outer.args as DeepReadonly<Record<string, unknown>>);
	} catch {
		return undefined;
	}
}

function delegatedPresentation(
	outer: ToolCallModel,
	resolve: NonNullable<ToolViewSource["resolveInnerTool"]>,
): ToolViewProps<Record<string, unknown>, unknown> {
	const selection = () => selectInner(outer, resolve);
	return {
		get id() {
			return `${outer.id}:inner`;
		},
		get toolName() {
			return selection()?.toolName ?? "";
		},
		get label() {
			const inner = selection();
			return inner?.label ?? inner?.toolName ?? "";
		},
		get args() {
			return selection()?.args ?? {};
		},
		get rawArgs() {
			return selection()?.rawArgs;
		},
		get phase() {
			return outer.phase;
		},
		get hasResult() {
			return outer.hasResult;
		},
		get outcome() {
			return outer.outcome;
		},
		get details() {
			return outer.details;
		},
		get output() {
			return outer.output;
		},
		get notices() {
			return outer.notices;
		},
		get images() {
			return outer.images;
		},
		get ui() {
			return outer.ui;
		},
	};
}

function resolveInner(
	source: Pick<ToolViewSource<unknown, unknown>, "model" | "resolveInnerTool">,
): ResolvedToolView | undefined {
	const outer = source.model;
	const resolve = source.resolveInnerTool;
	if (!outer || !resolve) return undefined;
	const selection = selectInner(outer, resolve);
	if (!selection) return undefined;
	return {
		definition: selection.toolView ?? fallbackDefinition(selection.toolName),
		model: delegatedPresentation(outer, resolve),
		identity: `${outer.id}:inner:${selection.toolName}:${selection.label ?? selection.toolName}`,
	};
}

/**
 * Select a presentation without mounting it. Extension definitions win;
 * coding-agent-approved xd:// wrappers resolve to an inner definition/presentation,
 * MCP names share the `mcp` definition, and unknown tools use `default`.
 */
export function resolveToolView<TArgs = unknown, TDetails = unknown>(
	toolName: string,
	source?: ToolViewSource<TArgs, TDetails>,
): ResolvedToolView {
	if (source?.toolView) {
		return { definition: source.toolView as unknown as ToolViewDefinition<unknown, unknown> };
	}
	if (source) {
		const inner = resolveInner(source);
		if (inner) return inner;
	}
	return { definition: fallbackDefinition(toolName) };
}
