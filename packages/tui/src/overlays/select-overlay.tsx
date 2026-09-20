import { popLoopPhase, pushLoopPhase } from "@oh-my-pi/pi-utils";
import { fuzzyFilter } from "../fuzzy";
import { scrollOffsetForRow } from "../components/scroll-viewport";
import { getKeybindings } from "../keybindings";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { extractPrintableText, matchesKey } from "../keys";
import { createEffect, createMemo, createSignal, type Accessor, type JSX } from "../reactive";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import type { SelectOption } from "../host/elements/select";

export type SelectSearchPolicy = "overflow" | "always" | "never";
export type SelectScrollPolicy = "nearest" | "center";

export interface SelectControllerOptions {
	readonly options: Accessor<readonly SelectOption[]>;
	readonly maxRows: Accessor<number>;
	readonly selectedIndex?: number;
	readonly selectedValue?: string;
	readonly wrapNavigation?: boolean;
	/** Selection viewport placement; `center` tracks the active row reactively. */
	readonly scrollPolicy?: SelectScrollPolicy;
	readonly search?: SelectSearchPolicy;
	readonly onSelect?: (value: string) => void;
	readonly onCancel?: () => void;
	readonly onChange?: (value: string) => void;
	/** Observes every key before the controller handles it. */
	readonly onInput?: (event: HostKeyEvent) => void;
	readonly confirmation?: (value: string) => string | undefined;
}

/** Shared state and interaction policy for a native select viewport. */
export interface SelectController {
	readonly options: Accessor<readonly SelectOption[]>;
	readonly query: Accessor<string>;
	readonly selectedIndex: Accessor<number>;
	readonly offset: Accessor<number>;
	readonly hoveredIndex: Accessor<number | undefined>;
	readonly pendingMessage: Accessor<string | undefined>;
	readonly maxRows: Accessor<number>;
	readonly searchEnabled: Accessor<boolean>;
	setQuery(query: string): void;
	selectIndex(index: number, direction?: -1 | 1): boolean;
	selectValue(value: string): boolean;
	setHoveredIndex(index: number | undefined): void;
	move(delta: number, wrap?: boolean): boolean;
	activate(): boolean;
	activateIndex(index: number): boolean;
	clearConfirmation(): boolean;
	cancel(): boolean;
	handleKey(event: HostKeyEvent): boolean;
	/** `row` is 0-based within the visible select rows; callers own frame offsets. */
	handleMouse(event: HostMouseEvent, row: number, selectable?: boolean): boolean;
}

