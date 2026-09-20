import { describe, expect, test } from "bun:test";
import { shouldTransformSolidTsx, transform, transformCached } from "../../src/compiler/solid-jsx-plugin";

const compile = (body: string, name: string): Promise<string> => transform(body, `/fixtures/${name}.tsx`);

describe("Solid universal JSX transform", () => {
	test("emits tracked text and attribute bindings", async () => {
		const text = await compile("const View = () => <text>{count()}</text>;", "text");
		const attribute = await compile("const View = () => <text role={count()} />;", "attribute");

		expect(text).toContain('from "@oh-my-pi/pi-tui/host/renderer"');
		expect(text).toMatch(/_\$insert\(_el\$, count\)/);
		expect(attribute).toMatch(/_\$effect\(.*_\$setProp\(_el\$, "role", count\(\),/);
	});

	test("keeps spreads, conditionals, callbacks, fragments, and refs reactive", async () => {
		const spread = await compile("const View = () => <text {...props()} />;", "spread");
		const conditional = await compile('const View = () => <text>{enabled() ? "on" : "off"}</text>;', "conditional");
		const callback = await compile("const View = () => <text onPress={() => called++} />;", "callback");
		const fragment = await compile("const View = () => <><text>a</text><text>b</text></>;", "fragment");
		const ref = await compile("const View = () => <text ref={node => seen = node} />;", "ref");

		expect(spread).toMatch(/_\$spread\(_el\$, _\$mergeProps\(props\), false\)/);
		expect(conditional).toContain('_$insert(_el$, () => enabled() ? "on" : "off")');
		expect(callback).toContain('_$setProp(_el$, "onPress", () => called++)');
		expect(callback).not.toContain('_$setProp(_el$, "onPress", called++)');
		expect(fragment).toMatch(/const View = \(\) => \[\(\(\) =>/);
		expect(fragment.match(/_\$createElement\("text"\)/g)).toHaveLength(2);
		expect(ref).toContain("_$use((node) => seen = node, _el$)");
	});

	test("removes TypeScript syntax and emits an inline source map", async () => {
		const code = await compile(
			"interface Props { value: number }\nconst View = (props: Props) => <text>{props.value}</text>;",
			"typescript",
		);

		expect(code).not.toContain("interface Props");
		expect(code).not.toContain("props: Props");
		expect(code).toContain("//# sourceMappingURL=data:application/json");
	});

	test("pins reactive Solid imports and rejects the DOM renderer", async () => {
		const code = await compile(
			'import { createSignal } from "solid-js";\nexport const signal = createSignal(0);',
			"solid",
		);
		expect(code.replaceAll("\\\\", "/")).toContain("node_modules/solid-js/dist/solid.js");
		expect(code).not.toContain("solid-js/dist/server.js");
		await expect(
			compile('import { render } from "solid-js/web";\nexport const domRender = render;', "solid-web"),
		).rejects.toThrow(/solid-js\/web is the DOM renderer/);
	});

	test("serves a compiled module from the persistent cache without Babel", async () => {
		const source = `const View = () => <text>cache-${Date.now()}</text>;`;
		const compiled = await compile(source, "cache-hit");

		expect(transformCached(source, "/fixtures/cache-hit.tsx")).toBe(compiled);
	});

	test("recompiles when source changes at a previously cached path", async () => {
		const before = await compile("const View = () => <text>before</text>;", "cached");
		const after = await compile("const View = () => <text>after</text>;", "cached");

		expect(before).toContain("_$createTextNode(`before`)");
		expect(after).toContain("_$createTextNode(`after`)");
		expect(after).not.toContain("_$createTextNode(`before`)");
	});

	test("leaves excluded TSX outside the Solid transform", async () => {
		const collab = "const View = () => <div>web</div>;";
		const dependency = "const View = () => <div>dependency</div>;";

		expect(await transform(collab, "/repo/packages/collab-web/src/view.tsx")).toBe(collab);
		expect(await transform(dependency, "/repo/node_modules/example/view.tsx")).toBe(dependency);
		expect(shouldTransformSolidTsx(dependency, "/repo/node_modules/@oh-my-pi/plugin/view.tsx")).toBe(true);
	});
});
