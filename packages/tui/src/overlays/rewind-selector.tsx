import {
	ChatTranscriptBuilder,
	type ChatTranscriptHookMessageView,
	type ChatTranscriptMessageView,
} from "../chat/chat-transcript-builder";
import { scrollOffsetForRow } from "../components/scroll-viewport";
import {
	isUserRequestEntry,
	textContent,
	userMessageLabel,
	userTurnDraft,
	type TranscriptEntryLike as TranscriptEntry,
} from "../chat/transcript-entry";
import type { TranscriptEntry as TranscriptBlock } from "../chat/transcript-store";
import type { BoxBorder } from "../host/elements/box";
import type { ScrollViewportState } from "../host/elements/scroll";
import { bindOverlayController, Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import { matchesKey } from "../keys";
import { matchesAppToolsExpand, matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { parseSgrMouse } from "../mouse";
import { For, Show, createSignal, type Accessor, type JSX } from "../reactive";
import { useTheme, type ThemeAccess } from "../theme/reactive";
import type { TUI } from "../tui";

export interface BranchVariantPath {
	rootId: string;
	entries: TranscriptEntry[];
}

export interface RewindSelectorDeps {
	ui: TUI;
	getMessageView?: (customType: string) => ChatTranscriptMessageView | undefined;
	getHookMessageView?: (customType: string) => ChatTranscriptHookMessageView | undefined;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	linkTargets?: ReadonlyMap<string, string>;
	siblingPaths?: (entryId: string) => BranchVariantPath[];
	onSelect: (entryId: string) => void;
	onCancel: () => void;
}

interface RewindTarget {
	entryId: string;
	readonly turnId: string;
	readonly isUserTurn: boolean;
	readonly blocks: TranscriptBlock[];
}

interface RewindBranch {
	readonly label: string;
	readonly builder: ChatTranscriptBuilder;
	readonly targets: RewindTarget[];
}

function isUserTurn(entry: TranscriptEntry): boolean {
	if (entry.type === "message" && entry.message.role === "user")
		return textContent(entry.message.content).trim().length > 0;
	return isUserRequestEntry(entry);
}

function turnLabel(entry: TranscriptEntry): string | undefined {
	if (entry.type === "message" && entry.message.role === "user") return userMessageLabel(entry.message.content);
	const draft = userTurnDraft(entry);
	return draft === undefined ? undefined : userMessageLabel(draft);
}

function createTranscriptBuilder(deps: RewindSelectorDeps): ChatTranscriptBuilder {
	return new ChatTranscriptBuilder({
		getMessageView: deps.getMessageView,
		getHookMessageView: deps.getHookMessageView,
		hideThinkingBlock: deps.hideThinkingBlock,
		proseOnlyThinking: deps.proseOnlyThinking,
		promptZones: false,
		linkTargets: deps.linkTargets,
	});
}

/** Recover the persisted source id from the builder's `${sourceId}:${ordinal}` block identity. */
function transcriptBlockSourceId(id: string): string {
	return id.slice(0, id.lastIndexOf(":"));
}

/**
 * Replay one path and retain the exact block ranges that a rewind point owns.
 * Pending usage flushes under its originating assistant id, and tool results
 * extend the prior point rather than creating one.
 */
function appendRewindTargets(builder: ChatTranscriptBuilder, entries: readonly TranscriptEntry[]): RewindTarget[] {
	const targets: RewindTarget[] = [];
	for (const entry of entries) {
		const before = builder.store.entries().length;
		builder.append([entry]);
		const blocks = builder.store.entries();
		const after = blocks.length;
		let start = before;
		while (start < after && transcriptBlockSourceId(blocks[start]!.id) !== entry.id) {
			const previous = targets.at(-1);
			if (previous) previous.blocks.push(blocks[start]!);
			start++;
		}
		const previous = targets.at(-1);
		if (entry.type === "message" && entry.message.role === "toolResult" && previous) {
			previous.entryId = entry.id;
			continue;
		}
		if (start === after) continue;
		targets.push({
			entryId: entry.id,
			turnId: entry.id,
			isUserTurn: isUserTurn(entry),
			blocks: blocks.slice(start, after),
		});
	}
	return targets;
}

function createBranch(path: BranchVariantPath, deps: RewindSelectorDeps): RewindBranch {
	const builder = createTranscriptBuilder(deps);
	const targets = appendRewindTargets(builder, path.entries);
	const firstUser = path.entries.find(isUserTurn);
	return {
		label: firstUser ? turnLabel(firstUser) || path.rootId : path.rootId,
		builder,
		targets,
	};
}

function dottedOutline(theme: ThemeAccess): BoxBorder {
	return {
		color: "accent",
		chars: {
			topLeft: theme.symbol("boxRound.topLeft"),
			topRight: theme.symbol("boxRound.topRight"),
			bottomLeft: theme.symbol("boxRound.bottomLeft"),
			bottomRight: theme.symbol("boxRound.bottomRight"),
			horizontal: theme.symbol("boxDotted.horizontal"),
			vertical: theme.symbol("boxDotted.vertical"),
		},
	};
}

export interface RewindSelectorController {
	readonly selectedIndex: Accessor<number>;
	readonly expanded: Accessor<boolean>;
	readonly activeVariant: Accessor<number>;
	readonly cameraPosition: Accessor<number>;
	readonly siblingSelectedIndex: Accessor<number>;
	readonly scrollOffset: Accessor<number>;
	readonly viewport: Accessor<ScrollViewportState>;
	readonly targetCount: Accessor<number>;
	readonly mainBranch: RewindBranch;
	branches(): readonly RewindBranch[];
	recordTargetLayout(branch: RewindBranch, target: RewindTarget, row: number): void;
	handleInput(data: string): void;
	handleMouse(event: HostMouseEvent): void;
	setViewport(viewport: ScrollViewportState): void;
	select(): void;
	cancel(): void;
	dispose(): void;
}

export function createRewindSelectorController(
	entries: readonly TranscriptEntry[],
	deps: RewindSelectorDeps,
): RewindSelectorController {
	const mainBuilder = createTranscriptBuilder(deps);
	const mainBranch: RewindBranch = {
		label: "current",
		builder: mainBuilder,
		targets: appendRewindTargets(mainBuilder, entries),
	};
	const [selectedIndex, setSelectedIndex] = createSignal(Math.max(0, mainBranch.targets.length - 1));
	const [expanded, setExpanded] = createSignal(false);
	const [activeVariant, setActiveVariant] = createSignal(0);
	const [cameraPosition, setCameraPosition] = createSignal(0);
	const [siblingSelectedIndex, setSiblingSelectedIndex] = createSignal(0);
	const [scrollOffset, setScrollOffset] = createSignal(0);
	const [viewport, setViewport] = createSignal<ScrollViewportState>({
		offset: 0,
		totalRows: 0,
		height: Math.max(3, (deps.ui.terminal?.rows ?? 40) - 5),
		width: Math.max(1, deps.ui.terminal?.columns ?? 80),
	});
	const variantCache = new Map<string, RewindBranch[]>();
	const targetRows = new Map<RewindBranch, Map<RewindTarget, number>>();
	const mainVisibility = new Map<RewindTarget, boolean>();
	let revealPending = true;
	let slideTimer: NodeJS.Timeout | undefined;
	let disposed = false;

	const stopSlide = (): void => {
		if (slideTimer !== undefined) clearInterval(slideTimer);
		slideTimer = undefined;
	};
	const slideTo = (variant: number): void => {
		const from = cameraPosition();
		const startedAt = Date.now();
		stopSlide();
		setActiveVariant(variant);
		slideTimer = setInterval(() => {
			const elapsed = Date.now() - startedAt;
			const progress = Math.min(1, elapsed / 160);
			const eased = 1 - (1 - progress) ** 3;
			setCameraPosition(from + (variant - from) * eased);
			if (progress === 1) stopSlide();
		}, 16);
	};
	const targetCount = (): number => mainBranch.targets.length;
	const branches = (): readonly RewindBranch[] => {
		const target = mainBranch.targets[selectedIndex()];
		if (!target || !deps.siblingPaths) return [];
		const cached = variantCache.get(target.turnId);
		if (cached) return cached;
		const variants: RewindBranch[] = [];
		for (const path of deps.siblingPaths(target.turnId)) {
			if (path.entries.length === 0) continue;
			const branch = createBranch(path, deps);
			branch.builder.setExpanded(expanded());
			variants.push(branch);
		}
		variantCache.set(target.turnId, variants);
		return variants;
	};
	const selection = (): { branch: RewindBranch; target: RewindTarget } | undefined => {
		if (activeVariant() === 0) {
			const target = mainBranch.targets[selectedIndex()];
			return target ? { branch: mainBranch, target } : undefined;
		}
		const branch = branches()[activeVariant() - 1];
		const target = branch?.targets[siblingSelectedIndex()];
		return branch && target ? { branch, target } : undefined;
	};
	const revealSelection = (): void => {
		if (!revealPending || branches().length > 0) return;
		const selected = selection();
		if (!selected) return;
		const block = selected.target.blocks[0];
		const row = block ? selected.branch.builder.store.rowForEntry(block.id) : undefined;
		if (row === undefined) return;
		revealPending = false;
		const viewportState = viewport();
		const offset = scrollOffsetForRow(
			viewportState.offset,
			row,
			viewportState.totalRows,
			viewportState.height,
			"nearest",
		);
		if (offset === scrollOffset()) return;
		setScrollOffset(offset);
	};
	const recordTargetLayout = (branch: RewindBranch, target: RewindTarget, row: number): void => {
		const layoutChanged =
			target.blocks[0] !== undefined && branch.builder.store.rowForEntry(target.blocks[0].id) !== row;
		if (layoutChanged) revealPending = true;
		for (const block of target.blocks) branch.builder.store.setEntryRow(block.id, row);
		let rows = targetRows.get(branch);
		if (!rows) {
			rows = new Map<RewindTarget, number>();
			targetRows.set(branch, rows);
		}
		rows.set(target, row);
		if (layoutChanged && viewport().totalRows > 0) revealSelection();
	};
	const refreshMainVisibility = (): void => {
		if (branches().length > 0) return;
		const rows = targetRows.get(mainBranch);
		const totalRows = viewport().totalRows;
		for (let index = 0; index < mainBranch.targets.length; index++) {
			const target = mainBranch.targets[index]!;
			const start = rows?.get(target);
			let end = totalRows;
			for (let next = index + 1; next < mainBranch.targets.length; next++) {
				const following = rows?.get(mainBranch.targets[next]!);
				if (following !== undefined) {
					end = following;
					break;
				}
			}
			mainVisibility.set(target, start !== undefined && end > start);
		}
		const selected = mainBranch.targets[selectedIndex()];
		if (selected && mainVisibility.get(selected) === false) {
			for (let index = selectedIndex() - 1; index >= 0; index--) {
				if (mainVisibility.get(mainBranch.targets[index]!) !== true) continue;
				setSelectedIndex(index);
				setActiveVariant(0);
				setSiblingSelectedIndex(0);
				revealPending = true;
				return;
			}
			for (let index = selectedIndex() + 1; index < mainBranch.targets.length; index++) {
				if (mainVisibility.get(mainBranch.targets[index]!) !== true) continue;
				setSelectedIndex(index);
				setActiveVariant(0);
				setSiblingSelectedIndex(0);
				revealPending = true;
				return;
			}
		}
	};
	const moveMain = (delta: -1 | 1, accept: (target: RewindTarget) => boolean): void => {
		for (let index = selectedIndex() + delta; index >= 0 && index < mainBranch.targets.length; index += delta) {
			if (mainVisibility.get(mainBranch.targets[index]!) === false || !accept(mainBranch.targets[index]!)) continue;
			stopSlide();
			setCameraPosition(0);
			setSelectedIndex(index);
			setActiveVariant(0);
			setSiblingSelectedIndex(0);
			revealPending = true;
			revealSelection();
			return;
		}
	};
	const scroll = (delta: number): void => {
		const next = Math.max(0, Math.min(Math.max(0, viewport().totalRows - viewport().height), scrollOffset() + delta));
		if (next === scrollOffset()) return;
		setScrollOffset(next);
	};
	const updateViewport = (next: ScrollViewportState): void => {
		const current = viewport();
		if (
			current.offset === next.offset &&
			current.totalRows === next.totalRows &&
			current.height === next.height &&
			current.width === next.width
		)
			return;
		if (current.totalRows !== next.totalRows || current.height !== next.height || current.width !== next.width)
			revealPending = true;
		setViewport(next);
		if (scrollOffset() !== next.offset) setScrollOffset(next.offset);
		refreshMainVisibility();
		revealSelection();
	};
	const select = (): void => {
		if (disposed) return;
		const target =
			activeVariant() > 0
				? branches()[activeVariant() - 1]?.targets[siblingSelectedIndex()]
				: mainBranch.targets[selectedIndex()];
		if (target) deps.onSelect(target.entryId);
	};
	const cancel = (): void => {
		if (!disposed) deps.onCancel();
	};
	const moveVertical = (delta: -1 | 1): void => {
		if (activeVariant() === 0) {
			moveMain(delta, () => true);
			return;
		}
		const targets = branches()[activeVariant() - 1]?.targets ?? [];
		const next = siblingSelectedIndex() + delta;
		if (next >= 0 && next < targets.length) {
			setSiblingSelectedIndex(next);
			return;
		}
		if (delta === -1) {
			const selected = selectedIndex();
			stopSlide();
			setCameraPosition(0);
			setActiveVariant(0);
			setSiblingSelectedIndex(0);
			moveMain(-1, () => true);
		}
	};
	return {
		selectedIndex,
		expanded,
		activeVariant,
		cameraPosition,
		siblingSelectedIndex,
		scrollOffset,
		viewport,
		targetCount,
		mainBranch,
		branches,
		recordTargetLayout,
		handleInput(data) {
			if (disposed) return;
			const mouse = data.startsWith("\x1b[<") ? parseSgrMouse(data) : null;
			if (mouse) {
				if (mouse.wheel !== null) scroll(mouse.wheel * 3);
				return;
			}
			if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
				cancel();
				return;
			}
			if (matchesAppToolsExpand(data)) {
				const next = !expanded();
				setExpanded(next);
				if (activeVariant() === 0) revealPending = true;
				mainBranch.builder.setExpanded(next);
				for (const variants of variantCache.values())
					for (const branch of variants) branch.builder.setExpanded(next);
				return;
			}
			if (matchesSelectUp(data)) {
				moveVertical(-1);
				return;
			}
			if (matchesSelectDown(data)) {
				moveVertical(1);
				return;
			}
			if (matchesKey(data, "left")) {
				if (activeVariant() > 0) {
					slideTo(activeVariant() - 1);
				} else {
					moveMain(-1, target => target.isUserTurn);
				}
				return;
			}
			if (matchesKey(data, "right")) {
				const variants = branches();
				if (activeVariant() < variants.length) {
					setSiblingSelectedIndex(0);
					slideTo(activeVariant() + 1);
				} else if (activeVariant() === 0) {
					moveMain(1, target => target.isUserTurn);
				}
				return;
			}
			if (matchesKey(data, "shift+up")) {
				scroll(-5);
				return;
			}
			if (matchesKey(data, "shift+down")) {
				scroll(5);
				return;
			}
			if (matchesKey(data, "pageUp")) {
				scroll(-viewport().height);
				return;
			}
			if (matchesKey(data, "pageDown")) {
				scroll(viewport().height);
				return;
			}
			if (matchesKey(data, "home")) {
				setScrollOffset(0);
				return;
			}
			if (matchesKey(data, "end")) {
				setScrollOffset(Math.max(0, viewport().totalRows - viewport().height));
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") select();
		},
		handleMouse(event) {
			if (!disposed && event.action === "wheel" && event.wheel !== 0) scroll(event.wheel * 3);
		},
		setViewport: updateViewport,
		select,
		cancel,
		dispose() {
			if (disposed) return;
			disposed = true;
			stopSlide();
			mainBranch.builder.dispose();
			for (const variants of variantCache.values()) for (const branch of variants) branch.builder.dispose();
			variantCache.clear();
			targetRows.clear();
			mainVisibility.clear();
		},
	};
}

function RewindTargetView(props: {
	readonly target: RewindTarget;
	readonly outlined: Accessor<boolean>;
	readonly onTargetLayout: (target: RewindTarget, row: number) => void;
}): JSX.Element {
	const theme = useTheme();
	return (
		<transcript-block settled onRowLayout={row => props.onTargetLayout(props.target, row)}>
			<box
				border={props.outlined() ? dottedOutline(theme) : undefined}
				padding={props.outlined() ? { x: 1 } : { x: 2 }}
			>
				<For each={props.target.blocks}>{block => <>{block.view()}</>}</For>
			</box>
		</transcript-block>
	);
}

function RewindTargetList(props: {
	readonly branch: RewindBranch;
	readonly from: Accessor<number>;
	readonly to?: Accessor<number>;
	readonly outlinedIndex: Accessor<number>;
	readonly onTargetLayout: (target: RewindTarget, row: number) => void;
}): JSX.Element {
	const targets = (): readonly RewindTarget[] => props.branch.targets.slice(props.from(), props.to?.());
	return (
		<transcript>
			<For each={targets()}>
				{(target, index) => (
					<RewindTargetView
						target={target}
						outlined={() => props.outlinedIndex() === props.from() + index()}
						onTargetLayout={props.onTargetLayout}
					/>
				)}
			</For>
		</transcript>
	);
}

function RewindBranchColumn(props: {
	readonly branch: RewindBranch;
	readonly index: number;
	readonly count: Accessor<number>;
	readonly from: Accessor<number>;
	readonly active: Accessor<boolean>;
	readonly outlinedIndex: Accessor<number>;
	readonly width: Accessor<number>;
	readonly onTargetLayout: (target: RewindTarget, row: number) => void;
}): JSX.Element {
	const theme = useTheme();
	return (
		<box width={props.width()} shrink={0}>
			<stack gap={1}>
				<box padding={{ x: 1 }}>
					<text color={props.active() ? "accent" : "dim"} wrap="clip">
						{theme.symbol("icon.branch")} {props.index + 1}/{props.count()} · {props.branch.label}
					</text>
				</box>
				<RewindTargetList
					branch={props.branch}
					from={props.from}
					outlinedIndex={props.outlinedIndex}
					onTargetLayout={props.onTargetLayout}
				/>
			</stack>
		</box>
	);
}

function RewindBranchRail(props: {
	readonly count: Accessor<number>;
	readonly active: Accessor<number>;
	readonly moreLeft: Accessor<boolean>;
	readonly moreRight: Accessor<boolean>;
}): JSX.Element | null {
	const theme = useTheme();
	const indexes = (): number[] => Array.from({ length: props.count() }, (_, index) => index);
	return (
		<Show when={props.count() > 2}>
			<text align="center" wrap="clip">
				<Show when={props.moreLeft()}>
					<span color="dim">… </span>
				</Show>
				<For each={indexes()}>
					{index => (
						<span color={index === props.active() ? "accent" : "dim"}>
							{index === props.active() ? theme.symbol("radio.selected") : theme.symbol("radio.unselected")}
							{index + 1 < props.count() ? " " : ""}
						</span>
					)}
				</For>
				<Show when={props.moreRight()}>
					<span color="dim"> …</span>
				</Show>
			</text>
		</Show>
	);
}

function RewindBranchStrip(props: {
	readonly controller: RewindSelectorController;
	readonly branches: Accessor<readonly RewindBranch[]>;
	readonly columnWidth: Accessor<number>;
}): JSX.Element {
	const columns = (): readonly RewindBranch[] => [props.controller.mainBranch, ...props.branches()];
	return (
		<row gap={2}>
			<For each={columns()}>
				{(branch, index) => {
					const position = index();
					return (
						<RewindBranchColumn
							branch={branch}
							index={position}
							count={() => columns().length}
							from={() => (position === 0 ? props.controller.selectedIndex() : 0)}
							active={() => props.controller.activeVariant() === position}
							outlinedIndex={() =>
								position === 0
									? props.controller.activeVariant() === 0
										? props.controller.selectedIndex()
										: -1
									: props.controller.activeVariant() === position
										? props.controller.siblingSelectedIndex()
										: -1
							}
							width={props.columnWidth}
							onTargetLayout={(target, row) => props.controller.recordTargetLayout(branch, target, row)}
						/>
					);
				}}
			</For>
		</row>
	);
}

export interface RewindSelectorViewProps {
	readonly entries: readonly TranscriptEntry[];
	readonly controller: RewindSelectorController;
}

export function RewindSelectorView(props: RewindSelectorViewProps): JSX.Element {
	const theme = useTheme();
	const branches = (): readonly RewindBranch[] => props.controller.branches();
	const bodyHeight = (): number => props.controller.viewport().height;
	const branchCount = (): number => branches().length + 1;
	const columnWidth = (): number => Math.max(24, Math.floor(Math.max(1, props.controller.viewport().width - 2) / 2));
	const stripWidth = (): number => branchCount() * columnWidth() + Math.max(0, branchCount() - 1) * 2;
	const cameraAt = (position: number): number => {
		const width = props.controller.viewport().width;
		const stride = columnWidth() + 2;
		const desired = position * stride - (width - columnWidth()) / 2;
		return Math.max(0, Math.min(desired, Math.max(0, stripWidth() - width)));
	};
	const handleKey = (event: HostKeyEvent): void => {
		props.controller.handleInput(event.data);
		event.preventDefault();
		event.stopPropagation();
	};
	const handleMouse = (event: HostMouseEvent): void => {
		props.controller.handleMouse(event);
		event.preventDefault();
		event.stopPropagation();
	};
	const content = (): JSX.Element => (
		<Show
			when={branches().length > 0}
			fallback={
				<RewindTargetList
					branch={props.controller.mainBranch}
					from={() => 0}
					outlinedIndex={props.controller.selectedIndex}
					onTargetLayout={(target, row) =>
						props.controller.recordTargetLayout(props.controller.mainBranch, target, row)
					}
				/>
			}
		>
			<stack>
				<RewindTargetList
					branch={props.controller.mainBranch}
					from={() => 0}
					to={props.controller.selectedIndex}
					outlinedIndex={() => -1}
					onTargetLayout={(target, row) =>
						props.controller.recordTargetLayout(props.controller.mainBranch, target, row)
					}
				/>
				<Show when={branchCount() > 2}>
					<RewindBranchRail
						count={branchCount}
						active={props.controller.activeVariant}
						moreLeft={() => cameraAt(props.controller.activeVariant()) > 0.5}
						moreRight={() =>
							cameraAt(props.controller.activeVariant()) + props.controller.viewport().width < stripWidth() - 0.5
						}
					/>
					<br />
				</Show>
				<scroll
					height={bodyHeight()}
					shrinkToFit={false}
					scrollbar="never"
					followTail={false}
					contentWidth={stripWidth()}
					offsetX={cameraAt(props.controller.cameraPosition())}
				>
					<RewindBranchStrip controller={props.controller} branches={branches} columnWidth={columnWidth} />
				</scroll>
			</stack>
		</Show>
	);
	return (
		<box tabIndex={0} onKey={handleKey} onMouse={handleMouse}>
			<stack>
				<hr char={theme.symbol("boxRound.horizontal")} />
				<box padding={{ left: 1 }}>
					<text wrap="clip">
						{theme.symbol("icon.rewind")} <span bold>Rewind</span>
						<span color="dim"> · pick the point to continue from</span>
					</text>
				</box>
				<hr char={theme.symbol("boxRound.horizontal")} />
				<scroll
					height={bodyHeight()}
					offset={props.controller.scrollOffset()}
					scrollbar="auto"
					followTail={false}
					trackColor="dim"
					thumbColor="accent"
					onViewport={props.controller.setViewport}
				>
					{content()}
				</scroll>
				<box padding={{ left: 1 }}>
					<text color="dim" wrap="clip">
						{props.controller.selectedIndex() + 1}/{props.controller.targetCount()} ↑/↓ step{" "}
						{branches().length > 0 ? "←/→ branches" : "←/→ user turns"} enter rewind ctrl+o expand esc cancel
					</text>
				</box>
				<hr char={theme.symbol("boxRound.horizontal")} />
			</stack>
		</box>
	);
}

export interface RewindSelectorOverlayProps {
	readonly entries: TranscriptEntry[];
	readonly deps: Omit<RewindSelectorDeps, "ui">;
}

export interface RewindSelectorHandle extends OverlayDisposer, RewindSelectorController {}

export function openRewindSelectorOverlay(tui: TUI, props: RewindSelectorOverlayProps): RewindSelectorHandle {
	const controller = createRewindSelectorController(props.entries, { ...props.deps, ui: tui });
	const overlay = mountOverlay(tui, () => (
		<Portal to="overlay" fullscreen anchor="bottom-center" mouseTracking>
			<RewindSelectorView entries={props.entries} controller={controller} />
		</Portal>
	));
	return bindOverlayController(overlay, controller);
}