/** Create the one shared selection state machine for simple and composed selectors. */
export function createSelectController(config: SelectControllerOptions): SelectController {
	const maxRows = createMemo(() => {
		const rows = config.maxRows();
		return Number.isFinite(rows) ? Math.max(1, Math.trunc(rows)) : 1;
	});
	const policy = config.search ?? "overflow";
	const scrollPolicy = config.scrollPolicy ?? "nearest";
	const enabledIndex = (options: readonly SelectOption[], index: number, direction: -1 | 1): number => {
		if (options.length === 0) return -1;
		const clamped = Math.max(0, Math.min(index, options.length - 1));
		if (!options[clamped]?.disabled) return clamped;
		for (let candidate = clamped + direction; candidate >= 0 && candidate < options.length; candidate += direction) {
			if (!options[candidate]?.disabled) return candidate;
		}
		for (let candidate = clamped - direction; candidate >= 0 && candidate < options.length; candidate -= direction) {
			if (!options[candidate]?.disabled) return candidate;
		}
		return -1;
	};
	const optionsForQuery = (query: string): readonly SelectOption[] => {
		const options = config.options();
		if (query.trim().length === 0) return options;
		pushLoopPhase("ui.select-filter");
		try {
			return fuzzyFilter([...options], query, option =>
				[option.label, option.value, option.description, option.hint].filter(Boolean).join(" "),
			);
		} finally {
			popLoopPhase();
		}
	};
	const initialOptions = config.options();
	const requestedIndex =
		config.selectedValue === undefined
			? (config.selectedIndex ?? 0)
			: initialOptions.findIndex(option => option.value === config.selectedValue);
	const initialIndex = enabledIndex(initialOptions, requestedIndex, 1);
	const [query, setQuerySignal] = createSignal("");
	const [selectedValue, setSelectedValue] = createSignal(initialOptions[initialIndex]?.value);
	const [offset, setOffset] = createSignal(
		initialIndex < 0 ? 0 : scrollOffsetForRow(0, initialIndex, initialOptions.length, maxRows(), scrollPolicy),
	);
	const [hoveredIndex, setHoveredIndex] = createSignal<number>();
	const [pendingValue, setPendingValue] = createSignal<string>();
	const options = createMemo(() => optionsForQuery(query()));
	const selectedIndex = createMemo(() => options().findIndex(option => option.value === selectedValue()));
	const searchEnabled = createMemo(
		() => policy === "always" || (policy === "overflow" && config.options().length > maxRows()),
	);
	const pendingMessage = createMemo(() => {
		const value = pendingValue();
		return value === undefined ? undefined : config.confirmation?.(value);
	});
	createEffect(() => {
		const visible = options();
		const index = selectedIndex();
		const selected = index < 0 ? undefined : visible[index];
		if (!selected || selected.disabled) {
			const fallback = enabledIndex(visible, 0, 1);
			if (fallback < 0) {
				if (offset() !== 0) setOffset(0);
				setHoveredIndex(undefined);
				return;
			}
			const value = visible[fallback]!.value;
			if (value !== selectedValue()) {
				setSelectedValue(value);
				setPendingValue(undefined);
				config.onChange?.(value);
			}
			setHoveredIndex(undefined);
			return;
		}
		const hovered = hoveredIndex();
		if (hovered !== undefined && (visible[hovered] === undefined || visible[hovered]?.disabled)) {
			setHoveredIndex(undefined);
		}
		const next = scrollOffsetForRow(offset(), index, visible.length, maxRows(), scrollPolicy);
		if (next !== offset()) setOffset(next);
	});
	const scrollSelectionIntoView = (index: number, count: number): void => {
		const next = scrollOffsetForRow(offset(), index, count, maxRows(), scrollPolicy);
		if (next !== offset()) setOffset(next);
	};
	const selectIndex = (index: number, direction: -1 | 1 = 1): boolean => {
		const visible = options();
		const next = enabledIndex(visible, index, direction);
		if (next < 0) return false;
		const value = visible[next]!.value;
		scrollSelectionIntoView(next, visible.length);
		if (value === selectedValue()) return false;
		setSelectedValue(value);
		setPendingValue(undefined);
		config.onChange?.(value);
		return true;
	};
	const move = (delta: number, wrap = config.wrapNavigation !== false): boolean => {
		const visible = options();
		const current = selectedIndex();
		if (current < 0 || visible.length === 0 || delta === 0) return false;
		const direction: -1 | 1 = delta < 0 ? -1 : 1;
		let candidate = current;
		let remaining = Math.max(1, Math.abs(Math.trunc(delta)));
		for (let attempts = 0; attempts < visible.length && remaining > 0; attempts++) {
			candidate += direction;
			if (candidate < 0 || candidate >= visible.length) {
				if (!wrap) break;
				candidate = direction > 0 ? 0 : visible.length - 1;
			}
			if (candidate === current) break;
			if (!visible[candidate]?.disabled) remaining--;
		}
		return candidate !== current && selectIndex(candidate, direction);
	};
	const setQuery = (nextQuery: string): void => {
		const priorValue = selectedValue();
		const visible = optionsForQuery(nextQuery);
		const retained = visible.findIndex(option => option.value === priorValue && !option.disabled);
		const next = retained >= 0 ? retained : enabledIndex(visible, 0, 1);
		setQuerySignal(nextQuery);
		setPendingValue(undefined);
		setHoveredIndex(undefined);
		if (next < 0) {
			setOffset(0);
			return;
		}
		const value = visible[next]!.value;
		setSelectedValue(value);
		setOffset(0);
		scrollSelectionIntoView(next, visible.length);
		if (value !== priorValue) config.onChange?.(value);
	};
	const selectValue = (value: string): boolean => {
		const index = options().findIndex(option => option.value === value);
		return index >= 0 && selectIndex(index, 1);
	};
	const activate = (): boolean => {
		const option = options()[selectedIndex()];
		if (!option || option.disabled || config.onSelect === undefined) return false;
		const message = config.confirmation?.(option.value);
		if (message && pendingValue() !== option.value) {
			setPendingValue(option.value);
			return true;
		}
		setPendingValue(undefined);
		config.onSelect(option.value);
		return true;
	};
	const setHovered = (index: number | undefined): void => {
		const option = index === undefined ? undefined : options()[index];
		setHoveredIndex(option && !option.disabled ? index : undefined);
	};
	const activateIndex = (index: number): boolean => {
		const option = options()[index];
		if (!option || option.disabled) return false;
		selectIndex(index);
		return activate();
	};
	const clearConfirmation = (): boolean => {
		if (pendingValue() === undefined) return false;
		setPendingValue(undefined);
		return true;
	};
	const cancel = (): boolean => {
		if (clearConfirmation()) return true;
		if (config.onCancel === undefined) return false;
		config.onCancel();
		return true;
	};
	const consume = (event: HostKeyEvent | HostMouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
	};
	const handleKey = (event: HostKeyEvent): boolean => {
		config.onInput?.(event);
		if (matchesSelectCancel(event.data)) {
			if (!cancel()) return false;
			consume(event);
			return true;
		}
		if (searchEnabled()) {
			if (
				getKeybindings().matches(event.data, "tui.editor.deleteCharBackward") ||
				matchesKey(event.data, "backspace")
			) {
				const current = query();
				if (current.length > 0) setQuery([...current].slice(0, -1).join(""));
				consume(event);
				return true;
			}
			const text = extractPrintableText(event.data);
			if (text !== undefined && (query().length > 0 || text.trim().length > 0)) {
				setQuery(query() + text);
				consume(event);
				return true;
			}
		}
		let handled = true;
		if (matchesSelectUp(event.data)) move(-1);
		else if (matchesSelectDown(event.data)) move(1);
		else if (matchesSelectPageUp(event.data)) move(-maxRows(), false);
		else if (matchesSelectPageDown(event.data)) move(maxRows(), false);
		else if (matchesKey(event.data, "home")) selectIndex(0, 1);
		else if (matchesKey(event.data, "end")) selectIndex(options().length - 1, -1);
		else if (getKeybindings().matches(event.data, "tui.select.confirm") || event.data === "\n") activate();
		else handled = false;
		if (handled) consume(event);
		return handled;
	};
	const handleMouse = (event: HostMouseEvent, row: number, selectable = true): boolean => {
		if (event.action === "wheel" && event.wheel !== 0) {
			move(event.wheel, false);
			consume(event);
			return true;
		}
		const count = Math.min(maxRows(), options().length - offset());
		if (!selectable || row < 0 || row >= count) {
			if (event.action === "move") setHovered(undefined);
			return false;
		}
		const index = offset() + row;
		const option = options()[index];
		if (!option || option.disabled) {
			if (event.action === "move") setHovered(undefined);
			return false;
		}
		if (event.action === "move") {
			setHovered(index);
		} else if (event.action === "down" && event.button === 0) {
			activateIndex(index);
		} else {
			return false;
		}
		consume(event);
		return true;
	};
	return {
		options,
		query,
		selectedIndex,
		offset,
		hoveredIndex,
		pendingMessage,
		maxRows,
		searchEnabled,
		setQuery,
		selectIndex,
		selectValue,
		setHoveredIndex: setHovered,
		move,
		activate,
		activateIndex,
		clearConfirmation,
		cancel,
		handleKey,
		handleMouse,
	};
}

