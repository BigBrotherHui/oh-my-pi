import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createDocument } from "@oh-my-pi/pi-tui/document/document";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-tui/theme";
import { mountForTest, type TestRoot } from "../src/testing";
import { cellGrid } from "./cell-grid";

const SIXEL = "\x1bPqabc\ncontinued\x1b\\";

describe("preview host element", () => {
	let theme: Theme;
	const roots: TestRoot[] = [];
	const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("Expected dark theme");
		theme = loaded;
	});

	afterEach(() => {
		for (const root of roots.splice(0)) root.dispose();
		if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
		if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
	});

	it("preserves the legacy total-row budget unless the caller opts out", () => {
		const document = createDocument("zero\none\ntwo");
		const reserved = mountForTest(() => <preview document={document} edge="tail" limit={2} unit="lines" />, {
			width: 40,
			theme,
		});
		roots.push(reserved);
		expect(reserved.text()).toEqual(["… 2 earlier lines", "two"]);

		const bodyBudget = mountForTest(
			() => <preview document={document} edge="tail" limit={2} unit="lines" reserveSummary={false} />,
			{ width: 40, theme },
		);
		roots.push(bodyBudget);
		expect(bodyBudget.text()).toEqual(["… 1 earlier line", "one", "two"]);
	});

	it("bounds and trims document rows before capping", () => {
		const document = createDocument("zero\none\nlast  \n\n");
		const root = mountForTest(
			() => <preview document={document} startLine={1} endLine={4} trimEnd limit={10} unit="lines" />,
			{ width: 40, theme },
		);
		roots.push(root);

		expect(root.text()).toEqual(["one", "last"]);
	});

	it("matches terminal carriage-return overwrite semantics", () => {
		const document = createDocument("stale\rlive");
		const root = mountForTest(() => <preview document={document} limit={10} unit="lines" />, {
			width: 40,
			theme,
		});
		roots.push(root);

		expect(root.text()).toEqual(["live"]);
	});

	it("caps external text rows without touching complete SIXEL payloads", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const payload = `\x1bPq${"A".repeat(5_000)}\x1b\\`;
		const document = createDocument(`${"x".repeat(4_005)}\n${payload}`);
		const root = mountForTest(
			() => <preview document={document} ansi preserveSixel maxLineCells={4_000} limit={10} unit="rows" />,
			{ width: 5_000, theme },
		);
		roots.push(root);

		const rows = root.rows().join("\n");
		expect(Bun.stripANSI(rows)).toContain("[5 visible columns omitted]");
		expect(rows).toContain(payload);
	});

	it("wraps hidden-row summaries when the caller requests it", () => {
		const document = createDocument(Array.from({ length: 8 }, (_, index) => `row-${index}`).join("\n"));
		const root = mountForTest(
			() => (
				<preview
					document={document}
					edge="tail"
					limit={4}
					unit="rows"
					reserveSummary={false}
					summaryWrap
					hiddenLabel={hidden => `… ${hidden} more lines (ctrl+o to expand)`}
				/>
			),
			{ width: 12, theme },
		);
		roots.push(root);

		expect(
			root
				.text()
				.map(line => line.trim())
				.join(" "),
		).toContain("… 4 more lines (ctrl+o to expand)");
	});

	it("caps preformatted external rows at the native display boundary", () => {
		const document = createDocument("界".repeat(4));
		const root = mountForTest(() => <pre document={document} maxLineCells={5} />, { width: 40, theme });
		roots.push(root);

		expect(root.text()).toEqual(["界界"]);
	});

	it("keeps SGR styling while removing cursor controls and expanding tabs", () => {
		const document = createDocument("plain\x1b[31m red\x1b[0m\x1b[2J\tend");
		const root = mountForTest(() => <preview document={document} ansi limit={10} unit="lines" />, {
			width: 40,
			theme,
		});
		roots.push(root);

		const rendered = root.rows().join("\n");
		expect(Bun.stripANSI(rendered)).toContain("plain red   end");
		expect(rendered).not.toContain("\x1b[2J");
		const grid = cellGrid(root.rows(), 40);
		expect(grid[0]![6]!.fg).not.toEqual(grid[0]![0]!.fg);
	});

	it("drops SIXEL payload rows when passthrough is not explicitly enabled", () => {
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		const document = createDocument(`before\n${SIXEL}\nafter`);
		const root = mountForTest(() => <preview document={document} ansi preserveSixel limit={10} unit="rows" />, {
			width: 40,
			theme,
		});
		roots.push(root);

		const rendered = root.rows().join("\n");
		expect(rendered).not.toContain("\x1bPq");
		expect(Bun.stripANSI(rendered)).toContain("before");
		expect(Bun.stripANSI(rendered)).toContain("after");
	});

	it("keeps a complete SIXEL payload in place and uncaps the whole pane only behind both gates", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const document = createDocument(`before\n${SIXEL}\nafter`);
		const root = mountForTest(
			() => (
				<preview document={document} ansi preserveSixel edge="tail" limit={1} unit="rows" reserveSummary={false} />
			),
			{ width: 6, theme },
		);
		roots.push(root);

		const rows = root.rows();
		expect(rows.join("\n")).toContain(SIXEL);
		expect(rows.join("\n")).toContain("before");
		expect(rows.join("\n")).toContain("after");
		expect(rows.join("\n")).not.toContain("earlier");
	});
});
