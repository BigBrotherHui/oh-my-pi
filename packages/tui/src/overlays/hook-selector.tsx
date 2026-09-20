import { cellWidth } from "../core/richtext";
import { Attr, Style } from "../core/style";
import { createDocument } from "../document/document";
import { extractPrintableText, matchesKey } from "../keys";
import { matchesAppExternalEditor } from "../keybinding-matchers";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import { HostKeyEvent, type HostMouseEvent } from "../host/input";
import type { SelectOption } from "../host/elements/select";
import { createMemo, createSignal, For, onCleanup, type Accessor, type JSX, useTheme } from "../reactive";
import type { ThemeColor } from "../theme/schema";
import type { SizeValue, TUI } from "../tui";
import { createSelectController, type SelectController } from "./select-overlay";

export interface HookSelectorSliderSegment {
	label: string;
	detail?: string;
}

export interface HookSelectorSlider {
	caption?: string;
	segments: HookSelectorSliderSegment[];
	index: number;
	onChange?: (index: number) => void;
}

export interface HookSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
	onTimeoutStart?: () => void;
	onTimeoutReset?: () => void;
	initialIndex?: number;
	outline?: boolean;
	maxVisible?: number;
	onLeft?: () => void;
	onRight?: () => void;
	onExternalEditor?: () => void;
	helpText?: string;
	slider?: HookSelectorSlider;
	disabledIndices?: readonly number[];
	selectionMarker?: "radio" | "checkbox";
	checkedIndices?: readonly number[];
	markableCount?: number;
	width?: SizeValue;
}

export interface HookSelectorOption {
	label: string;
	description?: string;
}

export type HookSelectorOptionInput = string | HookSelectorOption;

function normalize(option: HookSelectorOptionInput): HookSelectorOption {
	return typeof option === "string"
		? { label: option }
		: option.description?.trim()
			? { label: option.label, description: option.description.trim() }
			: { label: option.label };
}

function validIndices(indices: readonly number[] | undefined, length: number): Set<number> {
	return new Set((indices ?? []).filter(index => Number.isInteger(index) && index >= 0 && index < length));
}

function optionIndex(option: SelectOption | undefined): number | undefined {
	if (option === undefined) return undefined;
	const index = Number.parseInt(option.value, 10);
	return Number.isInteger(index) && index >= 0 ? index : undefined;
}

function timeoutMilliseconds(timeout: number | undefined): number {
	return timeout !== undefined && Number.isFinite(timeout) && timeout > 0 ? timeout : 0;
}

function wrappedRows(text: string, width: number): number {
	const limit = Math.max(1, Math.trunc(width));
	let rows = 1;
	let used = 0;
	for (const word of text.trim().split(/\s+/)) {
		const wordWidth = cellWidth(word);
		if (used > 0 && used + 1 + wordWidth > limit) {
			rows += 1;
			used = wordWidth;
		} else {
			used += (used > 0 ? 1 : 0) + wordWidth;
		}
		while (used > limit) {
			rows += 1;
			used -= limit;
		}
	}
	return rows;
}

export interface HookSelectorController {
	readonly title: Accessor<string>;
	readonly selectedIndex: Accessor<number>;
	readonly query: Accessor<string>;
	readonly searchEnabled: Accessor<boolean>;
	readonly sliderIndex: Accessor<number>;
	/** Shared select state used by the specialized hook selector presentation. */
	readonly selection: SelectController;
	setListWidth(width: number): void;
	handleInput(data: string): void;
	handleMouse(event: HostMouseEvent, row: number, selectable?: boolean): boolean;
	select(): void;
	cancel(): void;
	dispose(): void;
}

