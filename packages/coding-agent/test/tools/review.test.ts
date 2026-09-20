import { describe, expect, it } from "bun:test";
import { parseFindingDetails } from "@oh-my-pi/pi-tui/tools/task";

describe("parseFindingDetails", () => {
	it("returns undefined without a title", () => {
		expect(parseFindingDetails({})).toBeUndefined();
		expect(parseFindingDetails({ title: "   " })).toBeUndefined();
	});

	it("parses normalized review finding fields", () => {
		expect(
			parseFindingDetails({
				title: " [P1] Example finding ",
				body: " Body ",
				priority: "P1",
				file: " /tmp/example.ts ",
				line: 10,
			}),
		).toEqual({
			title: "[P1] Example finding",
			body: "Body",
			priority: "P1",
			file: "/tmp/example.ts",
			line: 10,
		});
	});
});
