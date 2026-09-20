import { describe, expect, it } from "bun:test";
import { Editor, EditorView } from "../../src/components/editor";
import { mountOverlay, Portal, type OverlayDisposer } from "../../src/host/overlay";
import { CustomEditor } from "../../src/prompt/custom-editor";
import { createContext, createLayoutEffect, createSignal, Show, useContext } from "../../src/reactive";
import { render } from "../../src/root";
import { mountForTest } from "../../src/testing";
import { loadThemeSync } from "../../src/theme/loader";
import { defaultEditorTheme } from "../test-themes";
import { dispatchMouse, HostMouseEvent } from "../../src/host/input";
import { VirtualTerminal } from "../virtual-terminal";

describe("retained root input", () => {
	it("routes clicks through tree guides to the correct item and local column", () => {
		const clicks: string[] = [];
		const root = mountForTest(
			() => (
				<tree>
					<text onMouse={event => clicks.push(`first:${event.localCol}`)}>first</text>
					<text onMouse={event => clicks.push(`second:${event.localCol}`)}>second</text>
				</tree>
			),
			{ width: 20 },
		);
		try {
			root.flush();
			dispatchMouse(root.root, new HostMouseEvent({ row: 0, col: 4 }));
			dispatchMouse(root.root, new HostMouseEvent({ row: 1, col: 5 }));
			expect(clicks).toEqual(["first:1", "second:2"]);
		} finally {
			root.dispose();
		}
	});

	it("keeps conditional editor header slots live without replacing the editor", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("draft");
		const [visible, setVisible] = createSignal(true);
		const [label, setLabel] = createSignal("first");
		const Header = () => (
			<Show when={visible()}>
				<text>{label()}</text>
			</Show>
		);
		const root = mountForTest(() => <EditorView editor={editor} topBorder={<Header />} />, { width: 40 });
		try {
			expect(root.text().join("\n")).toContain("first");
			setLabel("second");
			expect(root.text().join("\n")).toContain("second");
			setVisible(false);
			expect(root.text().join("\n")).not.toContain("second");
			setVisible(true);
			expect(root.text().join("\n")).toContain("second");
			expect(editor.getText()).toBe("draft");
		} finally {
			root.dispose();
		}
	});

	it("constructs a root view once even when setup reads its own reactive state", () => {
		const terminal = new VirtualTerminal(40, 8);
		const Counter = () => {
			const [value, setValue] = createSignal(0);
			const initial = value();
			return (
				<box tabIndex={0} onKey={() => setValue(current => current + 1)}>
					<text>
						value {value()} initial {initial}
					</text>
				</box>
			);
		};
		const root = render(Counter, { terminal, theme: loadThemeSync("dark") });
		try {
			root.tui.renderNow();
			terminal.sendInput("x");
			root.tui.renderNow();
			expect(terminal.getViewport()[0]).toContain("value 1 initial 0");
		} finally {
			root.dispose();
		}
	});

	it("runs layout hooks after the current frame's native measurements", () => {
		const terminal = new VirtualTerminal(40, 8);
		let measuredRows = 0;
		const View = () => {
			const [rows, setRows] = createSignal(0);
			createLayoutEffect(() => setRows(measuredRows));
			return (
				<stack>
					<text>rows {rows()}</text>
					<scroll
						height={2}
						onViewport={next => {
							measuredRows = next.totalRows;
						}}
					>
						<text>
							one{"\n"}two{"\n"}three
						</text>
					</scroll>
				</stack>
			);
		};
		const root = render(View, { terminal, theme: loadThemeSync("dark") });
		try {
			root.tui.renderNow();
			expect(terminal.getViewport()[0]).toContain("rows 3");
		} finally {
			root.dispose();
		}
	});

	it("keeps layout-triggered updates dirty until their measured state is painted", () => {
		const [measured, setMeasured] = createSignal(0);
		const mounted = mountForTest(() => (
			<stack>
				<text>Measured: {measured()}</text>
				<scroll height={2} scrollbar="never" onViewport={viewport => setMeasured(viewport.totalRows)}>
					<text>first</text>
					<text>second</text>
					<text>third</text>
				</scroll>
			</stack>
		));
		try {
			expect(mounted.text()[0]).toBe("Measured: 3");
		} finally {
			mounted.dispose();
		}
	});

	it("preserves view context while deferred width-aware content mounts and resizes", () => {
		const label = createContext("missing provider");
		const terminal = new VirtualTerminal(30, 8);
		const Caption = () => <text>{useContext(label)}</text>;
		const root = render(
			() => (
				<label.Provider value="inherited context">
					<sized
						paint={width => (
							<stack>
								<Caption />
								<text>{width}</text>
							</stack>
						)}
					/>
				</label.Provider>
			),
			{ terminal, theme: loadThemeSync("dark") },
		);
		try {
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("inherited context");
			expect(terminal.getViewport().join("\n")).toContain("30");
			terminal.resize(40, 8);
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("inherited context");
			expect(terminal.getViewport().join("\n")).not.toContain("missing provider");
		} finally {
			root.dispose();
		}
	});

	it("keeps the cursor at the draft after remounting the same editor", () => {
		const terminal = new VirtualTerminal(60, 16);
		const editor = new Editor(defaultEditorTheme);
		editor.setUseTerminalCursor(true);
		editor.setText("draft");
		const [wrapped, setWrapped] = createSignal(false);
		const root = render(
			() => (
				<stack>
					{wrapped() ? (
						<box>
							<EditorView editor={editor} />
						</box>
					) : (
						<EditorView editor={editor} />
					)}
				</stack>
			),
			{ terminal, theme: loadThemeSync("dark") },
		);
		root.tui.setShowHardwareCursor(true);
		const expectDraftCursor = (): void => {
			root.tui.renderNow();
			const rows = terminal.getViewport();
			const row = rows.findIndex(line => line.includes("draft"));
			const prefix = rows[row]!.slice(0, rows[row]!.indexOf("draft"));
			expect(terminal.isCursorVisible()).toBe(true);
			expect(terminal.getCursor()).toEqual({ row, col: Bun.stringWidth(prefix) + "draft".length });
		};
		try {
			expectDraftCursor();
			setWrapped(true);
			expectDraftCursor();
			setWrapped(false);
			expectDraftCursor();
			expectDraftCursor();
		} finally {
			root.dispose();
		}
	});

	it("edits the draft, targets nested overlay input, then restores typing after Escape", () => {
		const terminal = new VirtualTerminal(60, 16);
		const editor = new CustomEditor(defaultEditorTheme);
		const [focusedAgent, setFocusedAgent] = createSignal("Worker");
		editor.onEscape = () => setFocusedAgent("Main");
		const root = render(
			() => (
				<stack>
					<text>{focusedAgent()}</text>
					<EditorView editor={editor} />
				</stack>
			),
			{
				terminal,
				theme: loadThemeSync("dark"),
			},
		);
		let overlay: OverlayDisposer | undefined;
		try {
			terminal.sendInput("draft");
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("draft");

			const [query, setQuery] = createSignal("");
			overlay = mountOverlay(root.tui, () => (
				<Portal to="overlay" anchor="center" width={40}>
					<box tabIndex={0}>
						<input prompt="Search: " value={query()} onChange={setQuery} onEscape={() => overlay?.dispose()} />
						<text>{`Results for ${query()}`}</text>
					</box>
				</Portal>
			));
			terminal.sendInput("model");
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("Results for model");
			expect(editor.getText()).toBe("draft");

			terminal.sendInput("\x1b");
			terminal.sendInput(" again");
			root.tui.renderNow();
			expect(root.tui.hasOverlay()).toBe(false);
			expect(editor.getText()).toBe("draft again");
			expect(terminal.getViewport().join("\n")).toContain("draft again");

			editor.setText("");
			terminal.sendInput("\x1b");
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("Main");
			expect(terminal.getViewport().join("\n")).not.toContain("Worker");
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});

	it("repaints externally restored drafts and transfers input after editor replacement", () => {
		const terminal = new VirtualTerminal(60, 16);
		const first = new Editor(defaultEditorTheme);
		const second = new Editor(defaultEditorTheme);
		const [editor, setEditor] = createSignal(first);
		const root = render(
			() => (
				<Show when={editor()} keyed>
					{(active: Editor) => <EditorView editor={active} />}
				</Show>
			),
			{
				terminal,
				theme: loadThemeSync("dark"),
			},
		);
		try {
			root.tui.renderNow();
			first.setText("restored draft");
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("restored draft");

			setEditor(second);
			terminal.sendInput("new draft");
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("new draft");
			first.setText("detached draft");
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).not.toContain("detached draft");
			expect(second.getText()).toBe("new draft");
		} finally {
			root.dispose();
		}
	});
});
