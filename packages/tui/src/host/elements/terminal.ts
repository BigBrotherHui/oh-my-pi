import { Ellipsis } from "@oh-my-pi/pi-natives";
import type { Terminal as XtermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { Clip } from "../../core/out";
import type { Style } from "../../core/style";
import { readTerminalRows, paintTerminalRows } from "../../tools/terminal-output";
import { forgetPaintSpan, type CommonInputProps } from "../input";
import { registerElement } from "../registry";
import { Damage, type ElementImpl, type HostContext, type HostElement } from "../types";

/** Borrowed PTY session displayed by a terminal host element. */
export interface BorrowedTerminalSession {
	readonly terminal: XtermTerminal;
	/** Subscribe to virtual-terminal frame changes and return a detach callback. */
	attach(onFrame: () => void): () => void;
	/** Resize the PTY backend and its virtual terminal. */
	resize(columns: number, rows: number): void;
	/** Session owners may expose disposal, but terminal elements never call it. */
	dispose?(): void;
}

/** Props for the retained terminal surface. */
export interface TerminalElementProps extends CommonInputProps {
	readonly session: BorrowedTerminalSession;
	readonly rows: number;
	readonly style?: Style;
}

interface TerminalElementState {
	session: BorrowedTerminalSession;
	rows: readonly string[];
	detach: () => void;
	context: HostContext;
	columns: number;
	height: number;
	detached: boolean;
}

function propsOf(node: HostElement): TerminalElementProps {
	return node.props as unknown as TerminalElementProps;
}

function normalizeDimension(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function readRows(state: TerminalElementState): void {
	const buffer = state.session.terminal.buffer.active;
	state.rows = readTerminalRows(state.session.terminal, buffer.viewportY, state.height);
}

function attachSession(
	node: HostElement,
	context: HostContext,
	session: BorrowedTerminalSession,
): TerminalElementState {
	const state: TerminalElementState = {
		session,
		rows: [],
		detach: () => {},
		context,
		columns: -1,
		height: normalizeDimension(propsOf(node).rows),
		detached: false,
	};
	state.detach = session.attach(() => {
		readRows(state);
		state.context.invalidate(node, Damage.Paint);
	});
	readRows(state);
	return state;
}

function stateOf(node: HostElement): TerminalElementState {
	return node.state as TerminalElementState;
}

/** Retained terminal element implementation. */
export const terminalElement: ElementImpl = {
	tag: "terminal",
	propDamage(name) {
		return name === "style" ? Damage.Paint : Damage.Layout;
	},
	onAttach(node, context) {
		node.state = attachSession(node, context, propsOf(node).session);
	},
	onDetach(node) {
		const state = node.state as TerminalElementState | undefined;
		if (state && !state.detached) {
			state.detach();
			state.detached = true;
		}
		forgetPaintSpan(node);
	},
	measure(node) {
		return normalizeDimension(propsOf(node).rows);
	},
	paint(node, out, width, context) {
		const props = propsOf(node);
		let state = stateOf(node);
		if (state.detached) {
			paintTerminalRows(
				new Clip(out, normalizeDimension(width), Ellipsis.Omit),
				state.rows,
				props.style ?? context.styleOf(node),
			);
			return;
		}
		if (state.session !== props.session) {
			state.detach();
			state = attachSession(node, state.context, props.session);
			node.state = state;
		}
		const columns = normalizeDimension(width);
		const height = normalizeDimension(props.rows);
		if (columns !== state.columns || height !== state.height) {
			state.columns = columns;
			state.height = height;
			try {
				state.session.resize(columns, height);
			} catch {
				// A borrowed session may finish between its final frame and paint.
			}
			readRows(state);
		}
		const style = props.style ?? context.styleOf(node);
		paintTerminalRows(new Clip(out, columns, Ellipsis.Omit), state.rows, style);
	},
};

registerElement(terminalElement);
