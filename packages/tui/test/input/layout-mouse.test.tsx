import { expect, test } from "bun:test";
import { createTranscriptStore, TranscriptView } from "../../src/chat/transcript-store";
import { mountOverlay, Portal } from "../../src/host/overlay";
import type { HostMouseEvent } from "../../src/host/input";
import { createSignal, Show } from "../../src/reactive";
import { render } from "../../src/root";
import { loadThemeSync } from "../../src/theme/loader";
import { VirtualTerminal } from "../virtual-terminal";

function click(terminal: VirtualTerminal, col: number, row: number): void {
	terminal.sendInput(`\x1b[<0;${col + 1};${row + 1}M`);
}

test("mouse hits follow cached panes through padding, scrolling and sibling movement", () => {
	const terminal = new VirtualTerminal(40, 12);
	const [shifted, setShifted] = createSignal(false);
	const [offset, setOffset] = createSignal(1);
	const seen: string[] = [];
	const select = (label: string, event: HostMouseEvent) => seen.push(`${label}:${event.localRow}:${event.localCol}`);
	const root = render(
		() => (
			<stack>
				<Show when={shifted()}>
					<text>inserted header</text>
				</Show>
				<box padding={{ top: 1, left: 2 }}>
					<row gap={2}>
						<box width={8}>
							<text>left</text>
						</box>
						<box width={12}>
							<scroll height={2} offset={offset()} scrollbar="never">
								<text onMouse={event => select("A", event)}>A</text>
								<text onMouse={event => select("B", event)}>B</text>
								<text onMouse={event => select("C", event)}>C</text>
								<text onMouse={event => select("D", event)}>D</text>
							</scroll>
						</box>
					</row>
				</box>
			</stack>
		),
		{ terminal, theme: loadThemeSync("dark") },
	);
	try {
		root.tui.renderNow();
		click(terminal, 13, 1);
		expect(seen).toEqual(["B:0:1"]);
		setShifted(true);
		root.tui.renderNow();
		click(terminal, 13, 1);
		expect(seen).toEqual(["B:0:1"]);
		click(terminal, 13, 2);
		expect(seen).toEqual(["B:0:1", "B:0:1"]);
		setOffset(2);
		root.tui.renderNow();
		click(terminal, 13, 2);
		expect(seen).toEqual(["B:0:1", "B:0:1", "C:0:1"]);
	} finally {
		root.dispose();
	}
});

test("hover leaves a retained control when the pointer exits its painted subtree", () => {
	const terminal = new VirtualTerminal(40, 12);
	const [hovered, setHovered] = createSignal(false);
	const root = render(
		() => (
			<stack>
				<box
					onMouse={event => {
						if (event.action === "move") setHovered(true);
					}}
					onMouseLeave={() => setHovered(false)}
				>
					<text>{hovered() ? "hovered" : "idle"}</text>
				</box>
				<text>outside control</text>
			</stack>
		),
		{ terminal, theme: loadThemeSync("dark") },
	);
	try {
		root.tui.renderNow();
		terminal.sendInput("\x1b[<35;2;1M");
		root.tui.renderNow();
		expect(terminal.getViewport()[0]).toContain("hovered");
		terminal.sendInput("\x1b[<35;2;2M");
		root.tui.renderNow();
		expect(terminal.getViewport()[0]).toContain("idle");
	} finally {
		root.dispose();
	}
});

test("emergency transcript rows only accept input on the visible block", () => {
	const terminal = new VirtualTerminal(30, 2);
	const transcript = createTranscriptStore();
	const selected: string[] = [];
	for (const label of ["first", "second", "third"]) {
		transcript.append({ id: label, view: () => <text onMouse={() => selected.push(label)}>{label}</text> });
	}
	const root = render(() => <TranscriptView store={transcript} />, { terminal, theme: loadThemeSync("dark") });
	try {
		root.tui.renderNow();
		expect(terminal.getViewport()[1]).toContain("third");
		click(terminal, 0, 0);
		expect(selected).toEqual([]);
		click(terminal, 0, 1);
		expect(selected).toEqual(["third"]);
	} finally {
		root.dispose();
	}
});

test("anchored overlay mouse input uses physical screen origin and ignores its border", () => {
	const terminal = new VirtualTerminal(40, 12);
	const root = render(() => <text>main</text>, { terminal, theme: loadThemeSync("dark") });
	const selected: number[] = [];
	const overlay = mountOverlay(root.tui, () => (
		<Portal to="overlay" anchor="bottom-center" width={20} mouseTracking>
			<box
				tabIndex={0}
				onMouse={event => {
					if (event.localRow >= 1 && event.localRow <= 2) selected.push(event.localRow);
				}}
			>
				<frame title="Pick" paddingY={0} borderPolicy="always">
					<text>first</text>
					<text>second</text>
				</frame>
			</box>
		</Portal>
	));
	try {
		root.tui.renderNow();
		click(terminal, 12, 8);
		expect(selected).toEqual([]);
		click(terminal, 12, 9);
		click(terminal, 12, 10);
		expect(selected).toEqual([1, 2]);
	} finally {
		overlay.dispose();
		root.dispose();
	}
});
