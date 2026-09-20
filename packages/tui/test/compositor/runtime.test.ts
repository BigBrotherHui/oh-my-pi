import { describe, expect, test } from "bun:test";
import { Compositor } from "../../src/compositor/compositor";
import { Style } from "../../src/core/style";
import { counters, resetCounters } from "../../src/instrumentation";
import { Portal } from "../../src/host/overlay";
import { registerElement } from "../../src/host/registry";
import {
	createComponent,
	createElement,
	createTextNode,
	insert,
	insertNode,
	render as renderHost,
	setProp,
} from "../../src/host/renderer";
import { Damage, type ElementImpl, type HostElement } from "../../src/host/types";
import { createClock, useClock, type Clock } from "../../src/reactive/clock";
import { createSignal, getOwner, type JSX, type Setter } from "../../src/reactive";
import { render } from "../../src/root";
import { loadThemeSync } from "../../src/theme/loader";
import { initThemeSync } from "../../src/theme/theme";
import { TUI, type RenderScheduler, type RenderTimer } from "../../src/tui";
import { cellGrid } from "../cell-grid";
import { VirtualTerminal } from "../virtual-terminal";
import "../../src/host/elements/transcript";
import "../../src/host/elements/transcript-block";

initThemeSync(undefined, undefined, "dark", "light");
const testTheme = loadThemeSync("dark");
const paintCounts = new Map<number, number>();

const immediateScheduler: RenderScheduler = {
	now: () => 0,
	scheduleImmediate(callback: () => void): void {
		callback();
	},
	scheduleRender(callback: () => void): RenderTimer {
		callback();
		return { cancel() {} };
	},
};

const testStack: ElementImpl = {
	tag: "compositor-test-stack",
	propDamage: () => Damage.Layout,
	paint(node, out, width, ctx) {
		for (const child of node.children) ctx.paintChild(child, out, width);
	},
};

const countingLine: ElementImpl = {
	tag: "compositor-test-counting-line",
	propDamage: () => Damage.Paint,
	paint(node, out, _width, ctx) {
		paintCounts.set(node.id, (paintCounts.get(node.id) ?? 0) + 1);
		ctx.paintInlineChildren(node, out, Style.NONE);
		out.br();
	},
};

const clockLine: ElementImpl = {
	tag: "compositor-test-clock-line",
	propDamage: () => Damage.Paint,
	paint(_node, out, width, ctx) {
		out.push(Style.NONE, `${ctx.now}:${width}`);
		out.br();
	},
};

const baseSurface: ElementImpl = {
	tag: "compositor-test-base",
	propDamage: () => Damage.Paint,
	paint(_node, out) {
		out.push(Style.NONE, "aaaaaaaaaa");
		out.br();
		out.push(Style.NONE, "bbbbbbbbbb");
		out.br();
		out.push(Style.NONE, "cccccccccc");
		out.br();
	},
};

const overlaySurface: ElementImpl = {
	tag: "compositor-test-overlay",
	propDamage: () => Damage.Paint,
	paint(_node, out) {
		out.push(Style.NONE, "ZZZZ");
		out.br();
	},
};

registerElement(testStack);
registerElement(countingLine);
registerElement(clockLine);
registerElement(baseSurface);
registerElement(overlaySurface);

interface MountedCompositor {
	readonly compositor: Compositor;
	readonly tui: TUI;
	readonly clock: Clock;
	dispose(): void;
}

function mountCompositor(
	view: () => JSX.Element,
	options: { columns?: number; rows?: number; now?: () => number; attachProvider?: boolean } = {},
): MountedCompositor {
	const terminal = new VirtualTerminal(options.columns ?? 20, options.rows ?? 5);
	const tui = new TUI(terminal, undefined, { renderScheduler: immediateScheduler });
	const clock = createClock({ now: options.now });
	const compositor = new Compositor({ tui, theme: () => testTheme, clock });
	const disposeView = renderHost(() => {
		const owner = getOwner();
		if (owner === null) throw new Error("test compositor has no Solid owner");
		compositor.setOwner(owner);
		return view();
	}, compositor.root.node);
	if (options.attachProvider !== false) tui.setFrameProvider(compositor.provider);
	return {
		compositor,
		tui,
		clock,
		dispose() {
			disposeView();
			compositor.dispose();
			clock.dispose();
			tui.setFrameProvider(undefined, false);
			tui.stop();
		},
	};
}

function plainHistory(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row));
}

