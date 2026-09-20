/**
 * Benchmark: transcript compose cost vs session depth
 *
 * A long interactive session finalizes assistant blocks and emits their rows
 * into native terminal scrollback. Once committed, those rows are immutable
 * history the terminal owns; the retained transcript controller should drop
 * them from its frame so a live tail mutation does not re-walk sealed history.
 *
 * This bench builds N finalized assistant blocks (prose + closed code fences),
 * commits every finalized row into native scrollback, then times the retirement
 * check and actual terminal render for an unchanged live tail. A display reset
 * also measures committed-history replay through the production writer.
 */

import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../src/config/settings";
import { AssistantMessageView } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { createTranscriptStore, TranscriptView } from "@oh-my-pi/pi-tui/chat/transcript-store";
import { render } from "@oh-my-pi/pi-tui/root";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "@test/tui/virtual-terminal";

const WIDTH = 100;
const SIZES = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [500, 5000, 50_000];
if (SIZES.some(size => !Number.isSafeInteger(size) || size < 1)) throw new Error("Expected positive transcript sizes");
const WARMUP = 20;
const SAMPLES = 200;

function makeMarkdownCorpus(targetGraphemes: number): string {
	const para =
		"The quick brown fox jumps over the lazy dog while 🚀 emoji and a `code span` " +
		"plus **bold** and _italic_ text exercise the markdown lexer and the grapheme segmenter. ";
	const codeBlock = "\n```ts\nconst x: number = compute(a, b) + delta;\nreturn x.toFixed(2);\n```\n\n";
	const list = "\n- first bullet item\n- second bullet item with `inline`\n- third\n\n";
	let out = "";
	let i = 0;
	while (out.length < targetGraphemes) {
		out += `## Section ${++i}\n\n${para}${para}${codeBlock}${list}`;
	}
	return out.slice(0, targetGraphemes);
}

function makeTextMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "bench",
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
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx]!;
}

/** Build N committed finalized blocks + a live tail, return per-tick render medians/p95. */
function measure(n: number): { median: number; p95: number; replayMs: number } {
	const store = createTranscriptStore();
	const history = makeTextMessage(makeMarkdownCorpus(240));
	for (let index = 0; index < n; index++) {
		store.append({
			id: `history-${index}`,
			state: "settled",
			view: () => AssistantMessageView({ message: history, expanded: false }),
		});
	}
	const tail = makeTextMessage("Live answer in progress.");
	store.append({ id: "tail", view: () => AssistantMessageView({ message: tail, transient: true, expanded: false }) });
	const terminal = new VirtualTerminal(WIDTH, 24);
	const root = render(() => TranscriptView({ store }), { terminal, theme });
	try {
		root.tui.renderNow();
		for (let index = 0; index < WARMUP; index++) root.tui.renderNow();
		const samples: number[] = [];
		for (let index = 0; index < SAMPLES; index++) {
			const start = Bun.nanoseconds();
			root.tui.renderNow();
			samples.push((Bun.nanoseconds() - start) / 1e6);
		}
		samples.sort((left, right) => left - right);
		const before = terminal.getViewport().map(row => row.trimEnd());
		const started = Bun.nanoseconds();
		root.tui.resetDisplay();
		root.tui.renderNow();
		const replayMs = (Bun.nanoseconds() - started) / 1e6;
		if (
			terminal
				.getViewport()
				.map(row => row.trimEnd())
				.join("\n") !== before.join("\n")
		)
			throw new Error("History replay changed the live semantic tail");
		return { median: percentile(samples, 50), p95: percentile(samples, 95), replayMs };
	} finally {
		root.dispose();
	}
}

await Settings.init({ inMemory: true });
await initTheme();

console.log(`\nBenchmark: transcript-compose (live tail tick after committed finalized history, width ${WIDTH})\n`);

const results = SIZES.map(n => {
	const r = measure(n);
	console.log(
		`  N=${n}: median ${r.median.toFixed(4)}ms  p95 ${r.p95.toFixed(4)}ms  replay ${r.replayMs.toFixed(4)}ms`,
	);
	return r;
});

const small = results[0]!;
const large = results[results.length - 1]!;
const ratio = large.median / small.median;
console.log(
	`\n  ratio(N${SIZES[SIZES.length - 1]}/N${SIZES[0]}) median = ${ratio.toFixed(3)}  ` +
		`(N${SIZES[SIZES.length - 1]} p95 = ${large.p95.toFixed(4)}ms)\n`,
);
