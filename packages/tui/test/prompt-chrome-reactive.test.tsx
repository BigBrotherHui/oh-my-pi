import { describe, expect, test } from "bun:test";
import { createTranscriptStore } from "../src/chat/transcript-store";
import { ImageBudget } from "../src/components/image";
import { AttachmentChipsView, createAttachmentChipsStore } from "../src/prompt/attachment-chips";
import { ComposerChromeView, createComposerChromeStore } from "../src/prompt/composer";
import { visibleWidth } from "../src/utils";
import { mountForTest } from "../src/testing";
import "../src/host/elements/box";
import "../src/host/elements/frame";
import "../src/host/elements/hr";
import "../src/host/elements/row";
import "../src/host/elements/stack";
import "../src/host/elements/text";
import "../src/host/elements/transcript";

describe("reactive prompt chrome", () => {
	test("replaces the composer editor slot without remounting the transcript", () => {
		const transcript = createTranscriptStore();
		transcript.append({ id: "message", state: "settled", view: () => <text>message</text> });
		const store = createComposerChromeStore({ transcript, editor: <text>first editor</text> });
		const root = mountForTest(() => <ComposerChromeView store={store} />);
		try {
			expect(root.text()).toEqual(expect.arrayContaining(["message", "first editor"]));
			store.setSlots({ editor: <text>second editor</text> });
			root.flush();
			expect(root.text()).toEqual(expect.arrayContaining(["message", "second editor"]));
		} finally {
			root.dispose();
		}
	});

	test("keeps attachment cards fixed, clips overflow, and follows the editor snapshot", () => {
		const store = createAttachmentChipsStore();
		const budget = new ImageBudget();
		const root = mountForTest(() => <AttachmentChipsView store={store} budget={budget} />);
		try {
			expect(root.text()).toEqual([]);
			store.setChips([
				{
					kind: "paste",
					n: 1,
					text: {
						n: 1,
						label: "[Paste #1]",
						content: "first line\nsecond line\nthird line\nfourth line\nfifth line",
						lineCount: 5,
						charCount: 56,
					},
				},
				{
					kind: "paste",
					n: 2,
					text: { n: 2, label: "[Paste #2]", content: "second attachment", lineCount: 1, charCount: 17 },
				},
			]);
			root.flush();
			const wide = root.text();
			expect(wide).toHaveLength(6);
			expect(wide.every(row => visibleWidth(row) === 30)).toBe(true);
			expect(wide).toEqual(
				expect.arrayContaining([expect.stringContaining("first line"), expect.stringContaining("+5 lines")]),
			);
			expect(wide[0]).toContain("#1");
			expect(wide[0]).toContain("#2");

			const narrow = root.text(29);
			expect(narrow).toHaveLength(6);
			expect(narrow.every(row => visibleWidth(row) === 14)).toBe(true);
			expect(narrow[0]).toContain("#1");
			expect(narrow[0]).not.toContain("#2");

			store.setChips([store.chips()[1]!]);
			root.flush();
			const afterRemoval = root.text();
			expect(afterRemoval[0]).toContain("#2");
			expect(afterRemoval[0]).not.toContain("#1");

			store.setChips([
				{
					kind: "image",
					n: 3,
					image: {
						type: "image",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9uAAAAABJRU5ErkJggg==",
						mimeType: "image/png",
					},
					link: "/tmp/attachment.png",
				},
			]);
			root.flush();
			const imageRows = root.rows();
			expect(imageRows).toHaveLength(6);
			expect(imageRows.every(row => visibleWidth(row) === 14)).toBe(true);
			expect(imageRows[0]).toContain("#3");
			expect(imageRows[5]).toContain("1x1");
		} finally {
			root.dispose();
		}
	});
});
