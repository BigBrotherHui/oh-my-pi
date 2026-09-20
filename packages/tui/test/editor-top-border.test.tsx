import { describe, expect, it } from "bun:test";
import { Editor, EditorView, type EditorTopBorder } from "../src/components/editor";
import { RichText } from "../src/core/richtext";
import { Style } from "../src/core/style";
import { batch, createSignal, Show } from "../src/reactive";
import { mountForTest } from "../src/testing";
import { defaultEditorTheme } from "./test-themes";

function cachedBorder(label: string): EditorTopBorder {
	const content = new RichText();
	content.push(Style.NONE, label);
	content.br();
	return { content, width: label.length };
}

describe("retained editor top border", () => {
	it("shows the latest streamed status without replacing the draft", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("draft");
		const [count, setCount] = createSignal(0);
		const root = mountForTest(() => <EditorView editor={editor} topBorder={<text>count {count()}</text>} />, {
			width: 80,
		});
		try {
			batch(() => {
				for (let index = 1; index <= 25; index++) setCount(index);
			});
			expect(root.text()[0]).toContain("count 25");
			setCount(50);
			expect(root.text()[0]).toContain("count 50");
			expect(editor.getText()).toBe("draft");
		} finally {
			root.dispose();
		}
	});

	it("prefers the live slot and restores cached startup chrome when it disappears", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setTopBorder(cachedBorder("startup"));
		const [live, setLive] = createSignal(true);
		const root = mountForTest(
			() => (
				<EditorView
					editor={editor}
					topBorder={
						<Show when={live()}>
							<text>current</text>
						</Show>
					}
				/>
			),
			{ width: 80 },
		);
		try {
			expect(root.text()[0]).toContain("current");
			expect(root.text()[0]).not.toContain("startup");
			setLive(false);
			expect(root.text()[0]).toContain("startup");
			expect(root.text()[0]).not.toContain("current");
		} finally {
			root.dispose();
		}
	});

	it("lays out a retained header inside the actual border after resizing", () => {
		const editor = new Editor(defaultEditorTheme);
		const root = mountForTest(
			() => (
				<EditorView
					editor={editor}
					topBorder={<sized paint={(width: number) => <text>{"x".repeat(width)}</text>} />}
				/>
			),
			{ width: 40 },
		);
		try {
			for (const width of [40, 62]) {
				const row = root.text(width)[0]!;
				expect(row.match(/x/g)?.length).toBe(editor.getTopBorderAvailableWidth(width));
				expect(Bun.stringWidth(row)).toBe(width);
			}
		} finally {
			root.dispose();
		}
	});
});
