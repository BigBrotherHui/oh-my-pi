import { beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { LateDiagnosticsMessageView, type LateDiagnosticsFile } from "@oh-my-pi/pi-tui/chat/late-diagnostics-message";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { createSignal } from "../src/reactive";
import { mountForTest, renderToRows } from "../src/testing";

const darkTheme = await getThemeByName("dark");

function plain(files: readonly LateDiagnosticsFile[], expanded = false, visible = true, width = 120): string {
	return stripVTControlCharacters(
		renderToRows(() => LateDiagnosticsMessageView({ files, expanded, visible }), width).join("\n"),
	);
}

describe("LateDiagnosticsMessageView", () => {
	beforeEach(() => {
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
	});

	it("renders a themed, file-grouped diagnostic tree from parsed messages", () => {
		const text = plain([
			{
				path: "/abs/ignored-by-the-diagnostic-tree.ts",
				summary: "1 error(s)",
				errored: true,
				messages: [
					"packages/coding-agent/src/foo.ts:7804:14 [error] [typescript] Type 'string' is not assignable to type 'number'. (2322)",
				],
			},
			{
				summary: "1 warning(s)",
				messages: ["packages/coding-agent/src/foo.ts:7805:2 [warning] [typescript] This may be undefined. (2532)"],
			},
		]);

		expect(text).toContain("Late diagnostics");
		expect(text).toContain("(1 error(s), 1 warning(s))");
		expect(text).toContain("packages/coding-agent/src/foo.ts");
		expect(text).toContain(":7804:14");
		expect(text).toContain("Type 'string' is not assignable to type 'number'.");
		expect(text).toContain("(2322)");
		expect(text).not.toContain("ignored-by-the-diagnostic-tree.ts");
		expect(text).not.toContain("[error]");
		expect(text).not.toContain("[typescript]");
	});

	it("sorts each file by severity, location, and message before rendering", () => {
		const text = plain([
			{
				errored: true,
				messages: [
					"src/sorted.ts:3:2 [warning] later warning (W2)",
					"src/sorted.ts:9:1 [error] later error (E9)",
					"src/sorted.ts:2:8 [error] earlier error (E2)",
				],
			},
		]);

		expect(text.indexOf("earlier error")).toBeLessThan(text.indexOf("later error"));
		expect(text.indexOf("later error")).toBeLessThan(text.indexOf("later warning"));
	});

	it("limits collapsed diagnostics globally and provides the keymap-aware expand hint", () => {
		const files = [
			{
				summary: "8 error(s)",
				errored: true,
				messages: Array.from(
					{ length: 8 },
					(_, index) => `src/foo.ts:${index + 1}:1 [error] [typescript] err ${index + 1} (${index + 1})`,
				),
			},
		];

		const collapsed = plain(files);
		expect(collapsed).toContain("err 5");
		expect(collapsed).not.toContain("err 6");
		expect(collapsed).toContain("… 3 more");
		expect(collapsed).toContain("Expand");

		const expanded = plain(files, true);
		expect(expanded).toContain("err 8");
		expect(expanded).not.toContain("… 3 more");
	});

	it("keeps parsed and fallback diagnostics legible in a narrow tree", () => {
		const text = plain(
			[
				{
					summary: "1 error(s)\tand 1 warning(s)",
					errored: true,
					messages: [
						"src/narrow.ts:3:7 [error] [typescript] A diagnostic message that needs wrapping at narrow terminal widths. (9999)",
						"unparsed fallback diagnostic",
					],
				},
			],
			true,
			true,
			24,
		);

		expect(text).toContain("src/narrow.ts");
		expect(text).toContain(":3:7");
		expect(text).toContain("unparsed");
		expect(text).toContain("fallback");
		expect(text).not.toContain("\t");
		expect(text.split("\n").some(line => line.includes("├") || line.includes("└"))).toBe(true);
	});

	it("reacts to visibility changes without losing diagnostics", () => {
		const [visible, setVisible] = createSignal(true);
		const files = [
			{
				errored: true,
				messages: ["src/foo.ts:1:1 [error] [typescript] bad (2322)"],
			},
		];
		const root = mountForTest(() =>
			LateDiagnosticsMessageView({
				files,
				expanded: false,
				get visible() {
					return visible();
				},
			}),
		);

		try {
			expect(root.text().join("\n")).toContain("Late diagnostics");
			setVisible(false);
			expect(root.text().join("\n")).toBe("");
			setVisible(true);
			expect(root.text().join("\n")).toContain("bad");
		} finally {
			root.dispose();
		}
	});

	it("renders an unknown parsed severity as informational rather than failing", () => {
		const text = plain([
			{
				messages: ["src/unknown.ts:1:1 [fatal] provider-specific severity (P1)"],
			},
		]);

		expect(text).toContain("src/unknown.ts");
		expect(text).toContain("provider-specific severity");
	});

	it("renders nothing without diagnostic messages", () => {
		expect(plain([{ path: "/abs/empty.ts", summary: "", errored: false, messages: [] }]).trim()).toBe("");
	});
});
