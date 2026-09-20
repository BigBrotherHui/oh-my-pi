import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { SkillMessageView } from "../src/chat/skill-message";
import type { CustomMessage, SkillPromptDetails } from "../src/chat/messages";
import { skillChipLabel } from "../src/prompt/composer-attachments";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { renderToRows } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";

function message(
	details: SkillPromptDetails,
	content = "Use the atomic-commit workflow.",
): CustomMessage<SkillPromptDetails> {
	return { role: "custom", customType: "skill-prompt", content, display: true, details, timestamp: 0 };
}

function render(message: CustomMessage<SkillPromptDetails>, expanded = false, width = 80): readonly string[] {
	return renderToRows(() => SkillMessageView({ message, expanded }), width);
}

function plain(rows: readonly string[]): string {
	return Bun.stripANSI(rows.join("\n"));
}

afterEach(() => applyHyperlinkSetting("auto"));

describe("SkillMessageView", () => {
	const skillPath = path.join(process.cwd(), "fixtures", "atomic-commit", "SKILL.md");
	const skillUri = url.pathToFileURL(skillPath).href;
	const chip = () => skillChipLabel("atomic-commit");

	it("restores the leading invocation callout, metadata, linked chip, and multi-line draft", () => {
		applyHyperlinkSetting("always");
		const rows = render(
			message({
				name: "atomic-commit",
				path: skillPath,
				lineCount: 88,
				args: "stage all\n- then split\n- then push",
				prompt: "/skill:atomic-commit stage all\n- then split\n- then push",
			}),
		);
		const text = plain(rows);
		const rail = loadThemeSync("dark").symbol("skill.rail");

		for (const row of rows) expect(Bun.stripANSI(row).startsWith(rail)).toBe(true);
		expect(text).toContain(chip());
		expect(text).toContain("88 lines");
		expect(text).not.toContain("/skill:");
		expect(rows.join("\n")).toContain(skillUri);
		const visible = rows.map(row => Bun.stripANSI(row));
		expect(visible.findIndex(row => row.includes("stage all"))).toBeGreaterThan(
			visible.findIndex(row => row.includes(chip())),
		);
		expect(visible.some(row => row.includes("then split"))).toBe(true);
		expect(visible.some(row => row.includes("then push"))).toBe(true);
	});

	it("keeps a mid-prompt invocation in the ordinary linked user bubble", () => {
		applyHyperlinkSetting("always");
		const rows = render(
			message({
				name: "atomic-commit",
				path: skillPath,
				lineCount: 88,
				prompt: "fix the auth bug /skill:atomic-commit then",
			}),
		);
		const text = plain(rows);
		const rail = loadThemeSync("dark").symbol("skill.rail");

		expect(text).toContain(`fix the auth bug ${chip()} then`);
		expect(text).not.toContain("/skill:");
		expect(text).not.toContain("88 lines");
		expect(rows.some(row => Bun.stripANSI(row).startsWith(rail))).toBe(false);
		expect(rows.join("\n")).toContain(skillUri);
	});

	it("uses legacy args for callout layout while leaving undispatched skill tokens literal", () => {
		const legacy = render(message({ name: "atomic-commit", path: skillPath, lineCount: 1, args: "stage all" }));
		expect(plain(legacy)).toContain("stage all");
		expect(plain(legacy)).toContain("1 line");
		expect(plain(legacy)).not.toContain("1 lines");

		const second = plain(
			render(
				message({
					name: "atomic-commit",
					path: skillPath,
					lineCount: 88,
					prompt: "/skill:atomic-commit then /skill:other",
				}),
			),
		);
		expect(second).toContain(chip());
		expect(second).toContain("/skill:other");
	});

	it("lazily reveals the persisted prompt under its subheader and stays within narrow bounds", () => {
		const details: SkillPromptDetails = { name: "atomic-commit", path: skillPath, lineCount: 88 };
		const body = "Step one: stage hunks.";
		expect(plain(render(message(details, body)))).not.toContain(body);
		const expanded = render(message(details, body), true, 16);
		expect(plain(expanded)).toContain("prompt");
		expect(expanded.map(row => Bun.stripANSI(row).slice(1).trim()).join(" ")).toContain(body);
		for (const row of expanded) expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(16);
	});
});
