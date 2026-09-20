import { describe, expect, it } from "bun:test";
import { RichText } from "../../src/core/richtext";
import { Attr, DEFAULT_COLOR, Style } from "../../src/core/style";
import { Damage, type ElementImpl, type HostElement } from "../../src/host/types";
import { resolveStyle } from "../../src/style/cascade";
import { defineRecipe } from "../../src/style/recipes";
import { loadThemeSync } from "../../src/theme/loader";

const theme = loadThemeSync("dark", { mode: "truecolor" });
let nextId = 1;

const cascadeImpl: ElementImpl = {
	tag: "cascade-test",
	defaultStyle: { color: "muted" },
	variantStyle(node) {
		return node.props.variant === true ? { color: "warning" } : undefined;
	},
	propDamage: () => Damage.Paint,
	paint(_node, out) {
		out.br();
	},
};

function element(props: Record<string, unknown> = {}, impl: ElementImpl = cascadeImpl): HostElement {
	return {
		id: nextId++,
		kind: "element",
		tag: impl.tag,
		parent: null,
		props,
		children: [],
		slots: new Map(),
		impl,
		state: undefined,
		damage: Damage.Layout,
		cache: new RichText(),
		cacheWidth: -1,
		cacheEpoch: -1,
	};
}

function color(node: HostElement): number {
	return resolveStyle(node, { theme }).fg;
}

describe("style cascade", () => {
	it("applies every precedence layer over the preceding layer", () => {
		const parent = element({ color: "success" });
		const node = element();

		expect(color(node)).toBe(theme.fgColor("muted"));
		node.parent = parent;
		node.damage = Damage.Paint;
		expect(color(node)).toBe(theme.fgColor("success"));

		node.damage = Damage.None;
		node.props.variant = true;
		node.damage = Damage.Paint;
		expect(color(node)).toBe(theme.fgColor("warning"));

		node.damage = Damage.None;
		node.damage = Damage.Paint;
		defineRecipe("cascade-test.precedence", { color: "toolTitle", bold: true });
		node.props.recipe = "cascade-test.precedence";
		expect(color(node)).toBe(theme.fgColor("toolTitle"));
		expect(resolveStyle(node, { theme }).has(Attr.Bold)).toBe(true);

		node.damage = Damage.None;
		node.damage = Damage.Paint;
		node.props.style = theme.style("accent");
		expect(color(node)).toBe(theme.fgColor("accent"));

		node.damage = Damage.None;
		node.damage = Damage.Paint;
		node.props.color = "error";
		expect(color(node)).toBe(theme.fgColor("error"));
	});

	it("inherits text fields but never the ancestor background", () => {
		const parent = element({ color: "success", background: "toolErrorBg", underline: true });
		const child = element();
		child.parent = parent;
		const resolved = resolveStyle(child, { theme });

		expect(resolved.fg).toBe(theme.fgColor("success"));
		expect(resolved.bg).toBe(DEFAULT_COLOR);
		expect(resolved.has(Attr.Underline)).toBe(true);
	});

	it("invalidates inherited styles when an ancestor receives paint damage", () => {
		const parent = element({ color: "success" });
		const child = element();
		child.parent = parent;
		expect(color(child)).toBe(theme.fgColor("success"));

		child.damage = Damage.None;
		parent.damage = Damage.None;
		parent.props.color = "error";
		parent.damage = Damage.Paint;
		expect(color(child)).toBe(theme.fgColor("error"));
	});

	it("memoizes until paint damage and then resolves changed props", () => {
		const node = element({ color: "success" });
		const first = resolveStyle(node, { theme });
		node.damage = Damage.None;
		node.props.color = "error";
		expect(resolveStyle(node, { theme })).toBe(first);

		node.damage = Damage.Paint;
		expect(resolveStyle(node, { theme }).fg).toBe(theme.fgColor("error"));
	});

	it("lets explicit false clear lower-layer attributes", () => {
		const impl: ElementImpl = { ...cascadeImpl, defaultStyle: { bold: true } };
		const node = element({ bold: false }, impl);
		expect(resolveStyle(node, { theme }).attrs).toBe(Attr.None);
		expect(resolveStyle(node, { theme })).toBe(Style.NONE);
	});
});
