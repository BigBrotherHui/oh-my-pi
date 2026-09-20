import { describe, expect, it } from "bun:test";
import { AdvisorMessageView } from "../src/chat/advisor-message";
import type { AdvisorMessageDetails } from "../src/chat/messages";
import { createSignal } from "../src/reactive";
import { mountForTest } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";
import { visibleWidth } from "../src/utils";

const darkTheme = loadThemeSync("dark");

function renderAdvisor(details: AdvisorMessageDetails, expanded: boolean, width = 120): readonly string[] {
	const root = mountForTest(() => AdvisorMessageView({ details, expanded }), { width, theme: darkTheme });
	try {
		return root.rows();
	} finally {
		root.dispose();
	}
}

describe("AdvisorMessageView", () => {
	const details: AdvisorMessageDetails = {
		notes: [
			{ severity: "nit", note: "Keep the narrow transcript layout aligned." },
			{ severity: "concern", advisor: "lint\tbot", note: "Keep\twrapped note bodies legible." },
			{ severity: "blocker", advisor: "default", note: "Stop before shipping this regression." },
			{ severity: "nit", advisor: "reviewer", note: "This fourth note is only visible when expanded." },
		],
	};

	it("keeps the historical compact header, severity rails, attribution, and hidden-note count", () => {
		const text = Bun.stripANSI(renderAdvisor(details, false).join("\n"));

		const leftBracket = darkTheme.symbol("format.bracketLeft");
		const rightBracket = darkTheme.symbol("format.bracketRight");
		expect(text).toContain("Advisor 4 notes · 1 blocker");
		expect(text).toContain(`${leftBracket}nit${rightBracket} Keep the narrow transcript layout aligned.`);
		expect(text).toContain(`${leftBracket}concern${rightBracket} [lint   bot] Keep   wrapped note bodies legible.`);
		expect(text).toContain(`${leftBracket}blocker${rightBracket} Stop before shipping this regression.`);
		expect(text).not.toContain("[default]");
		expect(text).toContain("… +1 more note");
		expect(text).not.toContain("This fourth note is only visible when expanded.");
	});

	it("reactively switches between the three-note preview and complete advice", () => {
		const [expanded, setExpanded] = createSignal(false);
		const root = mountForTest(() => <AdvisorMessageView details={details} expanded={expanded()} />, {
			width: 120,
			theme: darkTheme,
		});
		try {
			expect(root.text().join("\n")).toContain("… +1 more note");
			setExpanded(true);
			const complete = root.text().join("\n");
			expect(complete).toContain("This fourth note is only visible when expanded.");
			expect(complete).not.toContain("… +1 more note");
		} finally {
			root.dispose();
		}
	});

	it("uses the original first-line and continuation widths without overflowing narrow terminals", () => {
		const narrowDetails: AdvisorMessageDetails = {
			notes: [
				{
					severity: "blocker",
					advisor: "reviewer",
					note: "A long advisor note keeps every meaningful word while its badge and source consume the first-row prefix.",
				},
			],
		};
		const rows = renderAdvisor(narrowDetails, true, 44);
		const text = Bun.stripANSI(rows.join("\n"));

		expect(text).toContain(
			`${darkTheme.symbol("format.bracketLeft")}blocker${darkTheme.symbol("format.bracketRight")} [reviewer] A long advisor`,
		);
		expect(text).toContain("meaningful word");
		expect(text).toContain("first-row prefix.");
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(44);
	});
});
