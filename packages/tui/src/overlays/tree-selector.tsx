import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { centeredViewportRange, scrollbarThumbRange } from "../components/scroll-viewport";
import { fuzzyMatch } from "../fuzzy";
import { extractPrintableText, matchesKey } from "../keys";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent } from "../host/input";
import { For, Show, createMemo, createSignal, onMount, useFocus, useTheme, type Accessor, type JSX } from "../reactive";
import { shortenPath, toPathList } from "../render/render-utils";
import { canonicalizeMessage } from "../chat/thinking-display";
import { isUserRequestEntry, type TranscriptEntryLike } from "../chat/transcript-entry";
import { resolveAbortLabel, shouldRenderAbortReason } from "../chat/messages";
import type { TUI } from "../tui";

export const TREE_FILTER_MODES = ["default", "no-tools", "user-only", "labeled-only", "all"] as const;
export type TreeFilterMode = (typeof TREE_FILTER_MODES)[number];

export type SessionTreeEntry = { id: string; parentId: string | null } & (
	| TranscriptEntryLike
	| { type: "compaction"; tokensBefore: number }
	| { type: "branch_summary"; summary: string }
	| { type: "model_change"; model: string }
	| { type: "model_usage"; purpose: string; role?: string; provider: string; model: string }
	| { type: "thinking_level_change"; thinkingLevel?: string | null }
	| { type: "custom"; customType: string }
	| { type: "label"; label?: string }
	| { type: "service_tier_change"; serviceTier: Partial<Record<string, string>> | null }
	| { type: "title_change"; title: string }
	| { type: "mode_change"; mode: string }
	| { type: "credential_pin"; provider: string }
	| { type: "ttsr_injection"; injectedRules: string[] }
	| { type: "session_init" | "reset_boundary" }
);

export interface TreeSelectorNode {
	entry: SessionTreeEntry;
	children: TreeSelectorNode[];
	label?: string;
}

interface ToolCallInfo {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

interface TreeAncestor {
	readonly key: string;
	readonly depth: number;
	readonly isLast: boolean;
	readonly siblingCount: number;
}

/** One hierarchy row in the session-tree projection. */
export interface TreeSelectorRow {
	readonly node: TreeSelectorNode;
	readonly key: string;
	readonly parentKey: string | undefined;
	readonly depth: number;
	readonly siblingCount: number;
	readonly isLast: boolean;
	readonly ancestors: readonly TreeAncestor[];
}

interface TreeSelectorLayout {
	readonly rows: readonly TreeSelectorRow[];
	readonly parentById: ReadonlyMap<string, string | null>;
	readonly nodeById: ReadonlyMap<string, TreeSelectorNode>;
	readonly toolCalls: ReadonlyMap<string, ToolCallInfo>;
	readonly activePathIds: ReadonlySet<string>;
	readonly rootIds: ReadonlySet<string>;
	readonly multipleRoots: boolean;
	readonly currentLeafId: string | null;
}

interface LabelEdit {
	readonly entryId: string;
}

interface AssistantErrorPresentation {
	readonly kind: "none" | "full" | "compact-recovered";
	readonly text?: string;
}

function sanitizeTreeField(value: string): string {
	return sanitizeText(value)
		.replace(/[\n\t]/g, " ")
		.trim();
}

function advisorTreeDisplay(details: unknown): { qualifier: string; text: string } {
	if (!isRecord(details) || !Array.isArray(details.notes)) return { qualifier: "", text: "" };
	const notes: string[] = [];
	const advisors: string[] = [];
	const severities: string[] = [];
	for (const candidate of details.notes) {
		if (!isRecord(candidate)) continue;
		if (typeof candidate.note === "string") notes.push(candidate.note);
		if (typeof candidate.advisor === "string") {
			const name = sanitizeTreeField(candidate.advisor);
			if (name && name !== "default" && !advisors.includes(name)) advisors.push(name);
		}
		if (typeof candidate.severity === "string") {
			const severity = sanitizeTreeField(candidate.severity);
			if (severity && !severities.includes(severity)) severities.push(severity);
		}
	}
	return { qualifier: [...advisors, ...severities].join(", "), text: notes.join(" ") };
}

function stripSystemWrapperTags(content: string): string {
	const trimmed = content.trim();
	const opening = /^<(system-[\w-]+)/i.exec(trimmed);
	if (!opening) return content;
	const attributeStart = opening[0].length;
	const firstAttributeCharacter = trimmed[attributeStart];
	if (firstAttributeCharacter !== ">" && !/\s/.test(firstAttributeCharacter ?? "")) return content;
	let quote: '"' | "'" | undefined;
	let openingEnd = -1;
	for (let index = attributeStart; index < trimmed.length; index++) {
		const character = trimmed[index];
		if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === "<") {
			return content;
		} else if (character === ">") {
			openingEnd = index;
			break;
		}
	}
	if (openingEnd === -1 || quote) return content;
	const closingTag = `</${opening[1]}>`;
	const closingStart = trimmed.length - closingTag.length;
	if (closingStart <= openingEnd || trimmed.slice(closingStart).toLowerCase() !== closingTag.toLowerCase()) {
		return content;
	}
	return trimmed.slice(openingEnd + 1, closingStart).trim();
}

function joinTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let result = "";
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") result += block.text;
	}
	return result;
}

function extractContent(content: unknown): string {
	return joinTextContent(content).slice(0, 200);
}

function hasTextContent(content: unknown): boolean {
	if (typeof content === "string") return Boolean(canonicalizeMessage(content));
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (
			isRecord(block) &&
			block.type === "text" &&
			typeof block.text === "string" &&
			canonicalizeMessage(block.text)
		) {
			return true;
		}
	}
	return false;
}

function recoveredRetryNote(note: string): string {
	return note.replace(/\t/g, " ").replace(/\s+/g, " ").trim() || "retried";
}

function assistantErrorPresentation(message: AssistantMessage): AssistantErrorPresentation {
	if (message.retryRecovery?.status === "superseded") return { kind: "none" };
	if (message.retryRecovery?.status === "recovered") {
		return { kind: "compact-recovered", text: recoveredRetryNote(message.retryRecovery.note) };
	}
	if (message.stopReason === "aborted") {
		return shouldRenderAbortReason(message) ? { kind: "full", text: resolveAbortLabel(message) } : { kind: "none" };
	}
	if (message.stopReason === "error") return { kind: "full", text: message.errorMessage || "Error" };
	if (message.errorMessage && shouldRenderAbortReason(message)) return { kind: "full", text: message.errorMessage };
	return { kind: "none" };
}

function toolCallsFor(tree: readonly TreeSelectorNode[]): ReadonlyMap<string, ToolCallInfo> {
	const calls = new Map<string, ToolCallInfo>();
	const stack = [...tree].reverse();
	while (stack.length > 0) {
		const node = stack.pop()!;
		const entry = node.entry;
		if (entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
			for (const block of entry.message.content) {
				if (
					isRecord(block) &&
					block.type === "toolCall" &&
					typeof block.id === "string" &&
					typeof block.name === "string" &&
					isRecord(block.arguments)
				) {
					calls.set(block.id, { name: block.name, arguments: block.arguments });
				}
			}
		}
		for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]!);
	}
	return calls;
}

function buildTreeLayout(tree: readonly TreeSelectorNode[], currentLeafId: string | null): TreeSelectorLayout {
	const nodeById = new Map<string, TreeSelectorNode>();
	const parentById = new Map<string, string | null>();
	const allNodes: TreeSelectorNode[] = [];
	const stack = [...tree].reverse();
	while (stack.length > 0) {
		const node = stack.pop()!;
		allNodes.push(node);
		nodeById.set(node.entry.id, node);
		for (let index = node.children.length - 1; index >= 0; index--) {
			const child = node.children[index]!;
			parentById.set(child.entry.id, node.entry.id);
			stack.push(child);
		}
	}
	for (const root of tree) {
		if (!parentById.has(root.entry.id)) parentById.set(root.entry.id, null);
	}

	const containsActive = new Map<TreeSelectorNode, boolean>();
	for (let index = allNodes.length - 1; index >= 0; index--) {
		const node = allNodes[index]!;
		let contains = currentLeafId !== null && node.entry.id === currentLeafId;
		for (const child of node.children) {
			if (containsActive.get(child)) {
				contains = true;
				break;
			}
		}
		containsActive.set(node, contains);
	}

	const activePathIds = new Set<string>();
	let activeId = currentLeafId;
	while (activeId) {
		activePathIds.add(activeId);
		const parentId = parentById.get(activeId);
		if (parentId === undefined || parentId === null) break;
		activeId = parentId;
	}

	const ordered = (nodes: readonly TreeSelectorNode[]): readonly TreeSelectorNode[] =>
		[...nodes].sort((left, right) => Number(containsActive.get(right)) - Number(containsActive.get(left)));
	const roots = ordered(tree);
	const rootIds = new Set(roots.map(root => root.entry.id));
	const multipleRoots = roots.length > 1;
	const rows: TreeSelectorRow[] = [];
	const visit = (
		nodes: readonly TreeSelectorNode[],
		parentKey: string | undefined,
		depth: number,
		ancestors: readonly TreeAncestor[],
	): void => {
		const siblings = ordered(nodes);
		for (let index = 0; index < siblings.length; index++) {
			const node = siblings[index]!;
			const row: TreeSelectorRow = {
				node,
				key: node.entry.id,
				parentKey,
				depth,
				siblingCount: siblings.length,
				isLast: index === siblings.length - 1,
				ancestors,
			};
			rows.push(row);
			const children = ordered(node.children);
			if (children.length === 0) continue;
			const childDepth = children.length > 1 || (multipleRoots && parentKey === undefined) ? depth + 1 : depth;
			visit(children, node.entry.id, childDepth, [
				...ancestors,
				{ key: row.key, depth: row.depth, isLast: row.isLast, siblingCount: row.siblingCount },
			]);
		}
	};
	visit(roots, undefined, 0, []);
	return {
		rows,
		parentById,
		nodeById,
		toolCalls: toolCallsFor(tree),
		activePathIds,
		rootIds,
		multipleRoots,
		currentLeafId,
	};
}

