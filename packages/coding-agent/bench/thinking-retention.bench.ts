import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { heapStats } from "bun:jsc";
import { Settings } from "../src/config/settings";
import { AssistantMessageView } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { createSignal } from "@oh-my-pi/pi-tui/reactive";
import { mountSnapshot, type SnapshotRoot } from "@oh-my-pi/pi-tui/snapshot";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const steps = Number(process.argv[2] ?? 500);
if (!Number.isSafeInteger(steps) || steps <= 0) throw new Error("Expected a positive publication count");
await initTheme(false);
await Settings.init({ inMemory: true });

function stream(count: number): SnapshotRoot {
	const initial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "benchmark",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	const [message, setMessage] = createSignal(initial);
	const root = mountSnapshot(
		() => AssistantMessageView({ message, transient: true, expanded: true, proseOnlyThinking: false }),
		{ columns: 100 },
	);
	let thinking = "";
	try {
		for (let step = 0; step < count; step++) {
			thinking += `Paragraph ${step}: consider **correctness**, memory use, and terminal replay before selecting an implementation.\n\n`;
			setMessage({ ...initial, content: [{ type: "thinking", thinking: `${thinking}Pending paragraph` }] });
			root.frame();
		}
		return root;
	} catch (error) {
		root.dispose();
		throw error;
	}
}

stream(20).dispose();
Bun.gc(true);
const before = heapStats().heapSize;
const started = performance.now();
const cpuStarted = process.cpuUsage();
const root = stream(steps);
try {
	const elapsedMs = performance.now() - started;
	const cpu = process.cpuUsage(cpuStarted);
	Bun.gc(true);
	const retainedBytes = heapStats().heapSize - before;
	const replayStarted = performance.now();
	const replayRows = root.frame(50).rows;
	console.log(
		JSON.stringify({
			steps,
			retainedBytes,
			elapsedMs,
			cpuMs: (cpu.user + cpu.system) / 1000,
			replayRows,
			replayMs: performance.now() - replayStarted,
		}),
	);
} finally {
	root.dispose();
}
