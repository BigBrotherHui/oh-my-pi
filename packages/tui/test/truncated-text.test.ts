import { describe, expect, it } from "bun:test";
import { mountForTest, renderToRows } from "../src/testing";
import { stripVTControlCharacters } from "node:util";
import { TruncatedTextView } from "../src/components/truncated-text";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

describe("TruncatedText component", () => {
	it("applies horizontal padding around the content", () => {
		const lines = renderToRows(() => TruncatedTextView({ text: "Hello world", paddingX: 1 }), 50);

		// Should have exactly one content line (no vertical padding)
		expect(lines.length).toBe(1);

		expect(stripVTControlCharacters(lines[0]).trim()).toBe("Hello world");
	});

	it("pads output with vertical padding lines to width", () => {
		const lines = renderToRows(() => TruncatedTextView({ text: "Hello", paddingY: 2 }), 40);

		// Should have 2 padding lines + 1 content line + 2 padding lines = 5 total
		expect(lines.length).toBe(5);

		// Vertical padding lines are full width
		expect(visibleWidth(lines[0])).toBe(40);
		expect(visibleWidth(lines[1])).toBe(40);
		expect(visibleWidth(lines[3])).toBe(40);
		expect(visibleWidth(lines[4])).toBe(40);

		expect(stripVTControlCharacters(lines[2]).trim()).toBe("Hello");
	});

	it("truncates long text with ellipsis", () => {
		const longText = "This is a very long piece of text that will definitely exceed the available width";
		const lines = renderToRows(() => TruncatedTextView({ text: longText, paddingX: 1 }), 30);

		expect(lines.length).toBe(1);

		// availableWidth = 30 - 2*1 = 28, so truncated text is 28 chars
		// plus padding: 1 + 28 + 1 = 30
		expect(visibleWidth(lines[0])).toBe(30);

		// Should contain ellipsis
		const stripped = stripVTControlCharacters(lines[0]);
		expect(stripped.includes("…")).toBeTruthy();
	});

	it("handles text that fits without truncation", () => {
		// With paddingX=1, available width is 30-2=28
		// "Hello world" is 11 chars, fits comfortably
		const lines = renderToRows(() => TruncatedTextView({ text: "Hello world", paddingX: 1 }), 30);

		expect(lines.length).toBe(1);
		expect(stripVTControlCharacters(lines[0]).trim()).toBe("Hello world");

		// Should NOT contain ellipsis
		const stripped = stripVTControlCharacters(lines[0]);
		expect(!stripped.includes("…")).toBeTruthy();
	});

	it("handles empty text", () => {
		const lines = renderToRows(() => TruncatedTextView({ text: "", paddingX: 1 }), 30);

		expect(lines.length).toBe(1);
		expect(stripVTControlCharacters(lines[0]).trim()).toBe("");
	});

	it("stops at newline and only shows first line", () => {
		const multilineText = "First line\nSecond line\nThird line";
		const lines = renderToRows(() => TruncatedTextView({ text: multilineText, paddingX: 1 }), 40);

		expect(lines.length).toBe(1);
		// Should only contain "First line"
		const stripped = stripVTControlCharacters(lines[0]).trim();
		expect(stripped.includes("First line")).toBeTruthy();
		expect(!stripped.includes("Second line")).toBeTruthy();
		expect(!stripped.includes("Third line")).toBeTruthy();
	});

	it("truncates first line even with newlines in text", () => {
		const longMultilineText = "This is a very long first line that needs truncation\nSecond line";
		const lines = renderToRows(() => TruncatedTextView({ text: longMultilineText, paddingX: 1 }), 25);

		expect(lines.length).toBe(1);
		// availableWidth = 25 - 2 = 23, truncated to 23 + padding = 25
		expect(visibleWidth(lines[0])).toBe(25);
		// Should contain ellipsis and not second line
		const stripped = stripVTControlCharacters(lines[0]);
		expect(stripped.includes("…")).toBeTruthy();
		expect(!stripped.includes("Second line")).toBeTruthy();
	});

	it("renders reactive TruncatedTextView through mountForTest", () => {
		const root = mountForTest(() => TruncatedTextView({ text: "First line of text\nSecond line", paddingX: 1 }), {
			width: 30,
		});
		const rows = root.text(30);
		expect(rows.length).toBe(1);
		expect(rows[0].trim()).toBe("First line of text");
		root.dispose();
	});
});
