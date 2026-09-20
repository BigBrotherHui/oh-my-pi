import { describe, expect, it } from "bun:test";
import { TextView } from "../src/components/text";
import { renderToRows } from "../src/testing";
import { Attr, Style } from "../src/core/style";

describe("TextView", () => {
	it("paints an explicit run style without changing visible text", () => {
		const rendered = renderToRows(() => TextView({ text: "hello", style: Style.NONE.plus(Attr.Bold) }), 40).join(
			"\n",
		);
		expect(rendered).toContain("\x1b[1mhello");
		expect(Bun.stripANSI(rendered)).toContain("hello");
	});

	it("keeps successive view values independent", () => {
		const bold = renderToRows(() => TextView({ text: "hello", style: Style.NONE.plus(Attr.Bold) }), 40).join("\n");
		const italic = renderToRows(() => TextView({ text: "hello", style: Style.NONE.plus(Attr.Italic) }), 40).join(
			"\n",
		);
		expect(bold).toContain("\x1b[1mhello");
		expect(italic).toContain("\x1b[3mhello");
	});
});
