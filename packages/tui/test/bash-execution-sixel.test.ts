import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { BashExecutionStream, BashExecutionView } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { sanitizeWithOptionalSixelPassthrough } from "@oh-my-pi/pi-tui/render/sixel";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { cellGrid } from "./cell-grid";
import { mountForTest, renderToRows } from "../src/testing";

const SIXEL = "\x1bPqabc\x1b\\";
let darkTheme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("Expected dark theme");
	darkTheme = loaded;
});

function view(output: string, expanded = true) {
	return () =>
		BashExecutionView({
			command: "echo output",
			output,
			exitCode: 0,
			cancelled: false,
			expanded,
		});
}

describe("BashExecutionView SIXEL passthrough", () => {
	const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

	afterEach(() => {
		if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
		if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
	});

	it("preserves SIXEL output as an image raw run when both gates are enabled", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const rows = renderToRows(view(SIXEL), 120);
		expect(rows.filter(row => row.includes(SIXEL))).toHaveLength(1);
	});

	it("does not clamp a long SIXEL payload line", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const payload = `\x1bPq${"A".repeat(5_000)}\x1b\\`;

		const rows = renderToRows(view(payload), 120);
		expect(rows.filter(row => row.includes("\x1bPq"))).toHaveLength(1);
		expect(rows.join("\n")).not.toContain("visible columns omitted");
	});

	it("still clamps a long non-SIXEL line while retaining terminal cell identity", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const rows = renderToRows(view("x".repeat(5_000)), 5_000);

		expect(Bun.stripANSI(rows.join("\n"))).toContain("visible columns omitted");
		const grid = cellGrid(rows, 5_000);
		expect(grid.some(row => row.some(cell => cell.ch === "x"))).toBe(true);
	});

	it("strips SIXEL control escapes before the view when passthrough gates are disabled", () => {
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		const sanitized = sanitizeWithOptionalSixelPassthrough(SIXEL, sanitizeText);

		expect(sanitized).toBe("");
		expect(renderToRows(view(sanitized), 120).join("\n")).not.toContain("\x1bPq");
	});
});

describe("BashExecutionView lifecycle", () => {
	it("keeps the running chrome until completion, then renders the historical failure footer", async () => {
		const stream = new BashExecutionStream();
		const root = mountForTest(() => BashExecutionView({ command: "false", stream, expanded: false }), {
			width: 120,
			theme: darkTheme,
		});
		try {
			expect(root.text().join("\n")).toContain("Running… (esc to cancel)");

			stream.appendOutput("streaming\n");
			await stream.setComplete(7, false, {
				output: "completed",
				meta: {
					truncation: {
						direction: "tail",
						truncatedBy: "lines",
						totalLines: 2,
						totalBytes: 18,
						outputLines: 1,
						outputBytes: 9,
						shownRange: { start: 2, end: 2 },
					},
					artifactError: "write",
				},
			});

			const rendered = root.text().join("\n");
			expect(rendered).not.toContain("Running… (esc to cancel)");
			expect(rendered).toContain("(exit 7)");
			expect(rendered).toContain("Showing lines 2-2 of 2");
			expect(rendered).toContain("Full output was not saved completely (artifact write failed)");
		} finally {
			stream.dispose();
			root.dispose();
		}
	});
});

describe("BashExecutionStream publication", () => {
	it("retains chunks received during a refresh window and publishes the trailing update", () => {
		vi.useFakeTimers();
		const stream = new BashExecutionStream();
		try {
			stream.appendOutput("first ");
			stream.appendOutput("second");
			vi.advanceTimersByTime(50);

			expect(stream.getOutput()).toBe("first second");
		} finally {
			stream.dispose();
			vi.useRealTimers();
		}
	});
});

describe("BashExecutionView document previews", () => {
	it("shows a bounded tail preview while collapsed", () => {
		const output = Array.from({ length: 27 }, (_, index) => `entry${index}`).join("\n");
		const root = mountForTest(view(output, false), { width: 120, theme: darkTheme });
		try {
			const rendered = root.text().join("\n");
			expect(rendered).toContain("entry26");
			expect(rendered).toContain("more lines");
			expect(rendered).toContain("ctrl+o to expand");
			expect(rendered).not.toContain("entry0");
		} finally {
			root.dispose();
		}
	});

	it("shows every document row once expanded", () => {
		const output = Array.from({ length: 27 }, (_, index) => `entry${index}`).join("\n");
		const root = mountForTest(view(output), { width: 120, theme: darkTheme });
		try {
			const rendered = root.text().join("\n");
			expect(rendered).toContain("entry0");
			expect(rendered).toContain("entry26");
			expect(rendered).not.toContain("more lines");
			expect(rendered).not.toContain("ctrl+o to expand");
		} finally {
			root.dispose();
		}
	});
});
