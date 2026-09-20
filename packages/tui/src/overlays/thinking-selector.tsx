import type { Effort } from "@oh-my-pi/pi-ai";
import { takeCells } from "../core/out";
import { cellWidth } from "../core/richtext";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import { getKeybindings } from "../keybindings";
import { matchesKey } from "../keys";
import { createEffect, createMemo, createSignal, type JSX, useTheme } from "../reactive";
import { getThinkingLevelMetadata } from "../thinking";
import type { SizeValue, TUI } from "../tui";

export interface ThinkingSelectorProps {
	readonly currentLevel: Effort;
	readonly availableLevels: readonly Effort[];
	readonly onSelect: (level: Effort) => void;
	readonly onCancel: () => void;
	readonly width?: SizeValue;
}

const DESCRIPTION_COLUMN_WIDTH = 32;
const DESCRIPTION_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

interface ThinkingSelectorRow {
	readonly prefix: string;
	readonly label: string;
	readonly spacing: string;
	readonly description?: string;
}

function collapseLine(value: string): string {
	return value
		.replace(/\t/g, " ")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function selectorRow(level: Effort, selected: boolean, cursor: string, width: number): ThinkingSelectorRow {
	const metadata = getThinkingLevelMetadata(level);
	const label = collapseLine(metadata.label);
	const description = metadata.description ? collapseLine(metadata.description) : undefined;
	const prefixWidth = cellWidth(cursor) + 1;
	const prefix = selected ? `${cursor} ` : " ".repeat(prefixWidth);

	if (description && width > 40) {
		const primaryWidth = Math.max(1, Math.min(DESCRIPTION_COLUMN_WIDTH, width - prefixWidth - 4));
		const shownLabel = takeCells(label, Math.max(0, primaryWidth - DESCRIPTION_GAP));
		const spacing = " ".repeat(Math.max(1, primaryWidth - cellWidth(shownLabel)));
		const remaining = width - prefixWidth - cellWidth(shownLabel) - spacing.length - 2;
		if (remaining > MIN_DESCRIPTION_WIDTH) {
			return {
				prefix,
				label: shownLabel,
				spacing,
				description: takeCells(description, remaining),
			};
		}
	}

	return { prefix, label: takeCells(label, Math.max(0, width - prefixWidth - 2)), spacing: "" };
}

function ThinkingSelectorRows(props: {
	readonly levels: readonly Effort[];
	readonly selectedIndex: number;
	readonly hoveredIndex: number | undefined;
	readonly cursor: string;
	readonly width: number;
}): JSX.Element {
	return props.levels.map((level, index) => {
		const selected = index === props.selectedIndex;
		const hovered = !selected && index === props.hoveredIndex;
		const row = selectorRow(level, selected, props.cursor, props.width);
		return (
			<text color={selected ? "accent" : undefined} background={hovered ? "selectedBg" : undefined} wrap="none">
				{row.prefix}
				{row.label}
				{row.spacing}
				{row.description ? (
					<span color={selected ? undefined : "muted"} background={hovered ? "selectedBg" : undefined}>
						{row.description}
					</span>
				) : null}
			</text>
		);
	});
}

export function ThinkingSelector(props: ThinkingSelectorProps): JSX.Element {
	const theme = useTheme();
	const levels = createMemo(() => props.availableLevels);
	const [selectedIndex, setSelectedIndex] = createSignal(
		Math.max(0, props.availableLevels.indexOf(props.currentLevel)),
	);
	const [hoveredIndex, setHoveredIndex] = createSignal<number>();
	const revision = createMemo(() => `${levels().join("\0")}:${selectedIndex()}:${hoveredIndex() ?? ""}`);

	createEffect(() => {
		const currentIndex = levels().indexOf(props.currentLevel);
		setSelectedIndex(currentIndex < 0 ? 0 : currentIndex);
		setHoveredIndex(undefined);
	});

	const move = (delta: number): void => {
		const available = levels();
		if (available.length === 0) return;
		setSelectedIndex(current => (((current + delta) % available.length) + available.length) % available.length);
		setHoveredIndex(undefined);
	};

	const select = (index: number): void => {
		const level = levels()[index];
		if (level === undefined) return;
		setSelectedIndex(index);
		setHoveredIndex(undefined);
		props.onSelect(level);
	};

	const handleKey = (event: HostKeyEvent): void => {
		const keybindings = getKeybindings();
		if (keybindings.matches(event.data, "tui.select.cancel")) {
			props.onCancel();
			event.preventDefault();
			return;
		}
		if (keybindings.matches(event.data, "tui.select.up")) {
			move(-1);
			event.preventDefault();
			return;
		}
		if (keybindings.matches(event.data, "tui.select.down")) {
			move(1);
			event.preventDefault();
			return;
		}
		if (keybindings.matches(event.data, "tui.select.pageUp")) {
			move(-levels().length);
			event.preventDefault();
			return;
		}
		if (keybindings.matches(event.data, "tui.select.pageDown")) {
			move(levels().length);
			event.preventDefault();
			return;
		}
		if (matchesKey(event.data, "home")) {
			setSelectedIndex(0);
			setHoveredIndex(undefined);
			event.preventDefault();
			return;
		}
		if (matchesKey(event.data, "end")) {
			setSelectedIndex(Math.max(0, levels().length - 1));
			setHoveredIndex(undefined);
			event.preventDefault();
			return;
		}
		if (keybindings.matches(event.data, "tui.select.confirm") || event.data === "\n") {
			select(selectedIndex());
			event.preventDefault();
		}
	};

	const handleMouse = (event: HostMouseEvent): void => {
		if (event.action === "wheel") {
			move(event.wheel);
			event.preventDefault();
			return;
		}
		// The selector's frame is its root: row zero is the top border and
		// its list begins immediately below it, as in the historical overlay.
		const index = event.localRow - 1;
		if (event.action === "move") {
			setHoveredIndex(index >= 0 && index < levels().length ? index : undefined);
			return;
		}
		if (event.action === "down" && event.button === 0 && index >= 0 && index < levels().length) {
			select(index);
			event.preventDefault();
		}
	};

	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"} mouseTracking>
			<box tabIndex={0} onKey={handleKey} onMouse={handleMouse}>
				<frame title="Thinking Level" paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
					<sized
						key={revision()}
						paint={width => (
							<ThinkingSelectorRows
								levels={levels()}
								selectedIndex={selectedIndex()}
								hoveredIndex={hoveredIndex()}
								cursor={theme.symbol("nav.cursor")}
								width={width}
							/>
						)}
					/>
				</frame>
			</box>
		</Portal>
	);
}

export function openThinkingSelector(
	tui: TUI,
	currentLevel: Effort,
	availableLevels: readonly Effort[],
	onSelect: (level: Effort) => void,
	onCancel: () => void,
	options?: { width?: SizeValue },
): OverlayDisposer {
	return mountOverlay(tui, () => (
		<ThinkingSelector
			currentLevel={currentLevel}
			availableLevels={availableLevels}
			onSelect={onSelect}
			onCancel={onCancel}
			width={options?.width}
		/>
	));
}
