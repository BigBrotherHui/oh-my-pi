import { describe, expect, it } from "bun:test";
import { BashExecutionView } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { mountForTest } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";

const theme = loadThemeSync("dark");

function render(output: string, expanded: boolean, width = 40): string {
	const root = mountForTest(
		() => BashExecutionView({ command: "echo output", output, exitCode: 0, cancelled: false, expanded }),
		{ width, theme },
	);
	try {
		return root.text().join("\n");
	} finally {
		root.dispose();
	}
}

describe("BashExecutionView output preview", () => {
	it("uses the native visual-row tail preview and keeps its data-loss notice", () => {
		const output = Array.from({ length: 25 }, (_, index) => `row-${index}`).join("\n");
		const text = render(output, false);

		expect(text).toContain("row-24");
		expect(text).not.toContain("row-0");
		expect(text).toContain("… 5 more lines (ctrl+o to expand)");
	});

	it("retains complete ANSI output when expanded", () => {
		const output = "\x1b[31mred\x1b[0m\n日本語";
		const text = render(output, true);

		expect(text).toContain("red");
		expect(text).toContain("日本語");
		expect(text).not.toContain("more lines");
	});
});
