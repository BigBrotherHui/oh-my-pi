import { describe, expect, test } from "bun:test";
import { createDocument, createOutputDocument } from "../../src/document/document";
import { documentFromSnapshots } from "../../src/document/snapshots";
import type { DocumentChange, TextDocument } from "../../src/document/types";

function lines(document: TextDocument): string[] {
	const result = new Array<string>(document.lineCount());
	for (let index = 0; index < result.length; index++) result[index] = document.line(index);
	return result;
}

describe("text documents", () => {
	test("maintains CRLF and UTF-16 offsets across append, replace, and reset", () => {
		const document = createDocument("α\r\n😀x\n尾");
		expect(lines(document)).toEqual(["α", "😀x", "尾"]);
		expect([document.lineStart(0), document.lineStart(1), document.lineStart(2)]).toEqual([0, 3, 7]);

		document.apply({ kind: "append", text: "\r" });
		document.apply({ kind: "append", text: "\nZ" });
		expect(lines(document)).toEqual(["α", "😀x", "尾", "Z"]);
		expect(document.lineStart(3)).toBe(10);

		document.apply({ kind: "replace", start: 3, end: 7, text: "é\r\n🙂\n" });
		expect(document.text()).toBe("α\r\né\r\n🙂\n尾\r\nZ");
		expect(lines(document)).toEqual(["α", "é", "🙂", "尾", "Z"]);
		expect([
			document.lineStart(0),
			document.lineStart(1),
			document.lineStart(2),
			document.lineStart(3),
			document.lineStart(4),
		]).toEqual([0, 3, 6, 9, 12]);

		document.apply({ kind: "reset", text: "終\r\n" });
		expect(lines(document)).toEqual(["終", ""]);
		expect(document.lineStart(1)).toBe(3);
	});

	test("is partition-equivalent across CRLF and surrogate boundaries", () => {
		const expected = "one\r\n😀 two\nthree\r\nfour";
		const partitions = [
			[expected],
			["one\r", "\n😀 two\n", "three\r\n", "four"],
			["o", "ne\r\n\ud83d", "\ude00 two\nth", "ree\r", "\nfour"],
		];
		const projections = partitions.map(chunks => {
			const document = createDocument();
			for (const text of chunks) document.apply({ kind: "append", text });
			return {
				text: document.text(),
				lines: lines(document),
				starts: lines(document).map((_, index) => document.lineStart(index)),
			};
		});
		expect(projections[1]).toEqual(projections[0]);
		expect(projections[2]).toEqual(projections[0]);
	});

	test("snapshot growth emits one append and rewind emits one replace", () => {
		const adapter = documentFromSnapshots("abc");
		const changes: DocumentChange[] = [];
		adapter.doc.subscribe(change => changes.push(change));
		adapter.push("abcdef");
		expect(changes).toEqual([{ kind: "append", text: "def" }]);
		changes.length = 0;
		adapter.push("abXYef");
		expect(changes).toEqual([{ kind: "replace", start: 2, end: 4, text: "XY" }]);
		expect(adapter.doc.text()).toBe("abXYef");
	});

	test("output documents expose reactive capture and immutable notice snapshots", () => {
		const output = createOutputDocument("ready");
		const source = [{ kind: "info" as const, text: "ok" }];
		output.setCapture("complete");
		output.setNotices(source);
		source.push({ kind: "info", text: "later" });
		expect(output.capture()).toBe("complete");
		expect(output.notices()).toEqual([{ kind: "info", text: "ok" }]);
	});
});
