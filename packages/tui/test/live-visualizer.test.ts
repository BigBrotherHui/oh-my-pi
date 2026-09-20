import { describe, expect, it } from "bun:test";
import { type LivePhase, LiveVisualizerView } from "../src/apps/live-visualizer";
import { dispatchKey, HostKeyEvent } from "../src/host/input";
import { createSignal } from "../src/reactive";
import { mountForTest } from "../src/testing";
import { visibleWidth } from "../src/utils";

function visualizerState() {
	const [phase, setPhase] = createSignal<LivePhase>("connecting");
	const [inputLevel, setInputLevel] = createSignal(0);
	const [transcript, setTranscript] = createSignal("");
	return { phase, setPhase, inputLevel, setInputLevel, transcript, setTranscript };
}

describe("LiveVisualizerView", () => {
	it("preserves the historical five-row panel at wide and compact widths", () => {
		const state = visualizerState();
		const root = mountForTest(() => LiveVisualizerView({ ...state, onStop() {}, onToggleMute() {} }), { width: 80 });
		try {
			for (const width of [80, 140, 200]) {
				const rows = root.text(width);
				const box = root.root.theme.boxRound;
				expect(rows).toHaveLength(5);
				expect(rows[0]).toBe(`${box.topLeft}${box.horizontal.repeat(width - 2)}${box.topRight}`);
				expect(rows[4]).toContain("○ connecting");
				for (const row of rows) expect(visibleWidth(row)).toBe(width);
			}

			const compact = root.text(3);
			expect(compact).toEqual(["┌─┐", "│ │", "│ │", "│ │", "└─┘"]);
		} finally {
			root.dispose();
		}
	});

	it("renders the live state, sanitizes tail-clipped transcripts, and gates muted audio", () => {
		const state = visualizerState();
		const root = mountForTest(() => LiveVisualizerView({ ...state, onStop() {}, onToggleMute() {} }), { width: 80 });
		try {
			state.setPhase("listening");
			state.setInputLevel(0.5);
			state.setTranscript("first\nsecond    final\n");
			root.flush();

			const listening = root.text();
			expect(listening[2]).toMatch(/[▁▂▃▄▅▆▇█]/);
			expect(listening[4]).toContain("● listening");
			expect(root.text(17)[3]).toBe("│ …second final │");

			state.setPhase("muted");
			root.flush();
			const muted = root.text();
			expect(muted[1]).toBe(`│ ${" ".repeat(76)} │`);
			expect(muted[2]).toBe(`│ ${" ".repeat(76)} │`);
			expect(muted[4]).toContain("× muted");
		} finally {
			root.dispose();
		}
	});

	it("ends on every configured stop chord and toggles mute on space", () => {
		const state = visualizerState();
		let stops = 0;
		let toggles = 0;
		const root = mountForTest(
			() =>
				LiveVisualizerView({
					...state,
					stopKeys: ["ctrl+l"],
					onStop() {
						stops++;
					},
					onToggleMute() {
						toggles++;
					},
				}),
			{ width: 80 },
		);
		try {
			root.text();
			const muteEvent = new HostKeyEvent(" ");
			dispatchKey(root.root, muteEvent);
			expect(toggles).toBe(1);
			expect(muteEvent.defaultPrevented).toBeTrue();

			for (const key of ["\x1b", "\x03", "\x0c"]) {
				const event = new HostKeyEvent(key);
				dispatchKey(root.root, event);
				expect(event.defaultPrevented).toBeTrue();
			}
			expect(stops).toBe(3);
		} finally {
			root.dispose();
		}
	});
});
