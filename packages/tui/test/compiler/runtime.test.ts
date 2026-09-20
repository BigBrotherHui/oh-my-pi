import { expect, test } from "bun:test";
import { renderTextFixture, runRuntimeFixture } from "./runtime-fixture";

test("terminal text decodes JSX entities without escaping or decoding runtime data", () => {
	expect(renderTextFixture("<runtime>&lt;")).toEqual(["<raw> & λ", "<literal>&amp;", "<runtime>&lt;"]);
});

test("preload compiles pragma-free TSX to an in-place signal binding", () => {
	const result = runRuntimeFixture();
	expect(result.initialText).toBe("0");
	expect(result.updatedText).toBe("1");
	expect(result.retainedTextIdentity).toBe(true);
	expect(result.viewRuns).toBe(1);
});

test("preload transforms a runtime-selected TSX extension", async () => {
	// Dynamic by design: this exercises Bun.plugin rather than the static test graph.
	const extensionPath = `${import.meta.dir}/${"dynamic-extension-fixture.tsx"}`;
	const loaded: unknown = await import(extensionPath);
	if (typeof loaded !== "object" || loaded === null) throw new Error("dynamic extension returned no namespace");
	const fixture = Reflect.get(loaded, "DynamicExtensionFixture");
	if (typeof fixture !== "function") throw new Error("dynamic extension did not export its component");
	const node: unknown = fixture();
	expect(Reflect.get(Object(node), "tag")).toBe("box");
});
