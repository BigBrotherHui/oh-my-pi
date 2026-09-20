import { afterEach, describe, expect, it } from "bun:test";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { FileMentionMessageView } from "../src/chat/file-mention-message";
import type { FileMentionMessage } from "../src/chat/messages";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { renderToRows } from "../src/testing";

function render(files: FileMentionMessage["files"], width = 120): string {
	return Bun.stripANSI(renderToRows(() => FileMentionMessageView({ files }), width).join("\n"));
}

afterEach(() => applyHyperlinkSetting("auto"));

describe("FileMentionMessageView", () => {
	it("preserves historical read states and suffixes", () => {
		const rendered = render([
			{ path: "src/read.ts", content: "one\ntwo", lineCount: 2 },
			{ path: "src/unknown.ts", content: "" },
			{ path: "assets/screenshot.png", content: "", image: { type: "image", data: "", mimeType: "image/png" } },
			{ path: "fixtures/large.json", content: "", skippedReason: "tooLarge", byteSize: 1_536 },
			{ path: "fixtures/blob.bin", content: "", skippedReason: "binary" },
		]);

		expect(rendered).toContain("└─  Read src/read.ts (2 lines)");
		expect(rendered).toContain("Read src/unknown.ts (unknown lines)");
		expect(rendered).toContain("Read assets/screenshot.png (image)");
		expect(rendered).toContain(`Read fixtures/large.json (skipped: ${formatBytes(1_536)})`);
		expect(rendered).toContain("Read fixtures/blob.bin (skipped: binary, unknown size)");
	});

	it("keeps file paths linked and middle-clipped under narrow bounds", () => {
		applyHyperlinkSetting("always");
		const files = [{ path: "src/a/very/deeply/nested/file-mention-message.tsx", content: "", lineCount: 42 }];
		const linked = renderToRows(() => FileMentionMessageView({ files }), 120).join("\n");
		const narrow = Bun.stripANSI(renderToRows(() => FileMentionMessageView({ files }), 30).join("\n"));

		expect(linked).toContain("\x1b]8;");
		expect(narrow).toContain("Read");
		expect(narrow).toContain("…");
	});
});