function isSettingsEntry(entry: SessionTreeEntry): boolean {
	return (
		entry.type === "label" ||
		entry.type === "custom" ||
		entry.type === "model_change" ||
		entry.type === "model_usage" ||
		entry.type === "thinking_level_change" ||
		entry.type === "service_tier_change" ||
		entry.type === "title_change" ||
		entry.type === "credential_pin" ||
		entry.type === "session_init" ||
		entry.type === "ttsr_injection" ||
		entry.type === "mode_change" ||
		entry.type === "reset_boundary"
	);
}

function searchableText(node: TreeSelectorNode): string {
	const entry = node.entry;
	const parts: string[] = [];
	if (node.label) parts.push(node.label);
	switch (entry.type) {
		case "message": {
			parts.push(entry.message.role);
			if ("content" in entry.message) parts.push(extractContent(entry.message.content));
			if (entry.message.role === "bashExecution") parts.push(entry.message.command ?? "");
			break;
		}
		case "custom_message": {
			parts.push(entry.customType);
			if (entry.customType === "advisor") {
				const display = advisorTreeDisplay(entry.details);
				if (display.qualifier) parts.push(display.qualifier);
				if (display.text) parts.push(display.text);
			} else {
				const content = stripSystemWrapperTags(joinTextContent(entry.content)).slice(0, 200);
				if (content) parts.push(content);
			}
			break;
		}
		case "compaction":
			parts.push("compaction");
			break;
		case "branch_summary":
			parts.push("branch summary", entry.summary);
			break;
		case "model_change":
			parts.push("model", entry.model);
			break;
		case "model_usage":
			parts.push(
				"model usage",
				sanitizeTreeField(entry.purpose),
				sanitizeTreeField(entry.role ?? ""),
				sanitizeTreeField(entry.provider),
				sanitizeTreeField(entry.model),
			);
			break;
		case "thinking_level_change":
			parts.push("thinking", entry.thinkingLevel ?? ThinkingLevel.Off);
			break;
		case "custom":
			parts.push("custom", entry.customType);
			break;
		case "label":
			parts.push("label", entry.label ?? "");
			break;
		case "service_tier_change":
			parts.push("service tier");
			if (entry.serviceTier) {
				for (const family in entry.serviceTier) {
					const tier = entry.serviceTier[family];
					if (tier) parts.push(family, tier);
				}
			}
			break;
		case "title_change":
			parts.push("title", entry.title);
			break;
		case "mode_change":
			parts.push("mode", entry.mode);
			break;
		case "credential_pin":
			parts.push("credential pin", entry.provider);
			break;
		case "ttsr_injection":
			parts.push("ttsr injection", ...entry.injectedRules);
			break;
		case "reset_boundary":
			parts.push("reset boundary");
			break;
		case "session_init":
			parts.push("session init");
			break;
	}
	return parts.join(" ");
}

function visibleInMode(
	row: TreeSelectorRow,
	mode: TreeFilterMode,
	currentLeafId: string | null,
	query: string,
): boolean {
	const entry = row.node.entry;
	const currentLeaf = entry.id === currentLeafId;
	if (entry.type === "message" && entry.message.role === "assistant" && !currentLeaf) {
		const hasText = hasTextContent(entry.message.content);
		const stopReason = entry.message.stopReason;
		const errorOrAborted = stopReason !== undefined && stopReason !== "stop" && stopReason !== "toolUse";
		if (!hasText && !errorOrAborted) return false;
	}
	let passesFilter = true;
	switch (mode) {
		case "user-only":
			passesFilter = isUserRequestEntry(entry);
			break;
		case "no-tools":
			passesFilter = !isSettingsEntry(entry) && !(entry.type === "message" && entry.message.role === "toolResult");
			break;
		case "labeled-only":
			passesFilter = row.node.label !== undefined;
			break;
		case "all":
			break;
		default:
			passesFilter = !isSettingsEntry(entry);
	}
	if (!passesFilter) return false;
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return true;
	const text = searchableText(row.node);
	return tokens.every(token => fuzzyMatch(token, text).matches);
}

function filterLabel(mode: TreeFilterMode): string {
	switch (mode) {
		case "no-tools":
			return " [no-tools]";
		case "user-only":
			return " [user]";
		case "labeled-only":
			return " [labeled]";
		case "all":
			return " [all]";
		default:
			return "";
	}
}

function nearestVisibleId(
	candidate: string | null | undefined,
	rows: readonly TreeSelectorRow[],
	parentById: ReadonlyMap<string, string | null>,
): string | undefined {
	if (rows.length === 0) return undefined;
	if (candidate === null || candidate === undefined) return rows[0]?.key;
	const visible = new Set(rows.map(row => row.key));
	let current: string | null | undefined = candidate;
	while (current !== null && current !== undefined) {
		if (visible.has(current)) return current;
		current = parentById.get(current);
	}
	return rows[0]?.key;
}

export interface TreeSelectorControllerOptions {
	readonly currentLeafId?: string | null;
	readonly maxVisible?: number;
	readonly onLabelChange?: (entryId: string, label: string | undefined) => void;
}

