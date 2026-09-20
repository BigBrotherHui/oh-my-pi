import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createEffect, createSignal, For, onCleanup, Show, useTheme, type Accessor, type JSX } from "../reactive";
import { matchesKey } from "../keys";
import {
	matchesAppToolsExpand,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { Portal, bindOverlayController, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import type { TUI } from "../tui";
import {
	textContent,
	transcriptEntryMessage,
	userTurnDraft,
	type TranscriptEntryLike as TranscriptEntry,
} from "../chat/transcript-entry";
import { ChatTranscriptBuilder, type ChatTranscriptBuilderDeps } from "../chat/chat-transcript-builder";
import { TranscriptView } from "../chat/transcript-store";
import { createDocument } from "../document/document";
import { commandFromToolCall, extractBlocks, extractLinks } from "./copy-targets";

export interface CopySelectorDeps extends ChatTranscriptBuilderDeps {
	onPick: (content: string, label: string) => void;
	onOpen?: (href: string, label: string) => void;
	onCancel: () => void;
}

interface CopyBlock {
	readonly label: string;
	readonly content: string;
	readonly language?: string;
	readonly href?: string;
}

interface CopyTarget {
	readonly id: string;
	readonly entries: TranscriptEntry[];
}

const BLOCK_PREVIEW_LINES = 12;

/**
 * The historical picker selected every visible transcript item, not just user
 * prompts. Tool results belong to the preceding item so a selected assistant
 * turn retains the command/result cards that followed it.
 */
function copyTargets(entries: readonly TranscriptEntry[]): CopyTarget[] {
	const targets: CopyTarget[] = [];
	for (const entry of entries) {
		const message = transcriptEntryMessage(entry);
		if (!message) continue;
		if (message.role === "toolResult") {
			const previous = targets.at(-1);
			if (previous) previous.entries.push(entry);
			continue;
		}
		if (entry.type === "custom_message" && !entry.display) continue;
		if ((message.role === "custom" || message.role === "hookMessage") && !message.display) continue;
		if ((message.role === "user" || message.role === "developer") && !textContent(message.content).trim()) continue;
		targets.push({ id: entry.id, entries: [entry] });
	}
	return targets;
}

function rawUserText(message: Extract<AgentMessage, { role: "user" }>): string {
	return textContent(message.content, "\n");
}

function assistantVisibleText(message: Extract<AgentMessage, { role: "assistant" }>): string {
	let text = "";
	for (const content of message.content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim();
}

function toolResultText(message: Extract<AgentMessage, { role: "toolResult" }>): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n")
		.trim();
}

function pushMarkdownBlocks(blocks: CopyBlock[], text: string): void {
	for (const block of extractBlocks(text)) {
		if (block.kind === "code") {
			blocks.push({
				label: block.lang ? `${block.lang} code` : "code",
				content: block.code,
				language: block.lang || undefined,
			});
		} else {
			blocks.push({ label: "quote", content: block.text });
		}
	}
	for (const link of extractLinks(text)) {
		blocks.push({
			label: link.text !== link.href ? `link · ${link.text}` : "link",
			content: link.href,
			href: link.href,
		});
	}
}

function collectBlocks(entries: readonly TranscriptEntry[]): CopyBlock[] {
	const blocks: CopyBlock[] = [];
	for (const entry of entries) {
		const message = transcriptEntryMessage(entry);
		if (!message) continue;
		switch (message.role) {
			case "user":
				pushMarkdownBlocks(blocks, rawUserText(message));
				break;
			case "assistant": {
				pushMarkdownBlocks(blocks, assistantVisibleText(message));
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					const command = commandFromToolCall(content);
					if (command) {
						blocks.push({
							label: command.kind === "bash" ? "bash command" : "eval code",
							content: command.code,
							language: command.language,
						});
					}
				}
				break;
			}
			case "toolResult": {
				const text = toolResultText(message);
				if (text) blocks.push({ label: `${message.toolName} result`, content: text });
				break;
			}
			case "bashExecution":
				blocks.push({ label: "command", content: message.command, language: "bash" });
				if (message.output.trim()) blocks.push({ label: "output", content: message.output });
				break;
			case "pythonExecution":
				blocks.push({ label: "eval code", content: message.code, language: "python" });
				if (message.output.trim()) blocks.push({ label: "output", content: message.output });
				break;
			default:
				break;
		}
	}
	return blocks;
}

function targetCopy(target: CopyTarget, blocks: readonly CopyBlock[]): { content: string; label: string } {
	const message = transcriptEntryMessage(target.entries[0]!);
	if (!message) return { content: blocks.map(block => block.content).join("\n\n"), label: "turn content" };
	switch (message.role) {
		case "user":
			return { content: rawUserText(message), label: "user message" };
		case "assistant": {
			const text = assistantVisibleText(message);
			if (text) return { content: text, label: "assistant message" };
			break;
		}
		case "toolResult": {
			const text = toolResultText(message);
			if (text) return { content: text, label: `${message.toolName} result` };
			break;
		}
		case "bashExecution":
			return {
				content: [message.command, message.output].filter(part => part.trim()).join("\n"),
				label: "bash execution",
			};
		case "pythonExecution":
			return {
				content: [message.code, message.output].filter(part => part.trim()).join("\n"),
				label: "eval execution",
			};
		case "compactionSummary":
		case "branchSummary":
			return { content: message.summary, label: "summary" };
		case "custom":
		case "hookMessage": {
			const draft = message.role === "custom" ? userTurnDraft(target.entries[0]!) : undefined;
			if (draft?.trim()) return { content: draft, label: "user message" };
			const text = textContent(message.content, "\n");
			if (text.trim()) return { content: text, label: "message" };
			break;
		}
		default:
			break;
	}
	return { content: blocks.map(block => block.content).join("\n\n"), label: "turn content" };
}

export interface CopySelectorController {
	readonly selectedIndex: Accessor<number>;
	readonly expanded: Accessor<boolean>;
	readonly targetCount: Accessor<number>;
	readonly inBlocks: Accessor<boolean>;
	readonly blockSelected: Accessor<number>;
	readonly scrollOffset: Accessor<number>;
	handleInput(data: string): void;
	copy(): void;
	selectBlock(index: number): void;
	copyBlock(index: number): void;
	openBlock(index: number): void;
	scroll(delta: number): void;
	cancel(): void;
	dispose(): void;
}

export function createCopySelectorController(
	entries: readonly TranscriptEntry[],
	deps: CopySelectorDeps,
): CopySelectorController {
	const targets = copyTargets(entries);
	const [selectedIndex, setSelectedIndex] = createSignal(Math.max(0, targets.length - 1));
	const [expanded, setExpanded] = createSignal(false);
	const [inBlocks, setInBlocks] = createSignal(false);
	const [blockSelected, setBlockSelected] = createSignal(0);
	const [scrollOffset, setScrollOffset] = createSignal(0);
	const targetCount = (): number => targets.length;
	const blockCache = new Map<string, CopyBlock[]>();
	const blocksForSelected = (): CopyBlock[] => {
		const target = targets[selectedIndex()];
		if (!target) return [];
		const cached = blockCache.get(target.id);
		if (cached) return cached;
		const blocks = collectBlocks(target.entries);
		blockCache.set(target.id, blocks);
		return blocks;
	};
	let disposed = false;
	const descend = (): void => {
		if (blocksForSelected().length === 0) return;
		setBlockSelected(0);
		setInBlocks(true);
	};
	const ascend = (): void => {
		setInBlocks(false);
		setBlockSelected(0);
	};
	const copy = (): void => {
		const target = targets[selectedIndex()];
		if (!target) return;
		const blocks = blocksForSelected();
		if (inBlocks()) {
			const block = blocks[blockSelected()];
			if (block) deps.onPick(block.content, block.label);
			return;
		}
		const item = targetCopy(target, blocks);
		deps.onPick(item.content, item.label);
	};
	const selectBlock = (index: number): void => {
		const blocks = blocksForSelected();
		if (index >= 0 && index < blocks.length) setBlockSelected(index);
	};
	const copyBlock = (index: number): void => {
		selectBlock(index);
		const block = blocksForSelected()[index];
		if (block) deps.onPick(block.content, block.label);
	};
	const openBlock = (index: number): void => {
		selectBlock(index);
		const block = blocksForSelected()[index];
		if (block?.href) deps.onOpen?.(block.href, block.label);
	};
	return {
		selectedIndex,
		expanded,
		targetCount,
		inBlocks,
		blockSelected,
		scrollOffset,
		handleInput(data) {
			if (disposed) return;
			if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
				if (inBlocks()) ascend();
				else deps.onCancel();
				return;
			}
			if (matchesAppToolsExpand(data)) {
				setExpanded(value => !value);
				return;
			}
			if (matchesSelectUp(data)) {
				if (inBlocks()) selectBlock(blockSelected() - 1);
				else if (selectedIndex() > 0) {
					setSelectedIndex(index => index - 1);
					setScrollOffset(offset => Math.max(0, offset - 1));
				}
				return;
			}
			if (matchesSelectDown(data)) {
				if (inBlocks()) selectBlock(blockSelected() + 1);
				else if (selectedIndex() < targets.length - 1) {
					setSelectedIndex(index => index + 1);
					setScrollOffset(offset => offset + 1);
				}
				return;
			}
			if (matchesSelectPageUp(data)) return setScrollOffset(offset => Math.max(0, offset - 12));
			if (matchesSelectPageDown(data)) return setScrollOffset(offset => offset + 12);
			if (matchesKey(data, "home")) return setScrollOffset(0);
			if (matchesKey(data, "end")) return setScrollOffset(Number.MAX_SAFE_INTEGER);
			if (matchesKey(data, "right")) return descend();
			if (matchesKey(data, "left")) return ascend();
			if ((data === "o" || data === "O") && inBlocks()) return openBlock(blockSelected());
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") return copy();
		},
		copy,
		selectBlock,
		copyBlock,
		openBlock,
		scroll(delta) {
			setScrollOffset(offset => Math.max(0, offset + delta));
		},
		cancel() {
			if (inBlocks()) ascend();
			else deps.onCancel();
		},
		dispose(): void {
			disposed = true;
		},
	};
}

