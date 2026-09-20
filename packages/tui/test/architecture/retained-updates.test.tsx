import { describe, expect, test } from "bun:test";
import { TranscriptController } from "../../src/compositor/transcript";
import { createDocument } from "../../src/document/document";
import { markDamage } from "../../src/host/damage";
import { createPaintContext } from "../../src/host/paint";
import { Damage } from "../../src/host/types";
import "../../src/host/elements/code";
import "../../src/host/elements/pre";
import "../../src/host/elements/spinner";
import "../../src/host/elements/status";
import "../../src/host/elements/text";
import "../../src/host/elements/transcript";
import "../../src/host/elements/transcript-block";
import { counters, resetCounters } from "../../src/instrumentation";
import { type Accessor, type ClockCadence, type ClockSnapshot, createSignal } from "../../src/reactive";
import { resolveStyle } from "../../src/style/cascade";
import { loadThemeSync } from "../../src/theme/loader";
import { type FakeClock, mountForTest } from "../../src/testing";

class ManualClock implements FakeClock {
	readonly frameMs = 1_000 / 30;
	private current = 0;
	private snapshot: ClockSnapshot = { at: 0, frame: 0, spinner: 0, second: 0 };
	private readonly listeners: Record<ClockCadence, Set<(now: number) => void>> = {
		frame: new Set(),
		spinner: new Set(),
		second: new Set(),
	};

	readonly now = (): number => this.current;

	access(_cadence: ClockCadence): Accessor<number> {
		return () => this.current;
	}

	subscribe(cadence: ClockCadence, listener: (now: number) => void): () => void {
		this.listeners[cadence].add(listener);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			this.listeners[cadence].delete(listener);
		};
	}

	freeze(at = this.current): ClockSnapshot {
		this.snapshot = {
			at,
			frame: Math.floor(at / this.frameMs),
			spinner: Math.floor(at / 80),
			second: Math.floor(at / 1_000),
		};
		return this.snapshot;
	}

	frozen(): ClockSnapshot {
		return this.snapshot;
	}

	advance(ms: number): void {
		this.current += ms;
		for (const cadence of ["frame", "spinner", "second"] as const) {
			for (const listener of this.listeners[cadence]) listener(this.current);
		}
	}

	subscriberCount(cadence: ClockCadence): number {
		return this.listeners[cadence].size;
	}

	dispose(): void {
		for (const cadence of ["frame", "spinner", "second"] as const) this.listeners[cadence].clear();
	}
}

describe.serial("retained reactive update architecture", () => {
	test("spinner ticks repaint without rerunning the view or parsing", () => {
		const clock = new ManualClock();
		const root = mountForTest(() => <spinner />, { clock });
		root.flush();
		const before = root.counters();
		clock.advance(80);
		root.flush();
		const after = root.counters();
		expect(after.viewRuns).toBe(before.viewRuns);
		expect(after.parses).toBe(before.parses);
		expect(after.paints).toBeGreaterThan(before.paints);
		root.dispose();
		clock.dispose();
	});

	test("controlled status and spinner frames unsubscribe while frozen and resume ticking", () => {
		const clock = new ManualClock();
		const [frame, setFrame] = createSignal<number | undefined>(0);
		const root = mountForTest(
			() => (
				<>
					<spinner frame={frame()} />
					<status value="running" frame={frame()} />
				</>
			),
			{ clock },
		);
		root.flush();
		expect(clock.subscriberCount("spinner")).toBe(0);

		const frozenRows = root.text();
		clock.advance(240);
		root.flush();
		expect(root.text()).toEqual(frozenRows);
		expect(clock.subscriberCount("spinner")).toBe(0);

		setFrame(undefined);
		root.flush();
		expect(clock.subscriberCount("spinner")).toBe(2);
		const before = root.counters();
		clock.advance(80);
		root.flush();
		expect(root.counters().paints).toBeGreaterThan(before.paints);

		setFrame(1);
		root.flush();
		expect(clock.subscriberCount("spinner")).toBe(0);
		root.dispose();
		clock.dispose();
	});

	test("one entity field update creates no nodes and preserves its unrelated sibling", () => {
		const [label, setLabel] = createSignal("first");
		const root = mountForTest(() => (
			<>
				<text>{label()}</text>
				<text>stable sibling</text>
			</>
		));
		root.flush();
		const sibling = root.root.node.children[1];
		const before = root.counters();
		setLabel("updated");
		root.flush();
		const after = root.counters();
		expect(after.nodesCreated).toBe(before.nodesCreated);
		expect(root.root.node.children[1]).toBe(sibling);
		expect(root.text()).toEqual(["updated", "stable sibling"]);
		root.dispose();
	});

	test("document append preserves the retained document element identity", () => {
		const document = createDocument("alpha");
		const root = mountForTest(() => <pre document={document} />);
		root.flush();
		const element = root.root.node.children[0];
		document.apply({ kind: "append", text: "\nbeta" });
		root.flush();
		expect(root.root.node.children[0]).toBe(element);
		expect(root.text()).toEqual(["alpha", "beta"]);
		root.dispose();
	});

	test("committing a transcript block drops its clock subscriptions", () => {
		const clock = new ManualClock();
		const root = mountForTest(
			() => (
				<transcript>
					<transcript-block settled>
						<spinner />
					</transcript-block>
				</transcript>
			),
			{ clock, width: 80 },
		);
		root.flush();
		expect(clock.subscriberCount("spinner")).toBe(1);
		const transcript = root.root.node.children[0];
		if (transcript?.kind !== "element" || !(transcript.state instanceof TranscriptController)) {
			throw new Error("Expected a mounted transcript controller");
		}
		const context = createPaintContext(root.root, node => resolveStyle(node, { theme: root.root.theme }), {
			now: clock.freeze().at,
		});
		const batch = transcript.state.peekFlushBatch(80, context);
		if (batch === undefined) throw new Error("Expected settled transcript rows to be committable");
		transcript.state.acknowledgeHistory(batch.id);
		expect(transcript.state.blockStates()).toEqual(["committed"]);
		expect(clock.subscriberCount("spinner")).toBe(0);
		root.dispose();
		clock.dispose();
	});

	test("palette-only theme damage does not reparse a code document", () => {
		const document = createDocument("const answer = 42;");
		const root = mountForTest(() => <code document={document} language="typescript" />, {
			theme: loadThemeSync("dark"),
		});
		root.flush();
		const before = root.counters();
		root.root.theme = loadThemeSync("light");
		markDamage(root.root.node, Damage.Paint);
		root.flush();
		const after = root.counters();
		expect(after.parses).toBe(before.parses);
		expect(after.paints).toBeGreaterThan(before.paints);
		root.dispose();
	});

	test("repeated mount and unmount returns owner and timer gauges to baseline", () => {
		resetCounters();
		const baseline = counters();
		for (let iteration = 0; iteration < 25; iteration++) {
			const root = mountForTest(() => <text>cycle {iteration}</text>);
			root.flush();
			expect(root.counters().owners).toBe(baseline.owners + 1);
			root.dispose();
			expect(counters().owners).toBe(baseline.owners);
			expect(counters().timers).toBe(baseline.timers);
		}
	});
});
