import { cellWidth } from "../core/richtext";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import type { TabItem } from "../host/elements/tabs";
import { matchesKey } from "../keys";
import { createMemo, createSignal, type JSX } from "../reactive";

export interface TabBarViewProps {
	readonly tabs: readonly TabItem[];
	/** Id of the controlled active tab. */
	readonly active: string;
	readonly label?: string;
	/** Defaults to the historical "(tab to cycle)" hint. */
	readonly showHint?: boolean;
	readonly hint?: string;
	/** Receives a newly selected enabled tab; the owner updates `active`. */
	readonly onSelect?: (tab: TabItem, index: number) => void;
	/** Makes the strip a keyboard target when its owner wants local tab navigation. */
	readonly tabIndex?: number;
	/** Report wrapped tab-strip rows so the containing panel can place its body. */
	readonly onLayout?: (rows: number) => void;
}

interface PlainChunk {
	readonly kind: "label" | "gap" | "hint";
	readonly text: string;
}

interface TabChunk {
	readonly kind: "tab";
	readonly text: string;
	readonly tab: TabItem;
	readonly index: number;
}

type Chunk = PlainChunk | TabChunk;

interface TabBarState {
	readonly tabs: readonly TabItem[];
	readonly active: string;
	readonly label?: string;
	readonly showHint: boolean;
	readonly hint?: string;
	readonly hovered: string | undefined;
	readonly onSelect?: (tab: TabItem, index: number) => void;
	readonly tabIndex?: number;
	readonly onLayout?: (rows: number) => void;
}

function chunksFor(state: TabBarState, labels: readonly string[]): Chunk[] {
	const chunks: Chunk[] = [];
	if (state.label) {
		chunks.push({ kind: "label", text: `${state.label}:` });
		chunks.push({ kind: "gap", text: "  " });
	}
	for (let index = 0; index < state.tabs.length; index++) {
		const tab = state.tabs[index]!;
		chunks.push({ kind: "tab", text: ` ${labels[index]} `, tab, index });
		if (index < state.tabs.length - 1) chunks.push({ kind: "gap", text: "  " });
	}
	if (state.showHint) {
		chunks.push({ kind: "gap", text: "  " });
		chunks.push({ kind: "hint", text: state.hint ?? "(tab to cycle)" });
	}
	return chunks;
}

function layout(state: TabBarState, width: number): readonly (readonly Chunk[])[] {
	const maximum = Math.max(1, width);
	const activeIndex = state.tabs.findIndex(tab => tab.id === state.active);
	const labels = state.tabs.map(tab => tab.label);
	let chunks = chunksFor(state, labels);
	const totalWidth = (items: readonly Chunk[]): number => items.reduce((sum, chunk) => sum + cellWidth(chunk.text), 0);

	if (totalWidth(chunks) > maximum) {
		const collapseOrder = state.tabs
			.map((_, index) => index)
			.filter(index => index !== activeIndex && state.tabs[index]?.short !== undefined)
			.sort((left, right) => Math.abs(right - activeIndex) - Math.abs(left - activeIndex));
		for (const index of collapseOrder) {
			labels[index] = state.tabs[index]?.short ?? state.tabs[index]?.label ?? "";
			chunks = chunksFor(state, labels);
			if (totalWidth(chunks) <= maximum) break;
		}
	}

	const lines: Chunk[][] = [];
	let line: Chunk[] = [];
	let used = 0;
	for (const chunk of chunks) {
		const chunkWidth = cellWidth(chunk.text);
		if (chunkWidth === 0) continue;
		if (chunkWidth > maximum) {
			if (line.length > 0) lines.push(line);
			lines.push([chunk]);
			line = [];
			used = 0;
			continue;
		}
		if (used > 0 && used + chunkWidth > maximum) {
			lines.push(line);
			line = [];
			used = 0;
		}
		line.push(chunk);
		used += chunkWidth;
	}
	if (line.length > 0) lines.push(line);
	return lines.length > 0 ? lines : [[]];
}

function adjacentEnabledTab(state: TabBarState, direction: -1 | 1): TabChunk | undefined {
	const activeIndex = state.tabs.findIndex(tab => tab.id === state.active);
	const length = state.tabs.length;
	if (length === 0) return undefined;
	for (let step = 1; step <= length; step++) {
		const index = (((activeIndex + direction * step) % length) + length) % length;
		const tab = state.tabs[index];
		if (tab && !tab.disabled) return { kind: "tab", text: "", tab, index };
	}
	return undefined;
}