interface CopyTargetTranscriptProps {
	readonly target: CopyTarget;
	readonly deps: ChatTranscriptBuilderDeps;
	readonly expanded: Accessor<boolean>;
}

function CopyTargetTranscript(props: CopyTargetTranscriptProps): JSX.Element {
	const builder = new ChatTranscriptBuilder(props.deps);
	builder.rebuild(props.target.entries);
	createEffect(() => builder.setExpanded(props.expanded()));
	onCleanup(() => builder.dispose());
	return <TranscriptView store={builder.store} />;
}

interface CopyBlockViewProps {
	readonly block: CopyBlock;
	readonly index: number;
	readonly count: number;
	readonly selected: boolean;
	readonly controller: CopySelectorController;
}

function CopyBlockView(props: CopyBlockViewProps): JSX.Element {
	const theme = useTheme();
	const preview = (): string => {
		const lines = props.block.content.split("\n");
		const visible = lines.slice(0, BLOCK_PREVIEW_LINES);
		if (lines.length > visible.length) visible.push(`… +${lines.length - visible.length} more lines`);
		return visible.join("\n");
	};
	const mouse =
		(action: () => void) =>
		(event: HostMouseEvent): void => {
			if (event.action !== "down" || event.button !== 0) return;
			action();
			event.preventDefault();
		};
	const dotted = {
		topLeft: theme.symbol("boxRound.topLeft"),
		topRight: theme.symbol("boxRound.topRight"),
		bottomLeft: theme.symbol("boxRound.bottomLeft"),
		bottomRight: theme.symbol("boxRound.bottomRight"),
		horizontal: theme.symbol("boxDotted.horizontal"),
		vertical: theme.symbol("boxDotted.vertical"),
	};
	const summary = `${props.index + 1}/${props.count} · ${props.block.label} · ${props.block.content.split("\n").length} line${props.block.content.includes("\n") ? "s" : ""}`;
	const body = () =>
		props.block.language ? (
			<code document={createDocument(preview())} language={props.block.language} wrap={false} />
		) : (
			<text wrap="none">{preview()}</text>
		);
	return (
		<box
			border={props.selected ? { chars: dotted, color: "success" } : undefined}
			padding={props.selected ? { x: 1 } : { left: 2 }}
		>
			<stack gap={0}>
				<row gap={1}>
					<text color={props.selected ? "success" : "dim"} wrap="none">
						{summary}
					</text>
					<text grow={1} />
					<text color="accent" onMouse={mouse(() => props.controller.copyBlock(props.index))}>
						{theme.symbol("cmd.copy")} copy
					</text>
					<Show when={props.block.href}>
						<text color="accent" onMouse={mouse(() => props.controller.openBlock(props.index))}>
							{theme.symbol("cmd.share")} open
						</text>
					</Show>
				</row>
				{body()}
			</stack>
		</box>
	);
}

