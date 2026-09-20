import { afterEach, describe, expect, it, vi } from "bun:test";
import { Editor, EditorView, type EditorCursor } from "../../src/components/editor";
import { createSignal } from "../../src/reactive";
import { mountForTest } from "../../src/testing";
import { defaultEditorTheme } from "../test-themes";

afterEach(() => vi.useRealTimers());

describe("retained cursor decoration", () => {
	it("animates a wide glyph without shifting the draft and releases its clock when cleared", () => {
		vi.useFakeTimers();
		const editor = new Editor(defaultEditorTheme);
		editor.setText("draft");
		const [cursor, setCursor] = createSignal<EditorCursor>({ text: "好", rainbow: true });
		const root = mountForTest(() => <EditorView editor={editor} cursor={cursor()} />, { width: 30 });
		try {
			const first = root.rows().join("\n");
			expect(root.text().join("\n")).toContain("draft好");
			vi.advanceTimersByTime(80);
			expect(root.rows().join("\n")).not.toBe(first);
			expect(editor.getText()).toBe("draft");
			setCursor({ text: "" });
			root.flush();
			expect(root.text().join("\n")).not.toContain("好");
			expect(root.counters().timers).toBe(0);
		} finally {
			root.dispose();
		}
	});
});