export function createHookSelectorController(
	title: string,
	items: readonly HookSelectorOptionInput[],
	onSelect: (option: string) => void,
	onCancel: () => void,
	options: HookSelectorOptions = {},
): HookSelectorController {
	const entries = items.map(normalize);
	const disabled = validIndices(options.disabledIndices, entries.length);
	const selectOptions: readonly SelectOption[] = entries.map((entry, index) => ({
		value: String(index),
		label: entry.label,
		description: entry.description,
		disabled: disabled.has(index),
	}));
	const maxVisible = Math.max(3, options.maxVisible ?? 12);
	const optionRows = entries.reduce((rows, entry) => rows + (entry.description ? 2 : 1), 0);
	const [compact, setCompact] = createSignal(optionRows > maxVisible);
	const slider = options.slider?.segments.length ? options.slider : undefined;
	const [sliderIndex, setSliderIndex] = createSignal(
		Math.max(0, Math.min((slider?.segments.length ?? 1) - 1, slider?.index ?? 0)),
	);
	const timeoutMs = timeoutMilliseconds(options.timeout);
	const [remainingSeconds, setRemainingSeconds] = createSignal(timeoutMs > 0 ? Math.ceil(timeoutMs / 1000) : 0);
	const baseTitle = title.split(/\r?\n/, 1)[0] ?? "";
	const countdownTitle = createMemo(() => (timeoutMs > 0 ? `${baseTitle} (${remainingSeconds()}s)` : baseTitle));
	let disposed = false;
	let timedOut = false;
	let deadline = 0;
	let expiry: NodeJS.Timeout | undefined;
	let ticker: NodeJS.Timeout | undefined;

	const clearTimer = (): void => {
		if (expiry !== undefined) {
			clearTimeout(expiry);
			expiry = undefined;
		}
		if (ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
	};
	const selection = createSelectController({
		options: () => selectOptions,
		maxRows: () => maxVisible,
		selectedIndex: options.initialIndex,
		wrapNavigation: false,
		search: "overflow",
		onSelect: value => {
			if (disposed) return;
			const entry = entries[Number.parseInt(value, 10)];
			if (entry !== undefined) onSelect(entry.label);
		},
		onCancel: () => {
			if (!disposed) onCancel();
		},
	});
	const selectedIndex = createMemo(() => optionIndex(selection.options()[selection.selectedIndex()]) ?? 0);
	const searchEnabled = createMemo(() => selection.searchEnabled() || compact());
	const updateCompact = (width: number): void => {
		const rowWidth = Math.max(1, Math.trunc(width) - (options.outline ? 2 : 0));
		const labelIndent = options.outline ? "" : " ";
		const descriptionIndent = options.outline ? "    " : "     ";
		const rows = entries.reduce((total, entry) => {
			const labelRows = wrappedRows(`${labelIndent}  ${entry.label}`, rowWidth);
			const descriptionRows = entry.description
				? wrappedRows(`${descriptionIndent}${entry.description}`, rowWidth)
				: 0;
			return total + labelRows + descriptionRows;
		}, 0);
		setCompact(rows > maxVisible);
	};
	const updateRemaining = (): void => {
		setRemainingSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
	};
	const expire = (): void => {
		if (disposed || timedOut) return;
		timedOut = true;
		clearTimer();
		setRemainingSeconds(0);
		options.onTimeout?.();
		if (!selection.activate()) selection.cancel();
	};
	const armTimer = (): void => {
		clearTimer();
		deadline = Date.now() + timeoutMs;
		setRemainingSeconds(Math.ceil(timeoutMs / 1000));
		expiry = setTimeout(expire, timeoutMs);
		ticker = setInterval(updateRemaining, 1_000);
		ticker.unref?.();
	};
	const resetTimer = (): void => {
		if (disposed || timedOut || timeoutMs === 0) return;
		armTimer();
		options.onTimeoutReset?.();
	};
	const moveSlider = (delta: number): boolean => {
		if (slider === undefined) return false;
		const next = Math.max(0, Math.min(slider.segments.length - 1, sliderIndex() + delta));
		if (next === sliderIndex()) return true;
		setSliderIndex(next);
		slider.onChange?.(next);
		return true;
	};
	const quickSelect = (data: string): boolean => {
		if (selection.query().length > 0 || data.length !== 1 || data < "1" || data > "9") return false;
		const index = selection.options().findIndex(option => option.label.startsWith(`${data}. `));
		if (index < 0) return false;
		const option = selection.options()[index];
		if (option?.disabled) return true;
		selection.selectIndex(index);
		if (options.selectionMarker !== "checkbox") selection.activate();
		return true;
	};
	const handleSearchInput = (data: string): boolean => {
		if (!searchEnabled()) return false;
		if (matchesKey(data, "backspace")) {
			if (selection.query().length === 0) return false;
			selection.setQuery(Array.from(selection.query()).slice(0, -1).join(""));
			return true;
		}
		const text = extractPrintableText(data);
		if (text === undefined || (selection.query().length === 0 && text.trim().length === 0)) return false;
		selection.setQuery(selection.query() + text);
		return true;
	};

	if (timeoutMs > 0) {
		options.onTimeoutStart?.();
		armTimer();
	}

	return {
		title: countdownTitle,
		selectedIndex,
		query: selection.query,
		searchEnabled,
		sliderIndex,
		selection,
		setListWidth(width: number): void {
			updateCompact(width);
		},
		handleInput(data: string): void {
			if (disposed) return;
			resetTimer();
			if (quickSelect(data) || handleSearchInput(data)) return;
			if (matchesKey(data, "left") || (slider !== undefined && !searchEnabled() && matchesKey(data, "h"))) {
				if (!moveSlider(-1)) options.onLeft?.();
				return;
			}
			if (matchesKey(data, "right") || (slider !== undefined && !searchEnabled() && matchesKey(data, "l"))) {
				if (!moveSlider(1)) options.onRight?.();
				return;
			}
			const event = new HostKeyEvent(data);
			if (selection.handleKey(event)) return;
			if (options.onExternalEditor && matchesAppExternalEditor(data)) options.onExternalEditor();
		},
		handleMouse(event: HostMouseEvent, row: number, selectable = true): boolean {
			resetTimer();
			return selection.handleMouse(event, row, selectable);
		},
		select(): void {
			if (!disposed) selection.activate();
		},
		cancel(): void {
			if (!disposed) selection.cancel();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			clearTimer();
		},
	};
}

const SEGMENT_COLORS: readonly ThemeColor[] = [
	"accent",
	"success",
	"warning",
	"error",
	"mdCode",
	"mdLink",
	"syntaxString",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxNumber",
	"syntaxOperator",
	"syntaxVariable",
];

function HookSelectorSliderView(props: {
	readonly slider: HookSelectorSlider;
	readonly controller: HookSelectorController;
}): JSX.Element {
	const theme = useTheme();
	const palette = (): readonly ThemeColor[] => {
		const colors: ThemeColor[] = [];
		const seen = new Set<number>();
		for (const color of SEGMENT_COLORS) {
			const packed = theme.token(color);
			if (seen.has(packed)) continue;
			seen.add(packed);
			colors.push(color);
			if (colors.length >= props.slider.segments.length) break;
		}
		return colors.length > 0 ? colors : ["accent"];
	};
	const segmentColor = (index: number): ThemeColor => {
		const colors = palette();
		return colors[index % colors.length]!;
	};
	const activeStyle = (color: ThemeColor): Style =>
		Style.of({ fg: theme.token("text"), bg: theme.token(color), attrs: Attr.Bold });
	return (
		<stack>
			<text wrap="none" overflow="ellipsis">
				{props.slider.caption ? <span color="dim">{`${props.slider.caption}  `}</span> : null}
				<span color={props.controller.sliderIndex() > 0 ? "accent" : "dim"}>{"◂"}</span>
				{"  "}
				<For each={props.slider.segments}>
					{(segment, index) => {
						const position = index();
						const color = segmentColor(position);
						const active = (): boolean => props.controller.sliderIndex() === position;
						const joinsActive = (): boolean => active() || props.controller.sliderIndex() === position - 1;
						return (
							<>
								{position > 0 ? (
									joinsActive() ? (
										"  "
									) : (
										<span color="statusLineSep">{` ${theme.symbol("sep.powerlineThin")} `}</span>
									)
								) : null}
								{active() ? (
									<>
										<span color={color}>{theme.symbol("sep.powerlineRight")}</span>
										<span style={activeStyle(color)}>{` ${segment.label} `}</span>
										<span color={color}>{theme.symbol("sep.powerlineLeft")}</span>
									</>
								) : (
									<span color={color}>{segment.label}</span>
								)}
							</>
						);
					}}
				</For>
				{"  "}
				<span color={props.controller.sliderIndex() < props.slider.segments.length - 1 ? "accent" : "dim"}>
					{"▸"}
				</span>
			</text>
			{props.slider.segments[props.controller.sliderIndex()]?.detail ? (
				<text color="muted" wrap="word">
					<span color="dim">{"  ↳ "}</span>
					{props.slider.segments[props.controller.sliderIndex()]?.detail}
				</text>
			) : null}
		</stack>
	);
}

interface HookSelectorOptionRowsProps {
	readonly option: SelectOption;
	readonly row: number;
	readonly selected: Accessor<boolean>;
	readonly showDescription: Accessor<boolean>;
	readonly outlined: boolean;
	readonly settings: HookSelectorOptions | undefined;
	readonly controller: HookSelectorController;
}

function HookSelectorOptionRows(props: HookSelectorOptionRowsProps): JSX.Element {
	const theme = useTheme();
	const labelDocument = createDocument(props.option.label);
	const descriptionDocument = props.option.description ? createDocument(props.option.description) : undefined;
	const originalIndex = optionIndex(props.option) ?? 0;
	const markableCount = Math.max(
		0,
		Math.min(props.settings?.markableCount ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
	);
	const marked = (): boolean => props.settings?.selectionMarker !== undefined && originalIndex < markableCount;
	const disabled = props.option.disabled === true;
	const background = (): "selectedBg" | undefined => (props.selected() && !disabled ? "selectedBg" : undefined);
	const labelColor = (): ThemeColor => (disabled ? "dim" : props.selected() ? "accent" : "text");
	const prefix = (): JSX.Element => {
		if (!marked()) {
			return (
				<span color={disabled ? "dim" : "accent"}>
					{props.selected() ? `${theme.symbol("nav.cursor")} ` : "  "}
				</span>
			);
		}
		if (props.settings?.selectionMarker === "radio") {
			return (
				<span
					color={disabled ? "dim" : props.selected() ? "accent" : "dim"}
				>{`${theme.symbol(props.selected() ? "radio.selected" : "radio.unselected")} `}</span>
			);
		}
		const checked = props.settings?.checkedIndices?.includes(originalIndex) === true;
		return (
			<span
				color={disabled ? "dim" : props.selected() ? "accent" : checked ? "success" : "dim"}
			>{`${theme.symbol(checked ? "checkbox.checked" : "checkbox.unchecked")} `}</span>
		);
	};
	const handleMouse = (event: HostMouseEvent): void => {
		props.controller.handleMouse(event, props.row);
	};
	const labelIndent = props.outlined ? "" : " ";
	const descriptionIndent = props.outlined ? "    " : "     ";
	return (
		<>
			<text background={background()} pad wrap="word" onMouse={handleMouse}>
				{labelIndent}
				{prefix()}
				<span color={labelColor()}>
					<markdown document={labelDocument} />
				</span>
			</text>
			{descriptionDocument && props.showDescription() ? (
				<text color={disabled ? "dim" : "muted"} background={background()} pad wrap="word" onMouse={handleMouse}>
					{descriptionIndent}
					<markdown document={descriptionDocument} />
				</text>
			) : null}
		</>
	);
}

interface HookSelectorListProps {
	readonly controller: HookSelectorController;
	readonly optionCount: number;
	readonly settings: HookSelectorOptions | undefined;
	readonly width: number;
}

function HookSelectorList(props: HookSelectorListProps): JSX.Element {
	props.controller.setListWidth(props.width);
	const outlined = props.settings?.outline === true;
	const options = (): readonly SelectOption[] => {
		const start = props.controller.selection.offset();
		return props.controller.selection.options().slice(start, start + props.controller.selection.maxRows());
	};
	const showStatus = (): boolean => {
		const total = props.controller.selection.options().length;
		const end = props.controller.selection.offset() + options().length;
		return (
			props.controller.searchEnabled() ||
			props.controller.query().length > 0 ||
			props.controller.selection.offset() > 0 ||
			end < total
		);
	};
	const status = (): string => {
		const total = props.controller.selection.options().length;
		const selected = total === 0 ? 0 : props.controller.selection.selectedIndex() + 1;
		const query = props.controller.query();
		const count =
			query.trim() && total !== props.optionCount
				? `${selected}/${total} of ${props.optionCount}`
				: `${selected}/${total}`;
		const suffix = query.trim() ? `  Search: ${query}` : "  Type to search";
		return `(${count})${suffix}`;
	};
	const rows = (
		<stack>
			<For each={options()}>
				{(option, index) => {
					const row = (): number => index();
					const selected = (): boolean =>
						props.controller.selection.selectedIndex() === props.controller.selection.offset() + row();
					const showDescription = (): boolean => !props.controller.searchEnabled() || selected();
					return (
						<HookSelectorOptionRows
							option={option}
							row={row()}
							selected={selected}
							showDescription={showDescription}
							outlined={outlined}
							settings={props.settings}
							controller={props.controller}
						/>
					);
				}}
			</For>
			{options().length === 0 ? (
				<text color="dim" wrap="word">
					{outlined ? "  No matching options" : "   No matching options"}
				</text>
			) : null}
			{showStatus() ? (
				<text color="dim" wrap="word">
					{outlined ? `  ${status()}` : `   ${status()}`}
				</text>
			) : null}
		</stack>
	);
	return outlined ? (
		<frame paddingX={0} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			{rows}
		</frame>
	) : (
		rows
	);
}

export interface HookSelectorViewProps {
	readonly title: string;
	readonly options: readonly HookSelectorOptionInput[];
	readonly controller: HookSelectorController;
	readonly settings?: HookSelectorOptions;
}

/** Specialized extension selector composed over the shared select state machine. */
export function HookSelectorView(props: HookSelectorViewProps): JSX.Element {
	const [, ...detailLines] = props.title.split(/\r?\n/);
	const handleKey = (event: HostKeyEvent): void => {
		props.controller.handleInput(event.data);
		event.preventDefault();
	};
	const handleMouse = (event: HostMouseEvent): void => {
		props.controller.handleMouse(event, -1, false);
	};
	return (
		<frame title={props.controller.title()} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<box tabIndex={0} onKey={handleKey} onMouse={handleMouse}>
				<stack>
					<br />
					<For each={detailLines}>
						{line => (
							<text color="accent" wrap="word">
								{line}
							</text>
						)}
					</For>
					<br />
					{props.settings?.slider?.segments.length ? (
						<>
							<HookSelectorSliderView slider={props.settings.slider} controller={props.controller} />
							<br />
						</>
					) : null}
					<sized
						paint={width => (
							<HookSelectorList
								controller={props.controller}
								optionCount={props.options.length}
								settings={props.settings}
								width={width}
							/>
						)}
					/>
					<br />
					<text color="dim" wrap="word">
						{props.settings?.helpText ?? "up/down navigate  enter select  esc cancel"}
					</text>
					<br />
				</stack>
			</box>
		</frame>
	);
}

export interface HookSelectorOverlayProps {
	readonly title: string;
	readonly options: readonly HookSelectorOptionInput[];
	readonly onSelect: (option: string) => void;
	readonly onCancel: () => void;
	readonly settings?: HookSelectorOptions;
}

export function HookSelectorOverlay(
	props: HookSelectorOverlayProps & { readonly controller: HookSelectorController },
): JSX.Element {
	onCleanup(() => props.controller.dispose());
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.settings?.width ?? "100%"} mouseTracking>
			<HookSelectorView
				title={props.title}
				options={props.options}
				controller={props.controller}
				settings={props.settings}
			/>
		</Portal>
	);
}

export interface HookSelectorHandle extends OverlayDisposer, HookSelectorController {}

export function openHookSelectorOverlay(tui: TUI, props: HookSelectorOverlayProps): HookSelectorHandle {
	const settings = { ...props.settings, tui };
	const controller = createHookSelectorController(
		props.title,
		props.options,
		props.onSelect,
		props.onCancel,
		settings,
	);
	const mounted = mountOverlay(tui, () => (
		<HookSelectorOverlay {...props} settings={settings} controller={controller} />
	));
	const dispose = (): void => {
		controller.dispose();
		mounted.dispose();
	};
	return Object.assign(dispose, controller, { hide: dispose, dispose });
}
