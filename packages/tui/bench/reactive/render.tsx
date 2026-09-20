import { createTranscriptStore, TranscriptView } from "../../src/chat/transcript-store";
import { createDocument } from "../../src/document";
import { counters, resetCounters } from "../../src/instrumentation";
import { createSignal, For, type JSX } from "../../src/reactive";
import { render } from "../../src/root";
import { mountSnapshot } from "../../src/snapshot";
import { loadThemeSync } from "../../src/theme/loader";
import { VirtualTerminal } from "@test/tui/virtual-terminal";
import {
	createAgentTreeFixture,
	createLogDocumentFixture,
	createStreamingFixture,
	createTranscriptFixture,
	type AgentTreeFixture,
} from "./fixtures";

import budgets from "./budgets.json" with { type: "json" };

const theme = loadThemeSync("dark");

function requireInvariant(value: boolean, message: string): void {
	if (!value) throw new Error(message);
}

function transcript(): void {
	const store = createTranscriptStore();
	const [tail, setTail] = createSignal("streaming revision 0");
	const fixture = createTranscriptFixture();
	for (const block of fixture) {
		store.append({
			id: block.id,
			state: block.settled ? "settled" : "active",
			view: block.settled ? () => <text>{block.text}</text> : () => <text>{tail()}</text>,
		});
	}
	const terminal = new VirtualTerminal(100, 30);
	const root = render(() => <TranscriptView store={store} />, { terminal, theme });
	try {
		root.tui.renderNow();
		const mounted = counters().nodesCreated;
		for (let update = 1; update <= 100; update++) {
			setTail(`streaming revision ${update}`);
			root.tui.renderNow();
		}
		requireInvariant(counters().nodesCreated === mounted, "Transcript tail updates recreated retained nodes");
		requireInvariant(
			terminal.getViewport().some(row => row.includes("revision 100")),
			"Transcript did not paint its final tail",
		);
	} finally {
		root.dispose();
	}
}

function logDocument(): void {
	const document = createDocument(createLogDocumentFixture());
	const root = mountSnapshot(() => <preview document={document} unit="lines" limit={24} edge="tail" />, {
		columns: 100,
		theme,
	});
	try {
		root.frame();
		const mounted = counters().nodesCreated;
		document.apply({ kind: "append", text: "\n50000 INFO retained log append" });
		const text = root.text().join("\n");
		requireInvariant(text.includes("50000 INFO retained log append"), "Native log preview lost appended text");
		requireInvariant(counters().nodesCreated === mounted, "Appending a log recreated its native preview");
	} finally {
		root.dispose();
	}
}

function AgentNode(props: { readonly node: AgentTreeFixture; readonly active: () => string }): JSX.Element {
	return (
		<stack>
			<text color={props.active() === props.node.id ? "accent" : "muted"}>{props.node.label}</text>
			<tree>
				<For each={props.node.children}>{child => <AgentNode node={child} active={props.active} />}</For>
			</tree>
		</stack>
	);
}

function agentTree(): void {
	const fixture = createAgentTreeFixture();
	const [active, setActive] = createSignal("agent-0");
	const root = mountSnapshot(
		() => (
			<scroll height={24}>
				<AgentNode node={fixture} active={active} />
			</scroll>
		),
		{ columns: 100, theme },
	);
	try {
		root.frame();
		const mounted = counters().nodesCreated;
		for (let index = 1; index < 200; index++) {
			setActive(`agent-${index}`);
			root.frame();
		}
		requireInvariant(counters().nodesCreated === mounted, "Agent selection recreated the keyed tree");
	} finally {
		root.dispose();
	}
}

function rapidStreaming(): void {
	const document = createDocument();
	const root = mountSnapshot(() => <preview document={document} unit="rows" limit={24} edge="tail" />, {
		columns: 100,
		theme,
	});
	try {
		root.frame();
		const mounted = counters().nodesCreated;
		for (const text of createStreamingFixture()) {
			document.apply({ kind: "append", text });
			root.frame();
		}
		requireInvariant(root.text().join("\n").includes("999"), "Native streaming preview lost its last chunk");
		requireInvariant(counters().nodesCreated === mounted, "Streaming document recreated native nodes");
	} finally {
		root.dispose();
	}
}

const scenarios: readonly { readonly name: keyof typeof budgets.renderScenarios; readonly run: () => void }[] = [
	{ name: "transcript", run: transcript },
	{ name: "logDocument", run: logDocument },
	{ name: "agentTree", run: agentTree },
	{ name: "rapidStreaming", run: rapidStreaming },
];
let failed = false;
for (const { name, run } of scenarios) {
	const budgetMs = budgets.renderScenarios[name].budgetMs;
	run();
	const samples: number[] = [];
	for (let episode = 0; episode < 5; episode++) {
		resetCounters();
		const start = Bun.nanoseconds();
		run();
		samples.push((Bun.nanoseconds() - start) / 1e6);
		requireInvariant(counters().timers === 0, `${name} leaked a native animation clock`);
	}
	samples.sort((left, right) => left - right);
	const median = samples[2]!;
	const passed = median <= budgetMs;
	failed ||= !passed;
	console.log(
		`${passed ? "PASS" : "FAIL"} ${name}: median=${median.toFixed(3)}ms budget=${budgetMs}ms ${JSON.stringify(counters())}`,
	);
}
if (failed) process.exitCode = 1;