export interface TreeSelectorController {
	readonly query: Accessor<string>;
	readonly filter: Accessor<TreeFilterMode>;
	readonly selectedIndex: Accessor<number>;
	readonly rows: Accessor<readonly TreeSelectorRow[]>;
	readonly editing: Accessor<LabelEdit | undefined>;
	readonly draft: Accessor<string>;
	readonly layout: TreeSelectorLayout;
	handleInput(data: string): void;
	select(summarize?: boolean): void;
	cancel(): void;
	setDraft(value: string): void;
	submitLabel(value?: string): void;
	cancelLabel(): void;
	dispose(): void;
}

export function createTreeSelectorController(
	tree: readonly TreeSelectorNode[],
	onSelect: (entryId: string, options: { summarize: boolean }) => void,
	onCancel: () => void,
	initialFilter: TreeFilterMode = "default",
	options: TreeSelectorControllerOptions = {},
): TreeSelectorController {
	const layout = buildTreeLayout(tree, options.currentLeafId ?? null);
	const [query, setQuery] = createSignal("");
	const [filter, setFilter] = createSignal(initialFilter);
	const [revision, setRevision] = createSignal(0);
	const rows = createMemo<readonly TreeSelectorRow[]>(() => {
		revision();
		return layout.rows.filter(row => visibleInMode(row, filter(), layout.currentLeafId, query()));
	});
	const [selectedId, setSelectedId] = createSignal(nearestVisibleId(options.currentLeafId, rows(), layout.parentById));
	const selectedIndex = createMemo(() => rows().findIndex(row => row.key === selectedId()));
	const [editing, setEditing] = createSignal<LabelEdit>();
	const [draft, setDraft] = createSignal("");
	let disposed = false;

	const retainNearestSelection = (candidate: string | null | undefined = selectedId()): void => {
		setSelectedId(nearestVisibleId(candidate, rows(), layout.parentById));
	};
	const setSelectionIndex = (index: number): void => {
		const visible = rows();
		if (visible.length === 0) {
			setSelectedId(undefined);
			return;
		}
		const clamped = Math.max(0, Math.min(Math.trunc(index), visible.length - 1));
		setSelectedId(visible[clamped]?.key);
	};
	const move = (delta: number, wrap = false): void => {
		const visible = rows();
		if (visible.length === 0) return;
		const current = Math.max(0, selectedIndex());
		let next = current + Math.trunc(delta);
		if (wrap) next = ((next % visible.length) + visible.length) % visible.length;
		setSelectionIndex(Math.max(0, Math.min(next, visible.length - 1)));
	};
	const moveTurn = (direction: -1 | 1): void => {
		const visible = rows();
		for (let index = selectedIndex() + direction; index >= 0 && index < visible.length; index += direction) {
			const entry = visible[index]!.node.entry;
			if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
				setSelectedId(entry.id);
				return;
			}
		}
	};
	const changeFilter = (mode: TreeFilterMode): void => {
		setFilter(mode);
		retainNearestSelection();
	};
	const beginLabelEdit = (): void => {
		if (query()) return;
		const selected = rows()[selectedIndex()];
		if (!selected) return;
		setDraft(selected.node.label ?? "");
		setEditing({ entryId: selected.key });
	};
	const select = (summarize = false): void => {
		const selected = rows()[selectedIndex()];
		if (selected) onSelect(selected.key, { summarize });
	};
	const submitLabel = (value = draft()): void => {
		const current = editing();
		if (!current) return;
		const node = layout.nodeById.get(current.entryId);
		if (node) {
			const label = value.trim() || undefined;
			node.label = label;
			setRevision(version => version + 1);
			retainNearestSelection(current.entryId);
			options.onLabelChange?.(current.entryId, label);
		}
		setEditing(undefined);
	};
	const cancelLabel = (): void => {
		setEditing(undefined);
	};

	return {
		query,
		filter,
		selectedIndex,
		rows,
		editing,
		draft,
		layout,
		handleInput(data) {
			if (disposed) return;
			if (editing()) {
				if (matchesAppInterrupt(data)) cancelLabel();
				return;
			}
			if (matchesSelectUp(data)) {
				move(-1, true);
				return;
			}
			if (matchesSelectDown(data)) {
				move(1, true);
				return;
			}
			if (matchesKey(data, "alt+up")) {
				moveTurn(-1);
				return;
			}
			if (matchesKey(data, "alt+down")) {
				moveTurn(1);
				return;
			}
			if (matchesKey(data, "home")) {
				setSelectionIndex(0);
				return;
			}
			if (matchesKey(data, "end")) {
				setSelectionIndex(rows().length - 1);
				return;
			}
			if (matchesSelectPageUp(data) || matchesKey(data, "left")) {
				move(-(options.maxVisible ?? 14));
				return;
			}
			if (matchesSelectPageDown(data) || matchesKey(data, "right")) {
				move(options.maxVisible ?? 14);
				return;
			}
			if (
				matchesKey(data, "shift+enter") ||
				matchesKey(data, "shift+return") ||
				data === "\n" ||
				data === "\x1b[13;2u" ||
				data === "\x1b[13;2~"
			) {
				select(true);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				select();
				return;
			}
			if (matchesAppInterrupt(data)) {
				if (query()) {
					setQuery("");
					retainNearestSelection();
				} else {
					onCancel();
				}
				return;
			}
			if (matchesKey(data, "ctrl+c")) {
				onCancel();
				return;
			}
			if (matchesKey(data, "shift+ctrl+o") || matchesKey(data, "ctrl+shift+o")) {
				const index = TREE_FILTER_MODES.indexOf(filter());
				changeFilter(TREE_FILTER_MODES[(index - 1 + TREE_FILTER_MODES.length) % TREE_FILTER_MODES.length]!);
				return;
			}
			if (matchesKey(data, "ctrl+o")) {
				const index = TREE_FILTER_MODES.indexOf(filter());
				changeFilter(TREE_FILTER_MODES[(index + 1) % TREE_FILTER_MODES.length]!);
				return;
			}
			if (matchesKey(data, "alt+d")) {
				changeFilter("default");
				return;
			}
			if (matchesKey(data, "alt+t")) {
				changeFilter("no-tools");
				return;
			}
			if (matchesKey(data, "alt+u")) {
				changeFilter("user-only");
				return;
			}
			if (matchesKey(data, "alt+l")) {
				changeFilter("labeled-only");
				return;
			}
			if (matchesKey(data, "alt+a")) {
				changeFilter("all");
				return;
			}
			if (matchesKey(data, "backspace")) {
				if (query()) {
					setQuery(value => Array.from(value).slice(0, -1).join(""));
					retainNearestSelection();
				}
				return;
			}
			if (matchesKey(data, "shift+l") && !query()) {
				beginLabelEdit();
				return;
			}
			const printable = extractPrintableText(data);
			if (printable) {
				setQuery(value => value + printable);
				retainNearestSelection();
			}
		},
		select,
		cancel: onCancel,
		setDraft,
		submitLabel,
		cancelLabel,
		dispose(): void {
			disposed = true;
		},
	};
}

