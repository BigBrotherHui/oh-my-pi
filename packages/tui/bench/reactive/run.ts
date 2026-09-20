import { createDocument } from "../../src/document/document";
import { type Counters, counters, resetCounters } from "../../src/instrumentation";
import { createMemo, createRoot, createSignal } from "../../src/reactive";
import budgets from "./budgets.json" with { type: "json" };
import {
	type AgentTreeFixture,
	createAgentTreeFixture,
	createLogDocumentFixture,
	createStreamingFixture,
	createTranscriptFixture,
} from "./fixtures";

interface Measurement {
	readonly elapsedMs: number;
	readonly counters: Counters;
}

interface Scenario {
	readonly name: keyof typeof budgets.scenarios;
	readonly run: () => void;
}

const EPISODES = 5;

function findAgent(root: AgentTreeFixture, id: string): AgentTreeFixture | undefined {
	if (root.id === id) return root;
	for (const child of root.children) {
		const match = findAgent(child, id);
		if (match) return match;
	}
	return undefined;
}

const scenarios: readonly Scenario[] = [
	{
		name: "largeTranscript",
		run: () => {
			const blocks = createTranscriptFixture();
			if (blocks.length !== 2_000) throw new Error("Transcript fixture must contain 2,000 blocks");
			createRoot(dispose => {
				const [tail, setTail] = createSignal(blocks.at(-1)!.text);
				const activeTail = createMemo(() => `${blocks.length}:${tail()}`);
				for (let update = 0; update < 1_000; update++) {
					setTail(`Block 1999 streaming revision ${update}`);
					activeTail();
				}
				if (!activeTail().endsWith("999")) throw new Error("Transcript tail did not update");
				dispose();
			});
		},
	},
	{
		name: "logDocument",
		run: () => {
			const document = createDocument(createLogDocumentFixture());
			if (document.lineCount() !== 50_000) throw new Error("Log fixture must contain 50,000 lines");
			for (let line = 0; line < 50_000; line += 50) document.line(line);
			document.apply({ kind: "append", text: "\n50000 INFO benchmark append" });
			if (document.lineCount() !== 50_001) throw new Error("Log document line index lost an appended line");
		},
	},
	{
		name: "agentTree",
		run: () => {
			const tree = createAgentTreeFixture();
			if (findAgent(tree, "agent-199") === undefined) throw new Error("Agent fixture must contain 200 nodes");
			createRoot(dispose => {
				const [selected, setSelected] = createSignal("agent-0");
				const selectedAgent = createMemo(() => findAgent(tree, selected()));
				for (let index = 0; index < 200; index++) {
					setSelected(`agent-${index}`);
					if (selectedAgent()?.id !== `agent-${index}`) throw new Error(`Agent ${index} was not retained`);
				}
				dispose();
			});
		},
	},
	{
		name: "rapidStreaming",
		run: () => {
			const document = createDocument();
			const chunks = createStreamingFixture();
			if (chunks.length !== 1_000) throw new Error("Streaming fixture must contain 1,000 chunks");
			let notifications = 0;
			const unsubscribe = document.subscribe(() => notifications++);
			for (const text of chunks) document.apply({ kind: "append", text });
			unsubscribe();
			if (notifications !== chunks.length) throw new Error("Streaming document dropped append notifications");
		},
	},
];

function measure(run: () => void): Measurement {
	resetCounters();
	const started = Bun.nanoseconds();
	run();
	return { elapsedMs: (Bun.nanoseconds() - started) / 1e6, counters: counters() };
}

let failed = false;
for (const scenario of scenarios) {
	measure(scenario.run);
	const samples = new Array<Measurement>(EPISODES);
	for (let episode = 0; episode < EPISODES; episode++) samples[episode] = measure(scenario.run);
	samples.sort((left, right) => left.elapsedMs - right.elapsedMs);
	const median = samples[Math.floor(samples.length / 2)]!;
	const budgetMs = budgets.scenarios[scenario.name].budgetMs;
	const status = median.elapsedMs <= budgetMs ? "PASS" : "FAIL";
	if (status === "FAIL") failed = true;
	console.log(
		`${status} ${scenario.name}: median=${median.elapsedMs.toFixed(3)}ms budget=${budgetMs.toFixed(3)}ms counters=${JSON.stringify(median.counters)}`,
	);
}

if (failed) process.exitCode = 1;
