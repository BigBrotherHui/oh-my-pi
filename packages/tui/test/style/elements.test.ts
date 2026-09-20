import { describe, expect, it } from "bun:test";
import { emitRows } from "../../src/core/emit";
import { RichText } from "../../src/core/richtext";
import { DEFAULT_COLOR } from "../../src/core/style";
import "../../src/host/elements/badge";
import "../../src/host/elements/duration";
import "../../src/host/elements/icon";
import "../../src/host/elements/meta";
import "../../src/host/elements/shimmer";
import "../../src/host/elements/span";
import "../../src/host/elements/spinner";
import "../../src/host/elements/status";
import "../../src/host/elements/timestamp";
import { statusElement } from "../../src/host/elements/status";
import { counters, resetCounters } from "../../src/instrumentation";
import {
	attachHostSubtree,
	createElementNode,
	createHostRoot,
	createTextNode,
	disposeHostRoot,
	hostContextFor,
} from "../../src/host/node";
import { createPaintContext, paintHostTree } from "../../src/host/paint";
import type { HostElement, HostText } from "../../src/host/types";
import { createClock } from "../../src/reactive/clock";
import { resolveStyle } from "../../src/style/cascade";
import { loadThemeSync } from "../../src/theme/loader";
import { cellGrid } from "../cell-grid";

function append(parent: HostElement, child: HostElement | HostText): void {
	parent.children.push(child);
	child.parent = parent;
}

function render(
	node: HostElement,
	symbolPresetOverride: "unicode" | "ascii" = "unicode",
	now = 240,
): { rich: RichText; rows: string[] } {
	const theme = loadThemeSync("dark", { mode: "truecolor", symbolPresetOverride });
	const root = createHostRoot({ theme });
	append(root.node, node);
	attachHostSubtree(node, root);
	const context = createPaintContext(root, child => resolveStyle(child, { theme: root.theme }), { now });
	const rich = new RichText();
	try {
		paintHostTree(root, rich, 80, context);
		rich.finish();
		return { rich, rows: emitRows(rich, { mode: theme.getColorMode() }) };
	} finally {
		disposeHostRoot(root);
	}
}

describe("styling glyph elements", () => {
	it("keeps a parent's background under default-styled child text", () => {
		const badge = createElementNode("badge");
		badge.props.background = "toolPendingBg";
		const span = createElementNode("span");
		append(span, createTextNode("child"));
		append(badge, span);

		const { rich } = render(badge);
		const expected = loadThemeSync("dark", { mode: "truecolor" }).bgColor("toolPendingBg");
		expect(rich.style.slice(0, rich.runs).every(style => style.bg === expected)).toBe(true);
		expect(expected).not.toBe(DEFAULT_COLOR);
	});

	it("places meta separators only between non-empty items", () => {
		const meta = createElementNode("meta");
		append(meta, createTextNode(""));
		append(meta, createTextNode("alpha"));
		append(meta, createTextNode("   "));
		append(meta, createTextNode("beta"));
		append(meta, createTextNode(""));

		const { rich } = render(meta);
		expect(rich.rowText(0)).toBe("alpha · beta");
	});

	it("renders badge brackets into the expected terminal cells", () => {
		const badge = createElementNode("badge");
		append(badge, createTextNode("ok"));
		const { rows } = render(badge, "ascii");
		const grid = cellGrid(rows, 8);

		expect(
			grid[0]
				?.slice(0, 4)
				.map(cell => cell.ch)
				.join(""),
		).toBe("[ok]");
	});

	it("uses preset glyph fallbacks and the frozen paint clock", () => {
		const icon = createElementNode("icon");
		icon.props.name = "tool.bash";
		expect(render(icon, "ascii").rich.rowText(0)).toBe("$");

		const spinner = createElementNode("spinner");
		expect(render(spinner, "ascii", 0).rich.rowText(0)).toBe("|");
		expect(render(createElementNode("spinner"), "ascii", 80).rich.rowText(0)).toBe("/");

		const shimmerAtRest = createElementNode("shimmer");
		append(shimmerAtRest, createTextNode("x"));
		const low = render(shimmerAtRest, "unicode", 0).rich.style[0]?.fg;
		const shimmerAtCrest = createElementNode("shimmer");
		append(shimmerAtCrest, createTextNode("x"));
		const high = render(shimmerAtCrest, "unicode", 333).rich.style[0]?.fg;
		expect(low).not.toBe(high);
	});

	it("formats duration and relative timestamp text without reading wall time", () => {
		const duration = createElementNode("duration");
		duration.props.ms = 1_250;
		expect(render(duration).rich.rowText(0)).toBe("1.3s");

		const timestamp = createElementNode("timestamp");
		timestamp.props.at = 0;
		expect(render(timestamp, "unicode", 3_600_000).rich.rowText(0)).toBe("1h ago");
	});

	it("status returns the shared timer gauge to baseline on detach", () => {
		resetCounters();
		const node = createElementNode("status");
		node.props.value = "running";
		const clock = createClock({ now: () => 80 });
		const root = createHostRoot({
			theme: loadThemeSync("dark", { mode: "truecolor" }),
			subscribeClock: (cadence, listener) => clock.subscribe(cadence, listener),
		});
		append(root.node, node);
		const context = hostContextFor(root);

		expect(counters().timers).toBe(0);
		statusElement.onAttach?.(node, context);
		expect(counters().timers).toBe(1);
		statusElement.onDetach?.(node);
		expect(counters().timers).toBe(0);
		clock.dispose();
		resetCounters();
	});
});