describe("retained compositor", () => {
	test("a signal write repaints only its dirty block", () => {
		paintCounts.clear();
		let writeFirst: Setter<string> | undefined;
		let first: HostElement | undefined;
		let second: HostElement | undefined;
		const mounted = mountCompositor(() => {
			const [readFirst, setFirst] = createSignal("first");
			writeFirst = setFirst;
			const parent = createElement("compositor-test-stack") as HostElement;
			first = createElement("compositor-test-counting-line") as HostElement;
			second = createElement("compositor-test-counting-line") as HostElement;
			insert(first, readFirst);
			insert(second, "second");
			insertNode(parent, first);
			insertNode(parent, second);
			return parent as unknown as JSX.Element;
		});
		const firstBefore = paintCounts.get(first!.id);
		const secondBefore = paintCounts.get(second!.id);

		writeFirst?.("changed");

		expect(paintCounts.get(first!.id)).toBe((firstBefore ?? 0) + 1);
		expect(paintCounts.get(second!.id)).toBe(secondBefore);
		mounted.dispose();
	});

	test("growing and shrinking frames commit only settled transcript blocks", () => {
		const mounted = mountCompositor(
			() => {
				const transcript = createElement("transcript") as HostElement;
				const settled = createElement("transcript-block") as HostElement;
				setProp(settled, "settled", true);
				insertNode(settled, createTextNode("settled-one\nsettled-two"));
				const active = createElement("transcript-block") as HostElement;
				insertNode(active, createTextNode("active-one\nactive-two"));
				insertNode(transcript, settled);
				insertNode(transcript, active);
				return transcript as unknown as JSX.Element;
			},
			{ rows: 3, attachProvider: false },
		);
		const first = mounted.compositor.compose({ columns: 20, rows: 3 });
		expect(plainHistory(first.history?.rows ?? [])).toEqual(["settled-one", "settled-two", ""]);
		expect(plainHistory(first.history?.rows ?? []).some(row => row.includes("active"))).toBe(false);
		expect(first.viewport.text.join("")).not.toContain("settled");
		expect(first.viewport.text.join("")).toContain("active-one");
		mounted.compositor.acknowledgeHistory(first.history!.id);

		const transcript = mounted.compositor.root.node.children[0] as HostElement;
		const active = transcript.children[1] as HostElement;
		const text = active.children[0]!;
		if (text.kind !== "text") throw new Error("active fixture did not retain its text node");
		text.text = "active-one\nactive-two\nactive-three";
		text.damage = Damage.Text;
		active.damage = Damage.Text;
		transcript.damage = Damage.Text;
		mounted.compositor.root.node.damage = Damage.Text;
		expect(mounted.compositor.compose({ columns: 20, rows: 2 }).history).toBeUndefined();
		text.text = "active-one";
		text.damage = Damage.Text;
		active.damage = Damage.Text;
		transcript.damage = Damage.Text;
		mounted.compositor.root.node.damage = Damage.Text;
		expect(mounted.compositor.compose({ columns: 20, rows: 5 }).history).toBeUndefined();
		mounted.dispose();
	});

	test("width replay is deterministic against a frozen clock", () => {
		const mounted = mountCompositor(
			() => {
				const transcript = createElement("transcript") as HostElement;
				const settled = createElement("transcript-block") as HostElement;
				setProp(settled, "settled", true);
				insertNode(settled, createElement("compositor-test-clock-line"));
				const active = createElement("transcript-block") as HostElement;
				insertNode(active, createTextNode("live-one\nlive-two"));
				insertNode(transcript, settled);
				insertNode(transcript, active);
				return transcript as unknown as JSX.Element;
			},
			{ rows: 2, now: () => 1_234, attachProvider: false },
		);
		const committed = mounted.compositor.compose({ columns: 10, rows: 2 });
		expect(plainHistory(committed.history?.rows ?? [])[0]).toBe("1234:10");
		mounted.compositor.acknowledgeHistory(committed.history!.id);
		mounted.compositor.beginHistoryReplay();
		const replay = mounted.compositor.compose({ columns: 5, rows: 2 });
		const repeated = mounted.compositor.compose({ columns: 5, rows: 2 });
		expect(replay.history?.kind).toBe("replay");
		expect(replay.history).toEqual(repeated.history);
		expect(plainHistory(replay.history?.rows ?? [])[0]).toBe("1234:5");
		mounted.dispose();
	});

	test("committing a settled block freezes its clock-owned descendants", () => {
		resetCounters();
		const mounted = mountCompositor(
			() => {
				const transcript = createElement("transcript") as HostElement;
				const settled = createElement("transcript-block") as HostElement;
				setProp(settled, "settled", true);
				insertNode(settled, createElement("spinner"));
				const active = createElement("transcript-block") as HostElement;
				insertNode(active, createTextNode("active-one\nactive-two"));
				insertNode(transcript, settled);
				insertNode(transcript, active);
				return transcript as unknown as JSX.Element;
			},
			{ rows: 2, attachProvider: false },
		);
		expect(counters().timers).toBe(1);
		const plan = mounted.compositor.compose({ columns: 20, rows: 2 });
		expect(plan.history).toBeDefined();
		mounted.compositor.acknowledgeHistory(plan.history!.id);
		expect(counters().timers).toBe(0);
		mounted.dispose();
	});

	test("render and dispose release shared clock timers", () => {
		resetCounters();
		const terminal = new VirtualTerminal(20, 3);
		const handle = render(
			() => {
				const tick = useClock("spinner");
				const line = createElement("compositor-test-counting-line") as HostElement;
				insert(line, () => String(tick()));
				return line as unknown as JSX.Element;
			},
			{ terminal, theme: testTheme },
		);
		handle.tui.renderNow();
		expect(counters().timers).toBe(1);
		handle.dispose();
		expect(counters().timers).toBe(0);
	});

	test("overlay portals composite over the retained viewport", () => {
		const terminal = new VirtualTerminal(10, 3);
		const handle = render(
			() => {
				createComponent(Portal, {
					to: "overlay",
					width: 4,
					anchor: "center",
					get children() {
						return createElement("compositor-test-overlay") as unknown as JSX.Element;
					},
				});
				return createElement("compositor-test-base") as unknown as JSX.Element;
			},
			{ terminal, theme: testTheme },
		);
		handle.tui.renderNow();
		const grid = cellGrid(terminal.getViewport(), 10);
		expect(grid[1]!.map(cell => cell.ch).join("")).toBe("bbbZZZZbbb");
		handle.dispose();
	});
});
