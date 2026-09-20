import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { BashExecutionStream, BashExecutionView } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-tui/theme";
import { mountForTest, type TestRoot } from "../src/testing";

let darkTheme: Theme;
const roots: TestRoot[] = [];

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Expected dark theme");
	darkTheme = theme;
});

afterEach(() => {
	for (const root of roots.splice(0)) root.dispose();
});

function mountStream(stream: BashExecutionStream): TestRoot {
	const root = mountForTest(() => BashExecutionView({ command: "shell", stream, expanded: true }), {
		width: 100,
		theme: darkTheme,
	});
	roots.push(root);
	return root;
}

/** Covers raw user-shell PTY replay rather than the separate interactive-shell overlay. */
describe("BashExecutionStream PTY rendering", () => {
	it("replays safe SGR colors through completion", async () => {
		const stream = new BashExecutionStream();
		const root = mountStream(stream);
		try {
			stream.appendPtyChunk("\u001b[31mred\u001b[0m plain\r\nsecond\r\n");
			await stream.setComplete(0, false, { output: "red plain\nsecond" });

			const completed = root.rows().join("\n");
			expect(completed).toContain("\u001b[38;5;1m");
			expect(Bun.stripANSI(completed)).toContain("red plain");
			expect(Bun.stripANSI(completed)).toContain("second");
		} finally {
			stream.dispose();
		}
	});

	it("collapses carriage-return progress updates to the final terminal frame", async () => {
		const stream = new BashExecutionStream();
		const root = mountStream(stream);
		try {
			stream.appendPtyChunk("10%\r50%\r100%\r\ndone\r\n");
			await stream.setComplete(0, false);

			const screen = Bun.stripANSI(root.rows().join("\n"));
			expect(screen).toContain("100%");
			expect(screen).toContain("done");
			expect(screen).not.toContain("50%");
		} finally {
			stream.dispose();
		}
	});

	for (const exitCode of [0, 7]) {
		it(`retains queued PTY rows through exit ${exitCode}`, async () => {
			const stream = new BashExecutionStream();
			const root = mountStream(stream);
			try {
				stream.appendPtyChunk("OUT-MARKER\r\nERR-MARKER\r\n");
				const settled = stream.setComplete(exitCode, false);
				expect(stream.finalized()).toBe(false);
				await settled;

				const screen = Bun.stripANSI(root.rows().join("\n"));
				expect(screen).toContain("OUT-MARKER");
				expect(screen).toContain("ERR-MARKER");
				expect(stream.finalized()).toBe(true);
				if (exitCode !== 0) expect(screen).toContain("(exit 7)");
			} finally {
				stream.dispose();
			}
		});
	}
});