export interface CopySelectorViewProps {
	readonly entries: readonly TranscriptEntry[];
	readonly controller: CopySelectorController;
	readonly deps?: CopySelectorDeps;
}

export function CopySelectorView(props: CopySelectorViewProps): JSX.Element {
	const targets = copyTargets(props.entries);
	const deps = props.deps ?? {};
	const theme = useTheme();
	const blocks = (): CopyBlock[] => {
		const target = targets[props.controller.selectedIndex()];
		return target ? collectBlocks(target.entries) : [];
	};
	const handleKey = (event: HostKeyEvent): void => {
		props.controller.handleInput(event.data);
		event.preventDefault();
	};
	const handleMouse = (event: HostMouseEvent): void => {
		if (event.action !== "wheel") return;
		props.controller.scroll(event.wheel * 3);
		event.preventDefault();
	};
	const visibleRows = Math.max(8, (process.stdout.rows || 40) - 5);
	const turnHint = (): string => {
		const count = props.controller.targetCount();
		const selected = props.controller.selectedIndex();
		const blockCount = blocks().length;
		return `${count > 0 ? `${selected + 1}/${count}  ` : ""}↑/↓ step  ${blockCount > 0 ? "→ blocks  " : ""}enter copy  ctrl+o expand  esc close`;
	};
	return (
		<box tabIndex={0} onKey={handleKey} onMouse={handleMouse}>
			<frame
				title={
					<row gap={1}>
						<text color="accent">{theme.symbol("cmd.copy")}</text>
						<text bold>Copy</text>
					</row>
				}
				subtitle="pick what to put on the clipboard"
				paddingX={1}
				paddingY={0}
				borderPolicy="always"
				fitContent
				renderEmpty
			>
				<stack>
					<scroll height={visibleRows} offset={props.controller.scrollOffset()} followTail={false} shrinkToFit>
						<Show
							when={props.controller.inBlocks()}
							fallback={
								<stack gap={0}>
									<For each={targets}>
										{(target, index) => (
											<Show
												when={props.controller.selectedIndex() === index()}
												fallback={
													<box padding={{ left: 2 }}>
														<CopyTargetTranscript
															target={target}
															deps={deps}
															expanded={props.controller.expanded}
														/>
													</box>
												}
											>
												<box
													border={{
														chars: {
															topLeft: theme.symbol("boxRound.topLeft"),
															topRight: theme.symbol("boxRound.topRight"),
															bottomLeft: theme.symbol("boxRound.bottomLeft"),
															bottomRight: theme.symbol("boxRound.bottomRight"),
															horizontal: theme.symbol("boxDotted.horizontal"),
															vertical: theme.symbol("boxDotted.vertical"),
														},
														color: "success",
													}}
													padding={{ x: 1 }}
												>
													<stack gap={0}>
														<text color="success" align="right">
															{blocks().length > 0
																? `${blocks().length} block${blocks().length === 1 ? "" : "s"} →`
																: ""}
														</text>
														<CopyTargetTranscript
															target={target}
															deps={deps}
															expanded={props.controller.expanded}
														/>
													</stack>
												</box>
											</Show>
										)}
									</For>
								</stack>
							}
						>
							<stack gap={1}>
								<For each={blocks()}>
									{(block, index) => (
										<CopyBlockView
											block={block}
											index={index()}
											count={blocks().length}
											selected={props.controller.blockSelected() === index()}
											controller={props.controller}
										/>
									)}
								</For>
							</stack>
						</Show>
					</scroll>
					<text color="dim" wrap="word">
						{props.controller.inBlocks()
							? `${props.controller.blockSelected() + 1}/${blocks().length}  ↑/↓ block  ←/esc back  enter copy${blocks()[props.controller.blockSelected()]?.href && props.deps?.onOpen ? "  o open" : ""}  click ${theme.symbol("cmd.copy")}/${theme.symbol("cmd.share")}`
							: turnHint()}
					</text>
				</stack>
			</frame>
		</box>
	);
}

export interface CopySelectorOverlayProps {
	readonly entries: TranscriptEntry[];
	readonly deps: CopySelectorDeps;
}

export interface CopySelectorHandle extends OverlayDisposer, CopySelectorController {}

export function openCopySelectorOverlay(tui: TUI, props: CopySelectorOverlayProps): CopySelectorHandle {
	const deps: CopySelectorDeps = props.deps;
	const controller = createCopySelectorController(props.entries, deps);
	const disposer = mountOverlay(tui, () => (
		<Portal to="overlay" fullscreen anchor="bottom-center">
			<CopySelectorView entries={props.entries} controller={controller} deps={{ ...deps, promptZones: false }} />
		</Portal>
	));
	return bindOverlayController(disposer, controller);
}