export interface SelectOverlayProps {
	readonly title: string;
	readonly options: readonly SelectOption[];
	readonly selectedIndex?: number;
	readonly maxRows?: number;
	readonly emptyText?: string;
	readonly onSelect: (value: string) => void;
	readonly onCancel: () => void;
	readonly onChange?: (value: string) => void;
	readonly confirmation?: (value: string) => string | undefined;
}

/** Framed native select surface for simple modal selectors. */
export function SelectOverlay(props: SelectOverlayProps): JSX.Element {
	const controller = createSelectController({
		options: () => props.options,
		maxRows: () => props.maxRows ?? Math.max(1, props.options.length),
		selectedIndex: props.selectedIndex,
		onSelect: props.onSelect,
		onCancel: props.onCancel,
		onChange: props.onChange,
		confirmation: props.confirmation,
	});
	return (
		<box
			onKey={controller.handleKey}
			onMouse={event => controller.handleMouse(event, event.localRow - 1)}
			tabIndex={0}
		>
			<frame title={props.title} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
				<select
					options={controller.options()}
					selectedIndex={controller.selectedIndex()}
					hoveredIndex={controller.hoveredIndex()}
					offset={controller.offset()}
					maxRows={controller.maxRows()}
					emptyText={controller.query().trim() ? "No matching items" : props.emptyText}
					trackColor="dim"
					thumbColor="accent"
				/>
				{controller.pendingMessage() ? (
					<text color="warning" wrap="word">
						{controller.pendingMessage()}
					</text>
				) : controller.searchEnabled() ? (
					<text color="dim">{controller.query() ? `Search: ${controller.query()}` : "Type to search"}</text>
				) : null}
			</frame>
		</box>
	);
}
