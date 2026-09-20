import { describe, expect, it } from "bun:test";
import type { Terminal as XtermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { ImageBudget, type ImagePaintState } from "../../src/components/image";
import { RichText } from "../../src/core/richtext";
import { Style } from "../../src/core/style";
import { editorElement, type EditorElementProps } from "../../src/host/elements/editor";
import { imageBudgetRegistrationCount, imageElement, type ImageElementProps } from "../../src/host/elements/image";
import { inputElement, type InputElementProps } from "../../src/host/elements/input";
import {
	terminalElement,
	type BorrowedTerminalSession,
	type TerminalElementProps,
} from "../../src/host/elements/terminal";
import { markDamage } from "../../src/host/damage";
import { disposeFocusRoot, focusElement, installFocusRuntime } from "../../src/host/focus";
import { dispatchKey, HostKeyEvent } from "../../src/host/input";
import {
	attachHostSubtree,
	createElementNode,
	createHostRoot,
	disposeHostRoot,
	type HostRoot,
} from "../../src/host/node";
import { createPaintContext, paintHostTree } from "../../src/host/paint";
import { Damage, type HostElement } from "../../src/host/types";
import { loadThemeSync } from "../../src/theme/loader";
import { defaultEditorTheme } from "../test-themes";

void editorElement;
void imageElement;
void inputElement;
void terminalElement;

function append(root: HostRoot, node: HostElement): void {
	root.node.children.push(node);
	node.parent = root.node;
	attachHostSubtree(node, root);
}

function rootForTest(): HostRoot {
	return createHostRoot({ theme: loadThemeSync("dark") });
}

function paint(root: HostRoot, width: number): RichText {
	const frame = new RichText();
	const context = createPaintContext(root, () => Style.NONE);
	paintHostTree(root, frame, width, context);
	frame.finish();
	return frame;
}

function emptyTerminal(): XtermTerminal {
	return {
		buffer: {
			active: {
				viewportY: 0,
				length: 0,
				getNullCell: () => ({}),
				getLine: () => undefined,
			},
		},
	} as unknown as XtermTerminal;
}

describe("terminal element lifecycle", () => {
	it("borrows the session and resizes the backend only when final dimensions change", () => {
		let attaches = 0;
		let detaches = 0;
		let disposals = 0;
		const resizeCalls: Array<readonly [number, number]> = [];
		const session: BorrowedTerminalSession = {
			terminal: emptyTerminal(),
			attach() {
				attaches++;
				return () => {
					detaches++;
				};
			},
			resize(columns, rows) {
				resizeCalls.push([columns, rows]);
			},
			dispose() {
				disposals++;
			},
		};
		const root = rootForTest();
		const node = createElementNode("terminal");
		node.props = { session, rows: 4 } satisfies TerminalElementProps;
		append(root, node);

		paint(root, 20);
		markDamage(node, Damage.Paint);
		paint(root, 20);
		markDamage(node, Damage.Layout);
		paint(root, 24);
		expect(resizeCalls).toEqual([
			[20, 4],
			[24, 4],
		]);
		expect(attaches).toBe(1);

		disposeHostRoot(root);
		expect(detaches).toBe(1);
		expect(disposals).toBe(0);
	});
});

describe("editor element", () => {
	it("routes keys into the retained editor state machine and mirrors focus", () => {
		const stopFocus = installFocusRuntime();
		const root = rootForTest();
		const editor = new Editor(defaultEditorTheme);
		const node = createElementNode("editor");
		node.props = { editor, tabIndex: 0 } satisfies EditorElementProps;
		append(root, node);
		focusElement(node);

		dispatchKey(root.node, new HostKeyEvent("q"));
		const frame = paint(root, 20);
		expect(editor.focused).toBe(true);
		expect(editor.getText()).toBe("q");
		expect(frame.text.join("")).toContain("q");

		disposeHostRoot(root);
		expect(editor.focused).toBe(false);
		disposeFocusRoot(root.node);
		stopFocus();
	});
});

describe("single-line input element", () => {
	it("edits through host key dispatch and paints its current prompt and value", () => {
		const stopFocus = installFocusRuntime();
		const root = rootForTest();
		const changes: string[] = [];
		const node = createElementNode("input");
		node.props = {
			tabIndex: 0,
			prompt: "$ ",
			onChange: value => changes.push(value),
		} satisfies InputElementProps;
		append(root, node);
		focusElement(node);

		dispatchKey(root.node, new HostKeyEvent("a"));
		const frame = paint(root, 12);
		expect(changes).toEqual(["a"]);
		expect(frame.text.join("")).toContain("$ a");

		disposeHostRoot(root);
		disposeFocusRoot(root.node);
		stopFocus();
	});
});

describe("image element lifecycle", () => {
	it("returns budget registrations to their baseline after unmount", () => {
		const budget = new ImageBudget(2);
		const baseline = imageBudgetRegistrationCount(budget);
		const state: ImagePaintState = {
			base64Data: "",
			mimeType: "image/png",
			dimensions: { widthPx: 1, heightPx: 1 },
			theme: { fallbackStyle: Style.NONE },
			options: { budget, imageKey: "surface-test" },
			budget,
			imageId: undefined,
			cache: new RichText(),
			hasCache: false,
			cachedSuppressed: false,
			cachedImageProtocol: null,
			cachedCellWidthPx: 0,
			cachedCellHeightPx: 0,
			cachedKittyUnicodePlaceholders: false,
			renderedGraphicRows: 0,
		};
		const root = rootForTest();
		const node = createElementNode("image");
		node.props = { state } satisfies ImageElementProps;
		append(root, node);
		expect(imageBudgetRegistrationCount(budget)).toBe(baseline + 1);

		disposeHostRoot(root);
		expect(imageBudgetRegistrationCount(budget)).toBe(baseline);
	});
});
