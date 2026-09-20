import { beforeAll, describe, expect, it } from "bun:test";
import {
	GALLERY_STATES,
	GALLERY_SURFACES,
	parseGalleryStates,
	parseGallerySurfaces,
	renderGalleryState,
	renderGallerySurfaceSections,
	resolveFixture,
} from "@oh-my-pi/pi-coding-agent/cli/gallery-cli";
import {
	type GalleryFixture,
	getComposerGalleryEntries,
	getComposerGalleryInventory,
	getSegmentGalleryEntries,
	getSegmentGalleryInventory,
} from "@oh-my-pi/pi-coding-agent/cli/gallery-fixtures";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getComposerShapeOptions } from "@oh-my-pi/pi-tui/overlays/composer-shape-registry";
import { ALL_SEGMENT_IDS } from "@oh-my-pi/pi-tui/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { cellGrid } from "../../tui/test/cell-grid";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, undefined, undefined, "dark", "light");
});

describe("gallery harness", () => {
	it("accepts displayed gallery state labels and legacy tokens", () => {
		expect(parseGalleryStates(["streaming args", "in progress", "done", "failed"])).toEqual([
			"streaming",
			"progress",
			"success",
			"error",
		]);
		expect(parseGalleryStates(["streaming", "progress", "success", "error", "failed"])).toEqual([...GALLERY_STATES]);
	});

	it("rejects unknown gallery state tokens before rendering", () => {
		expect(() => parseGalleryStates(["bogus"])).toThrow(
			/Invalid --state 'bogus'.*streaming args.*in progress.*done.*failed/,
		);
	});

	it("parses repeatable surfaces and expands all in product order", () => {
		expect(parseGallerySurfaces(["segment", "tool", "segment"])).toEqual(["tool", "segment"]);
		expect(parseGallerySurfaces(["all"])).toEqual([...GALLERY_SURFACES]);
		expect(() => parseGallerySurfaces(["bogus"])).toThrow(/Invalid --surface 'bogus'.*tool.*composer.*segment.*all/);
	});

	it("derives composer and segment coverage from the production registries", () => {
		const composerRegistry = getComposerShapeOptions().map(option => option.value);
		expect(getComposerGalleryInventory()).toEqual(composerRegistry);
		expect(getComposerGalleryEntries().map(entry => entry.id)).toEqual(composerRegistry);
		expect(getSegmentGalleryInventory()).toEqual(ALL_SEGMENT_IDS);
		expect(getSegmentGalleryEntries().map(entry => entry.id)).toEqual(ALL_SEGMENT_IDS);
	});

	it("orders surfaces tool then composer then segment and lets entry filters imply their surface", async () => {
		const composer = getComposerGalleryInventory()[0];
		const segment = getSegmentGalleryInventory()[0];
		if (!composer || !segment) throw new Error("Production gallery registries must not be empty");

		const sections = await renderGallerySurfaceSections({
			surfaces: [...GALLERY_SURFACES],
			tool: "bash",
			composer,
			segment,
			states: ["success"],
		});
		expect(sections.map(section => section.heading)).toEqual([
			"bash — Bash",
			expect.stringContaining(`composer · ${composer}`),
			`segment · ${segment}`,
		]);

		const toolOnly = await renderGallerySurfaceSections({ tool: "bash", states: ["success"] });
		expect(toolOnly.map(section => section.heading)).toEqual(["bash — Bash"]);
		const composerOnly = await renderGallerySurfaceSections({ composer });
		expect(composerOnly).toHaveLength(1);
		expect(composerOnly[0]?.heading).toContain(`composer · ${composer}`);
		const segmentOnly = await renderGallerySurfaceSections({ segment });
		expect(segmentOnly).toHaveLength(1);
		expect(segmentOnly[0]?.heading).toBe(`segment · ${segment}`);
	});

	it("routes each state to the matching args/result (streaming args vs result, success vs error)", async () => {
		const fixture: GalleryFixture = {
			label: "Bash",
			streamingArgs: { command: "echo STREAM_MARK" },
			args: { command: "echo PROGRESS_MARK" },
			result: { content: [{ type: "text", text: "SUCCESS_OUT" }], details: { exitCode: 0 } },
			errorResult: { content: [{ type: "text", text: "ERROR_OUT" }], isError: true, details: { exitCode: 1 } },
		};
		const render = async (state: (typeof GALLERY_STATES)[number]) =>
			Bun.stripANSI((await renderGalleryState("bash", fixture, state, 100)).join("\n"));

		const streaming = await render("streaming");
		expect(streaming).toContain("STREAM_MARK");
		expect(streaming).not.toContain("PROGRESS_MARK");
		expect(streaming).not.toContain("SUCCESS_OUT");

		const progress = await render("progress");
		expect(progress).toContain("PROGRESS_MARK");
		expect(progress).not.toContain("SUCCESS_OUT");

		const success = await render("success");
		expect(success).toContain("SUCCESS_OUT");
		expect(success).not.toContain("ERROR_OUT");

		const error = await render("error");
		expect(error).toContain("ERROR_OUT");
		expect(error).not.toContain("SUCCESS_OUT");
	});

	it("keeps custom hub previews transparent throughout their lifecycle", async () => {
		for (const state of GALLERY_STATES) {
			const lines = await renderGalleryState("hub_wait", resolveFixture("hub_wait"), state, 80);
			expect(Bun.stripANSI(lines.join("\n"))).toContain("AuthLoader");
			expect(
				cellGrid(lines, 80).every(row => row.every(cell => cell.bg === null)),
				state,
			).toBe(true);
		}
	});

	it("renders task through its registered reactive view", async () => {
		const lines = await renderGalleryState("task", resolveFixture("task"), "error", 100);
		const stripped = lines.map(line => Bun.stripANSI(line).trim());
		expect(stripped.some(line => line.startsWith(theme.boxRound.topLeft) && line.includes("Task"))).toBe(true);
		expect(cellGrid(lines, 100).some(row => row.some(cell => cell.bg !== null))).toBe(true);
	});

	it("renders curated failed states as failures", async () => {
		const cases = [
			["hub_inbox", "IRC inbox failed: message store unavailable.", "IRC inbox empty"],
			["hub_list", "IRC list failed: agent hub is unavailable.", "no other agents"],
			["hub_jobs", "Subagent exited 1: Redis connection string is missing.", "cancelled"],
		] as const;

		for (const [name, expected, forbidden] of cases) {
			const output = Bun.stripANSI((await renderGalleryState(name, resolveFixture(name), "error", 100)).join("\n"));
			expect(output).toContain(expected);
			expect(output).not.toContain(forbidden);
		}
	});
});