function gutterFor(
	row: TreeSelectorRow,
	width: number,
	windowRows: readonly TreeSelectorRow[],
	layout: TreeSelectorLayout,
	tree: { readonly branch: string; readonly last: string; readonly vertical: string },
): string {
	const contentReserve = Math.max(24, Math.floor(width / 2));
	const maxIndentLevels = Math.max(1, Math.floor((width - contentReserve - 4) / 3));
	let deepest = row.depth;
	for (const candidate of windowRows) deepest = Math.max(deepest, candidate.depth);
	const windowOffset = Math.max(0, deepest - maxIndentLevels);
	const hasConnector = row.parentKey !== undefined && row.siblingCount > 1;
	const connector = hasConnector ? Array.from(`${row.isLast ? tree.last : tree.branch} `) : [];
	const scrollOffset = Math.min(windowOffset, row.depth);
	const renderedIndent = row.depth - scrollOffset;
	const connectorPosition = hasConnector ? renderedIndent - 1 : -1;
	const prefix: string[] = [];
	for (let index = 0; index < renderedIndent * 3; index++) {
		const level = Math.floor(index / 3);
		const originalDepth = level + scrollOffset;
		const position = index % 3;
		const ancestor = row.ancestors.find(
			candidate =>
				candidate.depth - 1 === originalDepth &&
				candidate.siblingCount > 1 &&
				!(layout.multipleRoots && layout.rootIds.has(candidate.key)),
		);
		if (ancestor) {
			prefix.push(position === 0 && !ancestor.isLast ? tree.vertical : " ");
		} else if (hasConnector && level === connectorPosition) {
			prefix.push(connector[position] ?? " ");
		} else {
			prefix.push(" ");
		}
	}
	if (scrollOffset > 0 && prefix.length > 0) prefix[0] = "…";
	return prefix.join("");
}

function formatToolCall(tool: ToolCallInfo): string {
	const args = tool.arguments;
	const stringValue = (value: unknown): string => (typeof value === "string" ? value : "");
	switch (tool.name) {
		case "read": {
			const path = shortenPath(stringValue(args.path) || stringValue(args.file_path));
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			let display = path;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit === undefined ? "" : start + limit - 1;
				display += `:${start}${end ? `-${end}` : ""}`;
			}
			return `[read: ${display}]`;
		}
		case "write":
			return `[write: ${shortenPath(stringValue(args.path) || stringValue(args.file_path))}]`;
		case "edit":
			return `[edit: ${shortenPath(stringValue(args.path) || stringValue(args.file_path))}]`;
		case "bash": {
			const command = stringValue(args.command);
			const shortened = command
				.replace(/[\n\t]/g, " ")
				.trim()
				.slice(0, 50);
			return `[bash: ${shortened}${command.length > 50 ? "..." : ""}]`;
		}
		case "grep": {
			let paths: string[];
			if (typeof args.paths === "string") {
				paths = toPathList(args.paths);
			} else if (Array.isArray(args.paths)) {
				paths = [];
				for (const path of args.paths) if (typeof path === "string") paths.push(path);
			} else {
				paths = toPathList(typeof args.path === "string" ? args.path : undefined);
			}
			return `[grep: /${stringValue(args.pattern)}/ in ${shortenPath(paths.length > 0 ? paths.join(", ") : ".")}]`;
		}
		case "glob": {
			let paths: string[];
			if (typeof args.path === "string") {
				paths = toPathList(args.path);
			} else if (typeof args.paths === "string") {
				paths = toPathList(args.paths);
			} else if (Array.isArray(args.paths)) {
				paths = [];
				for (const path of args.paths) if (typeof path === "string") paths.push(path);
			} else {
				paths = [];
			}
			return `[glob: ${shortenPath(paths.length > 0 ? paths.join(", ") : ".")}]`;
		}
		case "ls":
			return `[ls: ${shortenPath(stringValue(args.path) || ".")}]`;
		default: {
			const serialized = JSON.stringify(args);
			return `[${tool.name}: ${serialized.slice(0, 40)}${serialized.length > 40 ? "..." : ""}]`;
		}
	}
}

