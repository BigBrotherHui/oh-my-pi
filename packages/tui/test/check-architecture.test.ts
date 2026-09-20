import { describe, expect, test } from "bun:test";
import { analyzeArchitectureSource } from "../scripts/check-architecture";

function rules(source: string, file = "packages/tui/src/tools/fixture.tsx"): string[] {
	return analyzeArchitectureSource(source, { file, isView: true }).map(violation => violation.rule);
}

describe("syntax-aware architecture checker", () => {
	test("reports executable legacy view mechanisms", () => {
		const found = rules(`
import * as Solid from "solid-js";
/** @jsxImportSource solid-js */
class Legacy implements Component {}
function View(props: { readonly label: string }) {
	const { label } = props;
	new Mount();
	controller.paint();
	controller.invalidate();
	ui.requestRender();
	ui.requestComponentRender();
	theme.fg("accent");
	theme.bg("surface");
	ui.styledSymbol();
	ui.truncateToWidth();
	ui.visibleWidth();
	return <text>{label}</text>;
}
`);

		expect(found).toEqual(
			expect.arrayContaining([
				'direct import from "solid-js"',
				"legacy JSX import-source pragma",
				"implements Component",
				"destructuring reactive props",
				"new Mount",
				".paint()",
				".invalidate()",
				"requestRender()",
				"requestComponentRender()",
				"theme.fg()",
				"theme.bg()",
				"styledSymbol()",
				"truncateToWidth()",
				"visibleWidth()",
			]),
		);
	});

	test("ignores forbidden-looking comments and string literals", () => {
		expect(
			rules(`
function View() {
	const prose = "Date.now(); controller.paint(); /** @jsxImportSource solid-js */";
	// requestRender(); new Mount(); import { createMemo } from "solid-js";
	return <text>{prose}</text>;
}
`),
		).toEqual([]);
	});

	test("permits controller event timestamp ingestion", () => {
		expect(
			rules(`
function ingestEvent(event: { receivedAt: number }) {
	event.receivedAt = Date.now();
}
function View() {
	return <button onClick={ingestEvent}>Ingest</button>;
}
`),
		).toEqual([]);
	});

	test("detects direct, computed, and helper-mediated render clocks", () => {
		const found = rules(`
import { createMemo as memo } from "@oh-my-pi/pi-tui/reactive";
function clock() {
	return Date.now();
}
function View() {
	const cached = memo(() => Date["now"]());
	return <text>{clock() + cached()}</text>;
}
`);

		expect(found.filter(rule => rule === "Date.now()")).toHaveLength(2);
	});

	test("recognizes qualified callbacks and strict direct Solid imports", () => {
		const found = rules(`
import * as Solid from "solid-js";
function View() {
	Solid.createMemo(() => Date.now());
	return <box />;
}
`);

		expect(found).toEqual(expect.arrayContaining(['direct import from "solid-js"', "Date.now()"]));
	});

	test("surfaces parser errors instead of treating malformed source as clean", () => {
		expect(() => rules("function View( { return <box />; }")).toThrow();
	});
});