function consume(event: HostKeyEvent | HostMouseEvent): void {
	event.preventDefault();
	event.stopPropagation();
}

function TabChunkView(props: {
	readonly chunk: TabChunk;
	readonly state: TabBarState;
	setHovered(id: string | undefined): void;
}): JSX.Element {
	const selected = props.chunk.tab.id === props.state.active;
	const hovered = props.chunk.tab.id === props.state.hovered;
	const handleMouse = (event: HostMouseEvent): void => {
		if (event.action === "move") {
			props.setHovered(props.chunk.tab.disabled ? undefined : props.chunk.tab.id);
			consume(event);
			return;
		}
		if (event.action === "down" && event.button === 0) {
			if (!props.chunk.tab.disabled && !selected) props.state.onSelect?.(props.chunk.tab, props.chunk.index);
			consume(event);
		}
	};
	return (
		<text
			wrap="clip"
			overflow="ellipsis"
			color={props.chunk.tab.disabled ? "dim" : selected || hovered ? "text" : "muted"}
			background={!props.chunk.tab.disabled && (selected || hovered) ? "selectedBg" : undefined}
			bold={selected && !props.chunk.tab.disabled}
			onMouse={handleMouse}
		>
			{props.chunk.text}
		</text>
	);
}

function TabBarRows(props: {
	readonly state: TabBarState;
	readonly width: number;
	setHovered(id: string | undefined): void;
}): JSX.Element {
	const lines = layout(props.state, props.width);
	props.state.onLayout?.(lines.length);
	const handleKey = (event: HostKeyEvent): void => {
		let direction: -1 | 1 | undefined;
		if (matchesKey(event.data, "tab") || matchesKey(event.data, "right")) direction = 1;
		else if (matchesKey(event.data, "shift+tab") || matchesKey(event.data, "left")) direction = -1;
		if (direction === undefined) return;
		const next = adjacentEnabledTab(props.state, direction);
		if (next && next.index !== props.state.tabs.findIndex(tab => tab.id === props.state.active)) {
			props.state.onSelect?.(next.tab, next.index);
		}
		consume(event);
	};
	const handleMouse = (event: HostMouseEvent): void => {
		if (event.action === "wheel") return;
		if (event.action === "move") props.setHovered(undefined);
		consume(event);
	};
	return (
		<box tabIndex={props.state.tabIndex} onKey={handleKey} onMouse={handleMouse}>
			<stack>
				{lines.map((line, lineIndex) => (
					<row key={lineIndex} pad={false}>
						{line.length === 0 ? (
							<text wrap="clip" overflow="clip" />
						) : (
							line.map((chunk, chunkIndex) => {
								if (chunk.kind === "tab") {
									return <TabChunkView chunk={chunk} state={props.state} setHovered={props.setHovered} />;
								}
								if (chunk.kind === "label") {
									return (
										<text key={chunkIndex} wrap="clip" overflow="ellipsis" color="accent" bold>
											{chunk.text}
										</text>
									);
								}
								if (chunk.kind === "hint") {
									return (
										<text key={chunkIndex} wrap="clip" overflow="ellipsis" color="dim">
											{chunk.text}
										</text>
									);
								}
								return (
									<text key={chunkIndex} wrap="clip" overflow="ellipsis">
										{chunk.text}
									</text>
								);
							})
						)}
					</row>
				))}
			</stack>
		</box>
	);
}

/** Declarative controlled tab strip with historical compacting, pointer, and key behavior. */
export function TabBarView(props: TabBarViewProps): JSX.Element {
	const [hovered, setHovered] = createSignal<string>();
	const state = createMemo<TabBarState>(() => ({
		tabs: props.tabs,
		active: props.active,
		label: props.label,
		showHint: props.showHint !== false,
		hint: props.hint,
		hovered: hovered(),
		onSelect: props.onSelect,
		tabIndex: props.tabIndex,
		onLayout: props.onLayout,
	}));
	const paint = createMemo(() => {
		const snapshot = state();
		return (width: number) => <TabBarRows state={snapshot} width={width} setHovered={setHovered} />;
	});
	return <sized paint={paint()} />;
}
