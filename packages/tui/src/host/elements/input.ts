import { BracketedPasteHandler, decodeReencodedPasteControls } from "../../bracketed-paste";
import { getKeybindings } from "../../keybindings";
import { extractPrintableText } from "../../keys";
import { KillRing } from "../../kill-ring";
import { spaces, takeCells } from "../../core/out";
import { RichText } from "../../core/richtext";
import { Attr, Style } from "../../core/style";
import {
	getSegmenter,
	getWordNavKind,
	moveWordLeft,
	moveWordRight,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
} from "../../utils";
import { cursorColumnWindow } from "../../components/scroll-viewport";
import { subscribeFocus } from "../focus";
import { forgetPaintSpan, type CommonInputProps, type HostKeyEvent } from "../input";
import { registerElement } from "../registry";
import { Damage, type ElementImpl, type HostContext, type HostElement } from "../types";

const segmenter = getSegmenter();

/** Props for a retained single-line input. */
export interface InputElementProps extends CommonInputProps {
	readonly value?: string;
	readonly defaultValue?: string;
	readonly prompt?: string;
	readonly promptStyle?: Style;
	/** Suggested text displayed after the caret while the input remains empty. */
	readonly placeholder?: string;
	readonly placeholderStyle?: Style;
	readonly mask?: boolean;
	readonly useTerminalCursor?: boolean;
	readonly onChange?: (value: string) => void;
	readonly onSubmit?: (value: string) => void;
	readonly onEscape?: () => void;
}

interface InputSnapshot {
	readonly value: string;
	readonly cursor: number;
}

interface InputElementState {
	value: string;
	cursor: number;
	focused: boolean;
	lastAction: "kill" | "yank" | "type-word" | null;
	readonly undo: InputSnapshot[];
	readonly paste: BracketedPasteHandler;
	readonly killRing: KillRing;
	readonly line: RichText;
	readonly context: HostContext;
	unsubscribeFocus: () => void;
}

interface InputElementImpl extends ElementImpl {
	handleKey(node: HostElement, event: HostKeyEvent): void;
}

function propsOf(node: HostElement): InputElementProps {
	return node.props as InputElementProps;
}

function firstGrapheme(text: string): string {
	const next = segmenter.segment(text)[Symbol.iterator]().next();
	return next.done ? "" : next.value.segment;
}

function stateOf(node: HostElement): InputElementState {
	return node.state as InputElementState;
}

function pushUndo(state: InputElementState): void {
	state.undo.push({ value: state.value, cursor: state.cursor });
}

function insertText(state: InputElementState, text: string): void {
	const word = [...segmenter.segment(text)].every(part => getWordNavKind(part.segment) !== "whitespace");
	if (!word || state.lastAction !== "type-word") pushUndo(state);
	state.lastAction = "type-word";
	state.value = state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor);
	state.cursor += text.length;
}

function pasteText(state: InputElementState, text: string): void {
	state.lastAction = null;
	pushUndo(state);
	const clean = replaceTabs(
		decodeReencodedPasteControls(text).replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, ""),
	)
		.normalize("NFC")
		.replace(/[\x00-\x1f\x7f]/g, "");
	state.value = state.value.slice(0, state.cursor) + clean + state.value.slice(state.cursor);
	state.cursor += clean.length;
}

function deleteBackward(state: InputElementState): boolean {
	if (state.cursor <= 0) return false;
	pushUndo(state);
	const before = state.value.slice(0, state.cursor);
	const parts = [...segmenter.segment(before)];
	const length = parts[parts.length - 1]?.segment.length ?? 1;
	state.value = state.value.slice(0, state.cursor - length) + state.value.slice(state.cursor);
	state.cursor -= length;
	state.lastAction = null;
	return true;
}

function deleteForward(state: InputElementState): boolean {
	if (state.cursor >= state.value.length) return false;
	pushUndo(state);
	const length = firstGrapheme(state.value.slice(state.cursor)).length || 1;
	state.value = state.value.slice(0, state.cursor) + state.value.slice(state.cursor + length);
	state.lastAction = null;
	return true;
}

function deleteToStart(state: InputElementState): boolean {
	if (state.cursor === 0) return false;
	pushUndo(state);
	state.killRing.push(state.value.slice(0, state.cursor), {
		prepend: true,
		accumulate: state.lastAction === "kill",
	});
	state.value = state.value.slice(state.cursor);
	state.cursor = 0;
	state.lastAction = "kill";
	return true;
}

function deleteToEnd(state: InputElementState): boolean {
	if (state.cursor >= state.value.length) return false;
	pushUndo(state);
	state.killRing.push(state.value.slice(state.cursor), {
		prepend: false,
		accumulate: state.lastAction === "kill",
	});
	state.value = state.value.slice(0, state.cursor);
	state.lastAction = "kill";
	return true;
}

