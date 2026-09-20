import { describe, expect, it } from "bun:test";
import { renderNestedTaskResults } from "../src/tools/task";

describe("nested task result summary", () => {
	it("preserves agent identity and task text in recursive summaries", () => {
		const lines = renderNestedTaskResults([
			{
				projectAgentsDir: null,
				totalDurationMs: 1,
				results: [
					{
						index: 0,
						id: "Parent",
						agent: "task",
						agentSource: "bundled",
						task: "Parent work",
						exitCode: 0,
						output: "done",
						stderr: "",
						truncated: false,
						durationMs: 1,
						tokens: 0,
						requests: 0,
					},
				],
			},
		]);
		expect(lines.join("\n")).toContain("Parent");
		expect(lines.join("\n")).toContain("Parent work");
	});
});
