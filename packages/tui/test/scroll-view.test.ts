import { describe, expect, it } from "bun:test";
import {
	clampScrollOffset,
	scrollOffsetForRow,
	scrollbarThumbRange,
	viewportRange,
} from "../src/components/scroll-viewport";

describe("scroll viewport behavior", () => {
	it("clamps offsets and exposes exactly the visible rows", () => {
		expect(clampScrollOffset(99, 10, 3)).toBe(7);
		expect(viewportRange(10, 3, 7)).toEqual({ start: 7, end: 10 });
	});

	it("reveals a selection without moving an already-visible row", () => {
		expect(scrollOffsetForRow(4, 5, 20, 4, "nearest")).toBe(4);
		expect(scrollOffsetForRow(4, 12, 20, 4, "nearest")).toBe(9);
	});

	it("uses a bounded scrollbar thumb for overflowing content", () => {
		expect(scrollbarThumbRange(4, 20, 8)).toEqual({ start: 2, end: 3 });
	});
});