function deleteWordBackward(state: InputElementState): boolean {
	if (state.cursor === 0) return false;
	const accumulate = state.lastAction === "kill";
	pushUndo(state);
	const from = moveWordLeft(state.value, state.cursor);
	state.killRing.push(state.value.slice(from, state.cursor), { prepend: true, accumulate });
	state.value = state.value.slice(0, from) + state.value.slice(state.cursor);
	state.cursor = from;
	state.lastAction = "kill";
	return true;
}

function deleteWordForward(state: InputElementState): boolean {
	if (state.cursor >= state.value.length) return false;
	const accumulate = state.lastAction === "kill";
	pushUndo(state);
	const to = moveWordRight(state.value, state.cursor);
	state.killRing.push(state.value.slice(state.cursor, to), { prepend: false, accumulate });
	state.value = state.value.slice(0, state.cursor) + state.value.slice(to);
	state.lastAction = "kill";
	return true;
}

function yank(state: InputElementState): boolean {
	const text = state.killRing.peek();
	if (!text) return false;
	pushUndo(state);
	state.value = state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor);
	state.cursor += text.length;
	state.lastAction = "yank";
	return true;
}

function yankPop(state: InputElementState): boolean {
	if (state.lastAction !== "yank" || state.killRing.length <= 1) return false;
	pushUndo(state);
	const previous = state.killRing.peek() ?? "";
	state.value = state.value.slice(0, state.cursor - previous.length) + state.value.slice(state.cursor);
	state.cursor -= previous.length;
	state.killRing.rotate();
	const text = state.killRing.peek() ?? "";
	state.value = state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor);
	state.cursor += text.length;
	return true;
}

function undo(state: InputElementState): boolean {
	const snapshot = state.undo.pop();
	if (!snapshot) return false;
	state.value = snapshot.value;
	state.cursor = snapshot.cursor;
	state.lastAction = null;
	return true;
}

function handleInput(node: HostElement, state: InputElementState, data: string): boolean {
	const paste = state.paste.process(data);
	if (paste.handled) {
		if (paste.pasteContent !== undefined) pasteText(state, paste.pasteContent);
		if (paste.remaining.length > 0) handleInput(node, state, paste.remaining);
		return true;
	}

	const props = propsOf(node);
	const keys = getKeybindings();
	if (keys.matches(data, "tui.select.cancel")) {
		if (!props.onEscape) return false;
		props.onEscape();
		return true;
	}
	if (keys.matches(data, "tui.editor.undo")) {
		undo(state);
		return true;
	}
	if (keys.matches(data, "tui.input.submit") || data === "\n") {
		if (!props.onSubmit) return false;
		props.onSubmit(state.value);
		return true;
	}
	if (keys.matches(data, "tui.editor.deleteCharBackward")) {
		deleteBackward(state);
		return true;
	}
	if (keys.matches(data, "tui.editor.deleteCharForward")) {
		deleteForward(state);
		return true;
	}
	if (keys.matches(data, "tui.editor.deleteWordBackward")) {
		deleteWordBackward(state);
		return true;
	}
	if (keys.matches(data, "tui.editor.deleteWordForward")) {
		deleteWordForward(state);
		return true;
	}
	if (keys.matches(data, "tui.editor.deleteToLineStart")) {
		deleteToStart(state);
		return true;
	}
	if (keys.matches(data, "tui.editor.deleteToLineEnd")) {
		deleteToEnd(state);
		return true;
	}
	if (keys.matches(data, "tui.editor.yank")) {
		yank(state);
		return true;
	}
	if (keys.matches(data, "tui.editor.yankPop")) {
		yankPop(state);
		return true;
	}
	if (keys.matches(data, "tui.editor.cursorLeft")) {
		const parts = [...segmenter.segment(state.value.slice(0, state.cursor))];
		state.cursor -= parts[parts.length - 1]?.segment.length ?? 0;
		state.lastAction = null;
		return true;
	}
	if (keys.matches(data, "tui.editor.cursorRight")) {
		state.cursor += firstGrapheme(state.value.slice(state.cursor)).length;
		state.lastAction = null;
		return true;
	}
	if (keys.matches(data, "tui.editor.cursorLineStart")) {
		state.cursor = 0;
		state.lastAction = null;
		return true;
	}
	if (keys.matches(data, "tui.editor.cursorLineEnd")) {
		state.cursor = state.value.length;
		state.lastAction = null;
		return true;
	}
	if (keys.matches(data, "tui.editor.cursorWordLeft")) {
		state.cursor = moveWordLeft(state.value, state.cursor);
		state.lastAction = null;
		return true;
	}
	if (keys.matches(data, "tui.editor.cursorWordRight")) {
		state.cursor = moveWordRight(state.value, state.cursor);
		state.lastAction = null;
		return true;
	}
	const printable = extractPrintableText(data);
	if (!printable) return false;
	insertText(state, printable);
	return true;
}

