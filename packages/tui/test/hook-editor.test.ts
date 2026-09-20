import { describe, expect, it } from "bun:test";
import { Editor, EditorView } from "../src/components/editor";
import { createHookEditorController, HookEditorView, openHookEditorOverlay } from "../src/overlays/hook-editor";
import { render } from "../src/root";
import { mountForTest } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";
import { TUI } from "../src/tui";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

function createTui(rows = 24): TUI {
	return new TUI(new VirtualTerminal(80, rows));
}

describe("hook editor", () => {
	it("retains the supplied draft", () => {
		const controller = createHookEditorController(
			createTui(),
			"draft",
			() => {},
			() => {},
		);
		expect(controller.value()).toBe("draft");
	});

	it("keeps the historical detail, editor, and hint spacing", () => {
		const controller = createHookEditorController(
			createTui(),
			"draft",
			() => {},
			() => {},
		);
		const root = mountForTest(
			() => HookEditorView({ title: "  Extension   response  \nExplain the change", controller }),
			{ width: 60 },
		);
		try {
			const rows = root.text();
			const detail = rows.findIndex(row => row.includes("Explain the change"));
			const draft = rows.findIndex(row => row.includes("draft"));
			const hint = rows.findIndex(row => row.includes("ctrl+q/ctrl+enter submit"));
			const blank = (row: string | undefined): string => (row ?? "").replace(/[│ ]/g, "");

			expect(rows[0]).toContain("Extension response");
			expect(rows[0]).not.toContain("Extension   response");
			expect(detail).toBeGreaterThan(0);
			expect(draft).toBeGreaterThan(detail);
			expect(hint).toBeGreaterThan(draft);
			expect(blank(rows[detail - 1])).toBe("");
			expect(blank(rows[detail + 1])).toBe("");
			expect(blank(rows[hint - 1])).toBe("");
			expect(blank(rows.at(-2))).toBe("");
			const footer = rows
				.slice(hint, -1)
				.map(row => row.replace(/[│]/g, "").trim())
				.join(" ");
			expect(footer).toContain("ctrl+g external editor");
		} finally {
			root.dispose();
		}
	});

	it("bounds multi-line prompt context with native scrolling", () => {
		const controller = createHookEditorController(
			createTui(),
			undefined,
			() => {},
			() => {},
		);
		const root = mountForTest(
			() =>
				HookEditorView({
					title: "Custom answer:\ncontext-one\ncontext-two\ncontext-three\ncontext-four",
					controller,
				}),
			{ width: 60 },
		);
		try {
			expect(root.text().filter(row => row.includes("context-"))).toHaveLength(3);
		} finally {
			root.dispose();
		}
	});

	it("does not submit a draft when a deferred paste has no text", () => {
		const submitted: string[] = [];
		const controller = createHookEditorController(
			createTui(),
			"draft",
			value => submitted.push(value),
			() => {},
			{ promptStyle: true },
		);
		const release = controller.beginPaste();

		controller.handleInput("\r");
		release(undefined);

		expect(submitted).toEqual([]);
		controller.handleInput("\r");
		expect(submitted).toEqual(["draft"]);
	});

	it("submits after an ordered deferred paste supplies text", () => {
		const submitted: string[] = [];
		const controller = createHookEditorController(
			createTui(),
			undefined,
			value => submitted.push(value),
			() => {},
			{ promptStyle: true },
		);
		const release = controller.beginPaste();

		controller.handleInput("\r");
		expect(submitted).toEqual([]);

		expect(release("clipboard response")).toBe(true);
		expect(submitted).toEqual(["clipboard response"]);
	});

	it("dismisses the mounted overlay before submitting or cancelling", () => {
		const tui = createTui();
		const submitted: string[] = [];
		let cancelled = 0;
		const submittedHandle = openHookEditorOverlay(tui, {
			title: "Submit",
			onSubmit: value => submitted.push(value),
			onCancel: () => {
				cancelled++;
			},
			options: { promptStyle: true },
		});
		expect(tui.hasOverlay()).toBe(true);

		submittedHandle.handleInput("answer");
		submittedHandle.handleInput("\r");

		expect(submitted).toEqual(["answer"]);
		expect(cancelled).toBe(0);
		expect(tui.hasOverlay()).toBe(false);

		const cancelledHandle = openHookEditorOverlay(tui, {
			title: "Cancel",
			onSubmit: value => submitted.push(value),
			onCancel: () => {
				cancelled++;
			},
		});
		cancelledHandle.cancel();

		expect(cancelled).toBe(1);
		expect(tui.hasOverlay()).toBe(false);
	});

	it("returns terminal input to the prior editor after submission", () => {
		const terminal = new VirtualTerminal(60, 16);
		const editor = new Editor(defaultEditorTheme);
		const root = render(() => EditorView({ editor }), {
			terminal,
			theme: loadThemeSync("dark"),
		});
		const submitted: string[] = [];
		const handle = openHookEditorOverlay(root.tui, {
			title: "Extension response",
			onSubmit: value => submitted.push(value),
			onCancel: () => {},
			options: { promptStyle: true },
		});
		try {
			terminal.sendInput("overlay answer");
			terminal.sendInput("\r");
			root.tui.renderNow();

			expect(submitted).toEqual(["overlay answer"]);
			expect(editor.getText()).toBe("");

			terminal.sendInput("main editor");
			root.tui.renderNow();
			expect(editor.getText()).toBe("main editor");
		} finally {
			handle.dispose();
			root.dispose();
		}
	});

	it("restores external-editor text after its asynchronous result", async () => {
		const tui = createTui();
		const replacement = Promise.withResolvers<string | null>();
		const controller = createHookEditorController(
			tui,
			"before",
			() => {},
			() => {},
			{ externalEditor: () => replacement.promise },
		);

		controller.handleInput("\x07");
		replacement.resolve("after");
		await replacement.promise;
		await Promise.resolve();

		expect(controller.value()).toBe("after");
		tui.stop();
	});
});