function TreeEntryText(props: {
	readonly row: TreeSelectorRow;
	readonly selected: boolean;
	readonly layout: TreeSelectorLayout;
	readonly bullet: string;
}): JSX.Element {
	const entry = props.row.node.entry;
	const normalize = (value: string): string => value.replace(/[\n\t]/g, " ").trim();
	const active = props.layout.activePathIds.has(entry.id);
	const label = props.row.node.label;
	const prefix = () => (
		<>
			{active ? <span color="accent">{`${props.bullet} `}</span> : null}
			{label ? <span color="warning">{`[${label}] `}</span> : null}
		</>
	);
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "user") {
			return (
				<text bold={props.selected} wrap="clip">
					{prefix()}
					<span color="accent">user: </span>
					{normalize(extractContent(message.content))}
				</text>
			);
		}
		if (message.role === "developer") {
			return (
				<text bold={props.selected} wrap="clip">
					{prefix()}
					<span color="dim">developer: </span>
					<span color="muted">{normalize(extractContent(message.content))}</span>
				</text>
			);
		}
		if (message.role === "assistant") {
			const presentation = assistantErrorPresentation(message);
			if (presentation.kind === "compact-recovered") {
				return (
					<text bold={props.selected} wrap="clip">
						{prefix()}
						<span color="success">assistant: </span>
						<span color="dim">{presentation.text}</span>
					</text>
				);
			}
			const content = normalize(extractContent(message.content));
			if (content)
				return (
					<text bold={props.selected} wrap="clip">
						{prefix()}
						<span color="success">assistant: </span>
						{content}
					</text>
				);
			if (presentation.kind === "full") {
				return (
					<text bold={props.selected} wrap="clip">
						{prefix()}
						<span color="success">assistant: </span>
						<span color="error">{normalize(presentation.text ?? "").slice(0, 80)}</span>
					</text>
				);
			}
			return (
				<text bold={props.selected} wrap="clip">
					{prefix()}
					<span color="success">assistant: </span>
					<span color="muted">{message.stopReason === "aborted" ? "(aborted)" : "(no content)"}</span>
				</text>
			);
		}
		if (message.role === "toolResult") {
			const call = message.toolCallId ? props.layout.toolCalls.get(message.toolCallId) : undefined;
			return (
				<text bold={props.selected} wrap="clip">
					{prefix()}
					<span color="muted">{call ? formatToolCall(call) : `[${message.toolName ?? "tool"}]`}</span>
				</text>
			);
		}
		if (message.role === "bashExecution") {
			return (
				<text bold={props.selected} wrap="clip">
					{prefix()}
					<span color="dim">{`[bash]: ${normalize(message.command ?? "")}`}</span>
				</text>
			);
		}
		return (
			<text bold={props.selected} wrap="clip">
				{prefix()}
				<span color="dim">{`[${message.role}]`}</span>
			</text>
		);
	}
	if (entry.type === "custom_message") {
		if (entry.customType === "advisor") {
			const display = advisorTreeDisplay(entry.details);
			const labelText = display.qualifier ? `advisor (${display.qualifier}): ` : "advisor: ";
			return (
				<text bold={props.selected} wrap="clip">
					{prefix()}
					<span color="customMessageLabel">{labelText}</span>
					{normalize(display.text)}
				</text>
			);
		}
		return (
			<text bold={props.selected} wrap="clip">
				{prefix()}
				<span color="customMessageLabel">{`[${entry.customType}]: `}</span>
				{normalize(stripSystemWrapperTags(joinTextContent(entry.content)))}
			</text>
		);
	}
	if (entry.type === "compaction")
		return (
			<text bold={props.selected} color="borderAccent" wrap="clip">
				{prefix()}
				{`[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`}
			</text>
		);
	if (entry.type === "branch_summary")
		return (
			<text bold={props.selected} wrap="clip">
				{prefix()}
				<span color="warning">[branch summary]: </span>
				{normalize(entry.summary)}
			</text>
		);
	if (entry.type === "model_change")
		return (
			<text bold={props.selected} color="dim" wrap="clip">
				{prefix()}
				{`[model: ${entry.model}]`}
			</text>
		);
	if (entry.type === "model_usage")
		return (
			<text bold={props.selected} color="dim" wrap="clip">
				{prefix()}
				{`[model usage: ${sanitizeTreeField(entry.purpose)} ${entry.role ? `${sanitizeTreeField(entry.role)} ` : ""}${sanitizeTreeField(entry.provider)}/${sanitizeTreeField(entry.model)}]`}
			</text>
		);
	if (entry.type === "thinking_level_change")
		return (
			<text bold={props.selected} color="dim" wrap="clip">
				{prefix()}
				{`[thinking: ${entry.thinkingLevel ?? ThinkingLevel.Off}]`}
			</text>
		);
	if (entry.type === "custom")
		return (
			<text bold={props.selected} color="dim" wrap="clip">
				{prefix()}
				{`[custom: ${entry.customType}]`}
			</text>
		);
	if (entry.type === "label")
		return (
			<text bold={props.selected} color="dim" wrap="clip">
				{prefix()}
				{`[label: ${entry.label ?? "(cleared)"}]`}
			</text>
		);
	if (entry.type === "service_tier_change") {
		let tiers = "";
		if (entry.serviceTier) {
			for (const family in entry.serviceTier) {
				const tier = entry.serviceTier[family];
				tiers += `${tiers ? " " : ""}${family}:${tier}`;
			}
		} else {
			tiers = "(default)";
		}
		return (
			<text bold={props.selected} color="dim" wrap="clip">
				{prefix()}
				{`[service tier: ${tiers}]`}
			</text>
		);
	}
	if (entry.type === "title_change")
		return (
			<text bold={props.selected} color="dim" wrap="clip">
				{prefix()}
				{`[title: ${normalize(entry.title)}]`}
			</text>
		);
	if (entry.type === "mode_change")
		return (
			<text bold={props.selected} color="dim" wrap="clip">
				{prefix()}
				{`[mode: ${entry.mode}]`}
			</text>
		);
	if (entry.type === "credential_pin")
		return (
			<text bold={props.selected} color="dim" wrap="clip">
				{prefix()}
				{`[credential pin: ${entry.provider}]`}
			</text>
		);
	return (
		<text bold={props.selected} color="dim" wrap="clip">
			{prefix()}
			{`[${entry.type.replaceAll("_", " ")}]`}
		</text>
	);
}

