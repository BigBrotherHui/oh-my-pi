import { describe, expect, it } from "bun:test";
import { boxElement } from "../../src/host/elements/box";
import { frameElement } from "../../src/host/elements/frame";
import { linkElement } from "../../src/host/elements/link";
import { pathElement } from "../../src/host/elements/path";
import { rawElement } from "../../src/host/elements/raw";
import { rowElement } from "../../src/host/elements/row";
import { textElement } from "../../src/host/elements/text";
import { Damage } from "../../src/host/types";

describe("layout primitive damage", () => {
	it("separates geometry, paint, text, and link changes", () => {
		expect(textElement.propDamage("wrap")).toBe(Damage.Layout);
		expect(textElement.propDamage("color")).toBe(Damage.Paint);
		expect(textElement.propDamage("link")).toBe(Damage.Link);

		expect(pathElement.propDamage("value")).toBe(Damage.Text);
		expect(pathElement.propDamage("target")).toBe(Damage.Link);
		expect(pathElement.propDamage("overflow")).toBe(Damage.Layout);

		expect(linkElement.propDamage("href")).toBe(Damage.Link);
		expect(rawElement.propDamage("value")).toBe(Damage.Text);
		expect(rawElement.propDamage("width")).toBe(Damage.Layout);

		expect(rowElement.propDamage("gap")).toBe(Damage.Layout);
		expect(rowElement.propDamage("color")).toBe(Damage.Paint);
		expect(boxElement.propDamage("border")).toBe(Damage.Layout);
		expect(boxElement.propDamage("background")).toBe(Damage.Paint);
		expect(frameElement.propDamage("paddingX")).toBe(Damage.Layout);
		expect(frameElement.propDamage("backgroundBorder")).toBe(Damage.Paint);
	});
});
