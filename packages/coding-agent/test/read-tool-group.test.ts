import { describe, expect, it } from "bun:test";
import { groupedReadUsageCallIds, readArgsCollapseIntoGroup } from "@oh-my-pi/pi-tui/chat/read-tool-group";

describe("readArgsCollapseIntoGroup", () => {
	it("groups filesystem, URL, and xd reads", () => {
		expect(readArgsCollapseIntoGroup({ path: "src/example.ts" })).toBe(true);
		expect(readArgsCollapseIntoGroup({ path: "https://example.test/docs" })).toBe(true);
		expect(readArgsCollapseIntoGroup({ path: "xd://generate_image" })).toBe(true);
	});

	it("does not group missing, scalar, array, or targetless arguments", () => {
		for (const args of [undefined, null, "src/example.ts", ["src/example.ts"], {}, { path: 42 }]) {
			expect(readArgsCollapseIntoGroup(args)).toBe(false);
		}
	});
});

describe("groupedReadUsageCallIds", () => {
	it("retains one ordered usage anchor for a read-only turn", () => {
		expect(
			groupedReadUsageCallIds({
				content: [
					{ type: "toolCall", id: "read-first", name: "read", arguments: { path: "src/one.ts" } },
					{ type: "toolCall", id: "read-second", name: "read", arguments: { path: "src/two.ts:1-8" } },
				],
			}),
		).toEqual(["read-first", "read-second"]);
	});

	it("keeps mixed-tool and visible-follow-up turns as standalone usage rows", () => {
		expect(
			groupedReadUsageCallIds({
				content: [
					{ type: "toolCall", id: "read", name: "read", arguments: { path: "src/one.ts" } },
					{ type: "toolCall", id: "bash", name: "bash", arguments: { command: "pwd" } },
				],
			}),
		).toBeUndefined();
		expect(
			groupedReadUsageCallIds({
				content: [
					{ type: "toolCall", id: "read", name: "read", arguments: { path: "src/one.ts" } },
					{ type: "text", text: "The file is ready." },
				],
			}),
		).toBeUndefined();
	});
});