function TreeSelectorRowView(props: {
	readonly row: TreeSelectorRow;
	readonly selected: boolean;
	readonly gutter: string;
	readonly layout: TreeSelectorLayout;
	readonly bullet: string;
	readonly scrollbar: boolean;
	readonly thumb: boolean;
}): JSX.Element {
	return (
		<row>
			<box grow={1} background={props.selected ? "selectedBg" : undefined}>
				<row pad={false}>
					<text color={props.selected ? "accent" : undefined}>{props.selected ? "› " : "  "}</text>
					<text color="dim">{props.gutter}</text>
					<box grow={1}>
						<TreeEntryText
							row={props.row}
							selected={props.selected}
							layout={props.layout}
							bullet={props.bullet}
						/>
					</box>
				</row>
			</box>
			{props.scrollbar ? <text color={props.thumb ? "accent" : "muted"}>{props.thumb ? "█" : "│"}</text> : null}
		</row>
	);
}

function EmptyTreeView(props: {
	readonly total: number;
	readonly query: string;
	readonly mode: TreeFilterMode;
}): JSX.Element {
	const label = filterLabel(props.mode);
	if (props.total === 0)
		return (
			<stack>
				<text color="muted" wrap="clip">
					No entries found
				</text>
				<text color="muted" wrap="clip">{`(0/0)${label}`}</text>
			</stack>
		);
	if (props.query)
		return (
			<stack>
				<text color="muted" wrap="clip">{`No entries match search "${props.query}"`}</text>
				<text color="muted" wrap="clip">
					Press Backspace to clear the search
				</text>
				<text color="muted" wrap="clip">{`(0/${props.total})${label}`}</text>
			</stack>
		);
	const mode = label.trim() || "[default]";
	return (
		<stack>
			<text color="muted" wrap="clip">{`${props.total} entries hidden by the current filter ${mode}`}</text>
			<text color="muted" wrap="clip">
				Press Alt+A to show all, Alt+D for default
			</text>
			<text color="muted" wrap="clip">{`(0/${props.total})${label}`}</text>
		</stack>
	);
}

function TreeSelectorRows(props: {
	readonly rows: readonly TreeSelectorRow[];
	readonly selectedIndex: number;
	readonly maxVisible: number;
	readonly layout: TreeSelectorLayout;
	readonly tree: { readonly branch: string; readonly last: string; readonly vertical: string };
	readonly bullet: string;
	readonly width: number;
}): JSX.Element {
	if (props.rows.length === 0) return <EmptyTreeView total={props.layout.rows.length} query="" mode="default" />;
	const window = centeredViewportRange(props.selectedIndex, props.rows.length, props.maxVisible);
	const visible = props.rows.slice(window.start, window.end);
	const scrollbar = props.rows.length > props.maxVisible;
	const thumb = scrollbar ? scrollbarThumbRange(props.maxVisible, props.rows.length, window.start) : undefined;
	const rowWidth = Math.max(0, props.width - (scrollbar ? 1 : 0));
	return (
		<stack>
			<For each={visible}>
				{(row, index) => (
					<TreeSelectorRowView
						row={row}
						selected={window.start + index() === props.selectedIndex}
						gutter={gutterFor(row, rowWidth, visible, props.layout, props.tree)}
						layout={props.layout}
						bullet={props.bullet}
						scrollbar={scrollbar}
						thumb={thumb !== undefined && index() >= thumb.start && index() < thumb.end}
					/>
				)}
			</For>
		</stack>
	);
}

