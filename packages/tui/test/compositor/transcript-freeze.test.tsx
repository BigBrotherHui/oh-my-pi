import { expect, test, vi } from "bun:test";
import { Terminal } from "@oh-my-pi/pi-utils/vterm";
import type { BorrowedTerminalSession } from "../../src/host/elements/terminal";
import { createTranscriptStore, TranscriptView } from "../../src/chat/transcript-store";
import { TranscriptController } from "../../src/compositor/transcript";
import { createPaintContext } from "../../src/host/paint";
import { createClock, useClock } from "../../src/reactive/clock";
import { resolveStyle } from "../../src/style/cascade";
import { mountForTest } from "../../src/testing";

function ReactiveClockLabel() {
	const now = useClock("second");
	return <text>clock {now()}</text>;
}

test("retiring header clocks does not freeze clocks in the active composer", () => {
	vi.useFakeTimers();
	let now = 10_000;
	const clock = createClock({ now: () => now });
	const store = createTranscriptStore();
	const root = mountForTest(
		() => (
			<stack>
				<TranscriptView store={store} header={() => <ReactiveClockLabel />} />
				<ReactiveClockLabel />
			</stack>
		),
		{ clock },
	);
	try {
		root.text();
		const stack = root.root.node.children[0];
		const node =
			stack?.kind === "element"
				? stack.children.find(child => child.kind === "element" && child.tag === "transcript")
				: undefined;
		if (node?.kind !== "element" || !(node.state instanceof TranscriptController))
			throw new Error("Missing transcript controller");
		const context = createPaintContext(root.root, child => resolveStyle(child, { theme: root.root.theme }), { now });
		const history = node.state.peekFlushBatch(80, context);
		if (!history) throw new Error("Missing header history");
		node.state.acknowledgeHistory(history.id);
		now = 11_000;
		vi.advanceTimersByTime(1_000);
		expect(root.text()).toEqual(["clock 11000"]);
		expect(root.counters().timers).toBe(1);
	} finally {
		root.dispose();
		clock.dispose();
		vi.useRealTimers();
	}
});

test("retired terminals replay their final rows without resizing or observing the old session", () => {
	const terminal = new Terminal({ cols: 40, rows: 2 });
	terminal.write("terminal-old");
	let subscriptions = 0;
	let resizes = 0;
	const session: BorrowedTerminalSession = {
		terminal,
		attach() {
			subscriptions++;
			return () => {
				subscriptions--;
			};
		},
		resize(columns, rows) {
			resizes++;
			terminal.resize(columns, rows);
		},
	};
	const store = createTranscriptStore();
	store.append({ id: "terminal", state: "settled", view: () => <terminal session={session} rows={2} /> });
	const root = mountForTest(() => <TranscriptView store={store} />, { width: 40 });
	const context = () =>
		createPaintContext(root.root, node => resolveStyle(node, { theme: root.root.theme }), { now: 0 });
	try {
		expect(root.text().join("\n")).toContain("terminal-old");
		const node = root.root.node.children.find(child => child.kind === "element" && child.tag === "transcript");
		if (node?.kind !== "element" || !(node.state instanceof TranscriptController))
			throw new Error("Missing transcript controller");
		const history = node.state.peekFlushBatch(40, context());
		if (!history) throw new Error("Missing terminal history");
		node.state.acknowledgeHistory(history.id);
		const retiredResizes = resizes;
		expect(subscriptions).toBe(0);
		terminal.write("\rterminal-new");
		node.state.beginReplay();
		const replay = node.state.peekReplayBatch(20, context());
		if (!replay) throw new Error("Missing terminal replay");
		const text = Bun.stripANSI(replay.rows.join("\n"));
		expect(text).toContain("terminal-old");
		expect(text).not.toContain("terminal-new");
		expect(resizes).toBe(retiredResizes);
		expect(subscriptions).toBe(0);
	} finally {
		root.dispose();
		terminal.dispose();
	}
});

test("retired status and timed rows replay at a new width without restarting clocks", () => {
	let now = 80_000;
	const clock = createClock({ now: () => now });
	const store = createTranscriptStore();
	store.append({
		id: "completed-card",
		state: "settled",
		view: () => (
			<frame
				title={
					<row gap={1}>
						<status value="success" />
						<text>Completed work</text>
					</row>
				}
			>
				<text>
					<spinner /> <timestamp at={0} /> <shimmer>stable body</shimmer>
				</text>
				<ReactiveClockLabel />
				<sized
					paint={width => (
						<text>
							<status value="done" /> width {width}
						</text>
					)}
				/>
			</frame>
		),
	});
	const root = mountForTest(() => <TranscriptView store={store} />, { width: 44, clock });
	const context = () => createPaintContext(root.root, node => resolveStyle(node, { theme: root.root.theme }), { now });
	try {
		root.rows();
		const node = root.root.node.children.find(child => child.kind === "element" && child.tag === "transcript");
		if (node?.kind !== "element" || !(node.state instanceof TranscriptController))
			throw new Error("Missing transcript controller");
		const history = node.state.peekFlushBatch(44, context());
		if (!history) throw new Error("Settled card did not produce history");
		expect(Bun.stripANSI(history.rows.join("\n"))).toContain("1m ago");
		node.state.acknowledgeHistory(history.id);
		expect(root.counters().timers).toBe(0);

		now = 800_000;
		node.state.beginReplay();
		const replay = node.state.peekReplayBatch(30, context());
		if (!replay) throw new Error("Committed card did not replay");
		const text = Bun.stripANSI(replay.rows.join("\n"));
		expect(text).toContain("Completed work");
		expect(text).toContain("1m ago");
		expect(text).toContain("stable body");
		expect(text).not.toContain("13m ago");
		expect(root.counters().timers).toBe(0);
		for (const row of replay.rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(30);
	} finally {
		root.dispose();
		clock.dispose();
	}
});
