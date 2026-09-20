import { beforeAll, expect, test } from "bun:test";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { EditorView } from "@oh-my-pi/pi-tui/components/editor";
import { mountOverlay, Portal } from "@oh-my-pi/pi-tui/host/overlay";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { onCleanup, onMount, useViewport } from "@oh-my-pi/pi-tui/reactive";
import { render } from "@oh-my-pi/pi-tui/root";
import { getEditorTheme, initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme(false);
});

function customUi() {
	const terminal = new VirtualTerminal(60, 16);
	const editor = new CustomEditor(getEditorTheme());
	editor.setUseTerminalCursor(true);
	editor.setText("draft");
	const ctx = createInteractiveModeContext({ editor });
	ctx.editorContainer.append(() => EditorView({ editor }));
	const root = render(ctx.editorContainer.view, { terminal, theme });
	root.tui.setShowHardwareCursor(true);
	ctx.ui = root.tui;
	return { terminal, editor, root, controller: new ExtensionUiController(ctx) };
}

test("custom editor factories inherit root context and restore typing after completion", async () => {
	const ui = customUi();
	const operation = new AbortController();
	try {
		const result = ui.controller.showHookCustom<number>((_tui, _theme, _keys, done) => () => {
			const viewport = useViewport();
			onCleanup(() => operation.abort());
			return (
				<box
					tabIndex={0}
					onKey={event => {
						if (event.key === "enter") done(7);
					}}
				>
					<text>custom width {viewport().columns}</text>
				</box>
			);
		});
		await Bun.sleep(0);
		ui.root.tui.renderNow();
		expect(ui.terminal.getViewport().join("\n")).toContain("custom width 60");
		ui.terminal.sendInput("\r");
		expect(await result).toBe(7);
		expect(operation.signal.aborted).toBe(true);
		ui.terminal.sendInput(" restored");
		ui.root.tui.renderNow();
		expect(ui.editor.getText()).toBe("draft restored");
		expect(ui.terminal.getViewport().join("\n")).not.toContain("custom width");
	} finally {
		ui.root.dispose();
	}
});

test("a returned mounted overlay remains open until its completion callback", async () => {
	const ui = customUi();
	let complete: ((value: number) => void) | undefined;
	try {
		const result = ui.controller.showHookCustom<number>((tui, _theme, _keys, done) => {
			complete = done;
			return mountOverlay(tui, () => (
				<Portal to="overlay" width={30}>
					<text>mounted overlay</text>
				</Portal>
			));
		});
		await Bun.sleep(0);
		ui.root.tui.renderNow();
		expect(ui.terminal.getViewport().join("\n")).toContain("mounted overlay");
		expect(ui.root.tui.hasOverlay()).toBe(true);
		if (!complete) throw new Error("Missing completion callback");
		complete(8);
		expect(await result).toBe(8);
		expect(ui.root.tui.hasOverlay()).toBe(false);
		ui.terminal.sendInput(" restored");
		expect(ui.editor.getText()).toBe("draft restored");
	} finally {
		ui.root.dispose();
	}
});

test("synchronous completion during mount cannot leave an orphaned custom editor", async () => {
	const ui = customUi();
	try {
		const result = ui.controller.showHookCustom<number>((_tui, _theme, _keys, done) => () => {
			onMount(() => done(9));
			return <text>already complete</text>;
		});
		expect(await result).toBe(9);
		ui.terminal.sendInput(" restored");
		ui.root.tui.renderNow();
		expect(ui.editor.getText()).toBe("draft restored");
		expect(ui.terminal.getViewport().join("\n")).not.toContain("already complete");
	} finally {
		ui.root.dispose();
	}
});

test("an ask keeps the current draft editable before accepting an answer", async () => {
	const ui = customUi();
	let submittedDraft = "";
	let answered = false;
	ui.editor.onSubmit = text => {
		submittedDraft = text;
		ui.editor.setText("");
	};
	try {
		const result = ui.controller.showAskDialog([
			{ id: "choice", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		]);
		void result.then(() => {
			answered = true;
		});
		ui.root.tui.renderNow();
		expect(ui.terminal.getViewport().join("\n")).toContain("Finish or clear");
		expect(ui.terminal.isCursorVisible()).toBe(true);
		ui.terminal.sendInput(" more");
		expect(ui.editor.getText()).toBe("draft more");
		ui.terminal.sendInput("\r");
		await Bun.sleep(0);
		expect(submittedDraft).toBe("draft more");
		expect(answered).toBe(false);
		ui.root.tui.renderNow();
		expect(ui.terminal.getViewport().join("\n")).not.toContain("Finish or clear");
		ui.terminal.sendInput("\r");
		expect(await result).toMatchObject({ kind: "submit", results: [{ id: "choice", selectedOptions: ["Yes"] }] });
		ui.terminal.sendInput("restored");
		expect(ui.editor.getText()).toBe("restored");
	} finally {
		ui.root.dispose();
	}
});