export interface TreeSelectorViewProps {
	readonly tree: readonly TreeSelectorNode[];
	readonly controller: TreeSelectorController;
	readonly maxVisible?: number;
}

function TreeLabelEditor(props: {
	readonly controller: TreeSelectorController;
	readonly onKey: (event: HostKeyEvent) => void;
}): JSX.Element {
	const focus = useFocus();
	onMount(() => focus.focus());
	return (
		<stack>
			<text color="muted">Label (empty to remove):</text>
			<input
				tabIndex={focus.tabIndex}
				value={props.controller.draft()}
				onKey={props.onKey}
				onChange={props.controller.setDraft}
				onSubmit={props.controller.submitLabel}
				onEscape={props.controller.cancelLabel}
			/>
			<text color="dim">enter: save esc: cancel</text>
		</stack>
	);
}

export function TreeSelectorView(props: TreeSelectorViewProps): JSX.Element {
	const { theme } = useTheme();
	const handleKey = (event: HostKeyEvent): void => {
		if (props.controller.editing()) return;
		props.controller.handleInput(event.data);
		event.preventDefault();
	};
	const labelKey = (event: HostKeyEvent): void => {
		if (matchesAppInterrupt(event.data)) {
			props.controller.cancelLabel();
			event.preventDefault();
		}
		event.stopPropagation();
	};
	const activeRows = createMemo(() => props.controller.rows());
	return (
		<frame title="Session Tree" paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<box tabIndex={0} onKey={handleKey}>
				<stack>
					<br />
					<text color="muted" wrap="clip">
						Enter: switch. Alt+↑/↓: previous/next turn. PgUp/PgDn (←/→): page. Home/End: first/last item.
						Shift+Enter: summarize & switch. Shift+L: label. Ctrl+O: filter. Alt+D/T/U/L/A: filter. Type to search
					</text>
					<box color="accent">
						<input
							value={props.controller.query()}
							prompt="Search: "
							promptStyle={theme().style("muted")}
							onChange={() => {}}
						/>
					</box>
					<hr variant="frame" />
					<br />
					<Show
						when={props.controller.editing()}
						fallback={
							<>
								<sized
									paint={width =>
										activeRows().length === 0 ? (
											<EmptyTreeView
												total={props.controller.layout.rows.length}
												query={props.controller.query()}
												mode={props.controller.filter()}
											/>
										) : (
											<TreeSelectorRows
												rows={activeRows()}
												selectedIndex={props.controller.selectedIndex()}
												maxVisible={Math.max(1, props.maxVisible ?? 14)}
												layout={props.controller.layout}
												tree={theme().tree}
												bullet={theme().md.bullet}
												width={width}
											/>
										)
									}
								/>
								{activeRows().length > 0 && filterLabel(props.controller.filter()) ? (
									<text color="muted" wrap="clip">
										{filterLabel(props.controller.filter()).trim()}
									</text>
								) : null}
							</>
						}
					>
						{() => <TreeLabelEditor controller={props.controller} onKey={labelKey} />}
					</Show>
					<br />
				</stack>
			</box>
		</frame>
	);
}

export interface TreeSelectorOverlayProps {
	readonly tree: TreeSelectorNode[];
	readonly currentLeafId: string | null;
	readonly terminalHeight: number;
	readonly onSelect: (entryId: string, options: { summarize: boolean }) => void;
	readonly onCancel: () => void;
	readonly onLabelChange?: (entryId: string, label: string | undefined) => void;
	readonly initialFilterMode?: TreeFilterMode;
}

export interface TreeSelectorHandle extends OverlayDisposer, TreeSelectorController {}

export function openTreeSelectorOverlay(tui: TUI, props: TreeSelectorOverlayProps): TreeSelectorHandle {
	const maxVisible = Math.max(
		1,
		Math.min(Math.max(5, Math.floor(props.terminalHeight / 2)), props.terminalHeight - 8),
	);
	const controller = createTreeSelectorController(
		props.tree,
		props.onSelect,
		props.onCancel,
		props.initialFilterMode,
		{
			currentLeafId: props.currentLeafId,
			maxVisible,
			onLabelChange: props.onLabelChange,
		},
	);
	const overlay = mountOverlay(tui, () => (
		<Portal to="overlay" fullscreen anchor="bottom-center">
			<TreeSelectorView tree={props.tree} controller={controller} maxVisible={maxVisible} />
		</Portal>
	));
	let closed = false;
	let emptyTreeTimer: NodeJS.Timeout | undefined;
	const close = (): void => {
		if (closed) return;
		closed = true;
		clearTimeout(emptyTreeTimer);
		controller.dispose();
		overlay.dispose();
	};
	if (props.tree.length === 0) {
		emptyTreeTimer = setTimeout(() => {
			controller.cancel();
			close();
		}, 100);
	}
	return Object.assign(close, controller, { hide: close, dispose: close });
}
