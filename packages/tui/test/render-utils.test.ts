import { describe, expect, it } from "bun:test";
import { disambiguateDisplayLabels, sanitizeCarriageReturns } from "../src/render/render-utils";
import { replaceTabs, truncateToWidth } from "../src/utils";

describe("render utilities", () => {
	it("normalizes malformed carriage returns without changing line endings", () => {
		expect(sanitizeCarriageReturns("first\r\rsecond\r\nthird")).toBe("first second\nthird");
	});

	it("disambiguates labels after sanitization and reserved action rows", () => {
		expect(disambiguateDisplayLabels(["Retry\rnow", "Retry now"], ["Other"])).toEqual(["Retry now", "Retry now (2)"]);
	});

	it("replaces tabs and truncates by terminal-cell width", () => {
		expect(replaceTabs("a\tb")).toBe("a   b");
		expect(truncateToWidth("abcdef", 4)).toBe("abc…");
	});
});