function syncControlledValue(node: HostElement, state: InputElementState): void {
	const value = propsOf(node).value;
	if (value === undefined || value === state.value) return;
	state.value = value;
	state.cursor = value.length;
	state.undo.length = 0;
	state.lastAction = null;
}

function paintInput(node: HostElement, state: InputElementState, width: number, style: Style): void {
	const props = propsOf(node);
	const prompt = props.prompt ?? "> ";
	const available = width - visibleWidth(prompt);
	const line = state.line;
	line.clear();
	if (available <= 0) {
		line.push(style, takeCells(prompt, width));
		line.br();
		return;
	}

	if (state.value.length === 0 && props.placeholder) {
		line.push(style, prompt);
		if (state.focused) line.cursor();
		line.push(state.focused && props.useTerminalCursor === false ? style.plus(Attr.Inverse) : style, " ");
		line.push(
			props.placeholderStyle ?? style.plus(Attr.Dim),
			truncateToWidth(props.placeholder, Math.max(0, available - 1)),
		);
		if (line.openWidth < width) line.push(style, spaces(width - line.openWidth));
		line.br();
		return;
	}

	let visibleValue = state.value;
	let cursor = state.cursor;
	if (props.mask) {
		const parts = [...segmenter.segment(state.value)];
		visibleValue = "•".repeat(parts.length);
		cursor = parts.filter(part => part.index < state.cursor).length;
	}
	const display = cursor >= visibleValue.length ? `${visibleValue} ` : visibleValue;
	const window = cursorColumnWindow(display, cursor, available);
	const cursorPart = firstGrapheme(window.text.slice(window.cursorIndex)) || " ";
	const before = window.text.slice(0, window.cursorIndex);
	const after = window.text.slice(window.cursorIndex + cursorPart.length);
	const afterWidth = Math.max(0, available - visibleWidth(before) - visibleWidth(cursorPart));
	line.push(style, prompt);
	line.push(style, before);
	if (state.focused) line.cursor();
	line.push(state.focused && props.useTerminalCursor === false ? style.plus(Attr.Inverse) : style, cursorPart);
	line.push(style, takeCells(after, afterWidth));
	if (line.openWidth < width) line.push(style, spaces(width - line.openWidth));
	line.br();
}

/** Retained single-line input element implementation. */
export const inputElement: InputElementImpl = {
	tag: "input",
	propDamage(name) {
		if (
			name === "promptStyle" ||
			name === "placeholder" ||
			name === "placeholderStyle" ||
			name === "mask" ||
			name === "value" ||
			name === "useTerminalCursor"
		) {
			return Damage.Text;
		}
		if (name === "onKey" || name === "onMouse" || name === "onChange" || name === "onSubmit" || name === "onEscape") {
			return Damage.Interaction;
		}
		return Damage.Layout;
	},
	onAttach(node, context) {
		const initial = propsOf(node).value ?? propsOf(node).defaultValue ?? "";
		const state: InputElementState = {
			value: initial,
			cursor: initial.length,
			focused: false,
			lastAction: null,
			undo: [],
			paste: new BracketedPasteHandler(),
			killRing: new KillRing(),
			line: new RichText(),
			context,
			unsubscribeFocus: () => {},
		};
		node.state = state;
		state.unsubscribeFocus = subscribeFocus(node, focused => {
			state.focused = focused;
			state.context.invalidate(node, Damage.Interaction | Damage.Paint);
		});
	},
	onDetach(node) {
		const state = node.state as InputElementState | undefined;
		state?.unsubscribeFocus();
		forgetPaintSpan(node);
		node.state = undefined;
	},
	pasteText(node, text) {
		const state = stateOf(node);
		syncControlledValue(node, state);
		pasteText(state, text);
		propsOf(node).onChange?.(state.value);
		state.context.invalidate(node, Damage.Text | Damage.Interaction);
	},
	handleKey(node, event) {
		const state = stateOf(node);
		syncControlledValue(node, state);
		const before = state.value;
		const handled = handleInput(node, state, event.data);
		if (state.value !== before) propsOf(node).onChange?.(state.value);
		if (handled) {
			event.preventDefault();
			state.context.invalidate(node, Damage.Text | Damage.Interaction);
		}
	},
	measure() {
		return 1;
	},
	paint(node, out, width, context) {
		const state = stateOf(node);
		syncControlledValue(node, state);
		const available = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		const style = propsOf(node).promptStyle ?? context.styleOf(node);
		paintInput(node, state, available, style);
		state.line.replay(out);
	},
};

registerElement(inputElement);
