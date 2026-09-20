import type { JSX } from "solid-js";
import { hsvToRgb } from "@oh-my-pi/pi-utils";
import type { Editor, EditorCursor, EditorTopBorder } from "../../components/editor";
import { rgb, Style } from "../../core/style";
import { RichText } from "../../core/richtext";
import { forgetPaintSpan, type CommonInputProps, type HostKeyEvent } from "../input";
import { focusElementIfUnfocused, subscribeFocus } from "../focus";
import { registerElement } from "../registry";
import { Damage, type ElementImpl, type HostContext, type HostElement } from "../types";
import { paintSelect } from "./select";

/** Props for the retained editor state machine. */
export interface EditorElementProps extends CommonInputProps {
	readonly editor: Editor;
	/** Retained composer status content measured within the editor's actual top border. */
	readonly topBorder?: JSX.Element;
	readonly cursor?: EditorCursor;
	/** Read-only sample text fitted after native width allocation. */
	readonly previewText?: string;
}

interface EditorElementState {
	editor: Editor;
	context: HostContext;
	unsubscribeFocus: () => void;
	unsubscribeInvalidation: () => void;
	focused: boolean;
	cursorStartedAt?: number;
	unsubscribeCursor?: () => void;
}

interface EditorElementImpl extends ElementImpl {
	handleKey(node: HostElement, event: HostKeyEvent): void;
}

function propsOf(node: HostElement): EditorElementProps {
	return node.props as unknown as EditorElementProps;
}

function stateOf(node: HostElement): EditorElementState {
	return node.state as EditorElementState;
}

function syncEditor(node: HostElement): EditorElementState {
	const state = stateOf(node);
	const editor = propsOf(node).editor;
	if (state.editor !== editor) {
		state.unsubscribeInvalidation();
		state.editor.focused = false;
		state.editor = editor;
		state.editor.focused = state.focused;
		state.unsubscribeInvalidation = editor.subscribeInvalidation(() =>
			state.context.invalidate(node, Damage.Text | Damage.Interaction),
		);
	}
	return state;
}

/** Retained editor element implementation. */
export const editorElement: EditorElementImpl = {
	tag: "editor",
	slots: ["topBorder"],
	propDamage(name) {
		return name === "onKey" || name === "onMouse" ? Damage.Interaction : Damage.Layout;
	},
	onAttach(node, context) {
		const state: EditorElementState = {
			editor: propsOf(node).editor,
			context,
			unsubscribeFocus: () => {},
			unsubscribeInvalidation: () => {},
			focused: false,
		};
		node.state = state;
		state.unsubscribeFocus = subscribeFocus(node, focused => {
			state.focused = focused;
			state.editor.focused = focused;
			if (!focused) {
				state.unsubscribeCursor?.();
				state.unsubscribeCursor = undefined;
				state.cursorStartedAt = undefined;
			}
			state.context.invalidate(node, Damage.Interaction | Damage.Paint);
		});
		state.unsubscribeInvalidation = state.editor.subscribeInvalidation(() =>
			state.context.invalidate(node, Damage.Text | Damage.Interaction),
		);
		focusElementIfUnfocused(node);
	},
	onDetach(node) {
		const state = node.state as EditorElementState | undefined;
		if (state) {
			state.unsubscribeFocus();
			state.unsubscribeInvalidation();
			state.unsubscribeCursor?.();
			// Focus fallback may already have transferred the shared editor to its replacement view.
			if (state.focused) state.editor.focused = false;
		}
		forgetPaintSpan(node);
		node.state = undefined;
	},
	pasteText(node, text) {
		const state = syncEditor(node);
		state.editor.pasteText(text);
		state.context.invalidate(node, Damage.Text | Damage.Interaction);
	},
	handleKey(node, event) {
		const state = syncEditor(node);
		state.editor.handleInput(event.data);
		event.preventDefault();
		state.context.invalidate(node, Damage.Text | Damage.Interaction);
	},
	inputTarget(node) {
		return propsOf(node).editor;
	},
	paint(node, out, width, ctx) {
		const state = syncEditor(node);
		const available = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		const preview = propsOf(node).previewText;
		if (preview !== undefined) state.editor.setPreviewText(preview, available);
		const slots = node.slots.get("topBorder");
		let topBorder: EditorTopBorder | undefined;
		if (slots?.length) {
			const content = new RichText();
			const borderWidth = state.editor.getTopBorderAvailableWidth(available);
			for (const child of slots) ctx.paintChild(child, content, borderWidth);
			content.finish();
			topBorder = { content, width: content.rowWidth[0] ?? 0 };
		}
		let cursor = propsOf(node).cursor;
		if (cursor?.rainbow && state.focused) {
			state.cursorStartedAt ??= ctx.now;
			state.unsubscribeCursor ??= state.context.subscribeClock("frame", () =>
				state.context.invalidate(node, Damage.Paint),
			);
			const color = hsvToRgb({ h: ((ctx.now - state.cursorStartedAt) / 60) * 8, s: 0.9, v: 1 });
			cursor = { text: cursor.text, style: Style.of({ fg: rgb(color.r, color.g, color.b) }) };
		} else {
			state.unsubscribeCursor?.();
			state.unsubscribeCursor = undefined;
			state.cursorStartedAt = undefined;
		}
		state.editor.paint(out, available, topBorder, cursor);
		const menu = state.editor.autocompleteMenu();
		if (menu) {
			paintSelect(
				{ options: menu.items, selectedIndex: menu.selectedIndex, offset: menu.offset, maxRows: menu.maxVisible },
				out,
				available,
				ctx,
				ctx.styleOf(node),
			);
		}
	},
};

registerElement(editorElement);
