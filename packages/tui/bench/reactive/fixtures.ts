export interface TranscriptBlockFixture {
	readonly id: string;
	readonly role: "assistant" | "tool" | "user";
	readonly text: string;
	readonly settled: boolean;
}

export interface AgentTreeFixture {
	readonly id: string;
	readonly label: string;
	readonly status: "idle" | "running" | "done";
	readonly children: AgentTreeFixture[];
}

/** Build the 2,000-block transcript workload used by the reactive benchmark. */
export function createTranscriptFixture(blockCount = 2_000): TranscriptBlockFixture[] {
	const blocks = new Array<TranscriptBlockFixture>(blockCount);
	for (let index = 0; index < blockCount; index++) {
		const role = index % 5 === 0 ? "tool" : index % 7 === 0 ? "user" : "assistant";
		blocks[index] = {
			id: `block-${index}`,
			role,
			text: `Block ${index}: retained transcript content with a stable committed prefix and live tail.`,
			settled: index < blockCount - 1,
		};
	}
	return blocks;
}

/** Build a 50,000-line log document with representative paths, statuses, and Unicode. */
export function createLogDocumentFixture(lineCount = 50_000): string {
	const lines = new Array<string>(lineCount);
	for (let index = 0; index < lineCount; index++) {
		const level = index % 29 === 0 ? "ERROR" : index % 11 === 0 ? "WARN" : "INFO";
		lines[index] =
			`${index.toString().padStart(5, "0")} ${level} worker-${index % 32} packages/tui/src/view/item-${index % 211}.tsx café 🚀`;
	}
	return lines.join("\n");
}

/** Build a deterministic nested agent tree containing exactly `nodeCount` nodes. */
export function createAgentTreeFixture(nodeCount = 200): AgentTreeFixture {
	if (nodeCount < 1) throw new RangeError("Agent tree must contain at least one node");
	const nodes = new Array<AgentTreeFixture>(nodeCount);
	for (let index = 0; index < nodeCount; index++) {
		nodes[index] = {
			id: `agent-${index}`,
			label: `Agent ${index}`,
			status: index % 13 === 0 ? "done" : index % 3 === 0 ? "running" : "idle",
			children: [],
		};
	}
	for (let index = 1; index < nodeCount; index++) {
		const parent = Math.floor((index - 1) / 3);
		nodes[parent]!.children.push(nodes[index]!);
	}
	return nodes[0]!;
}

/** Build 1,000 chunks that exercise append-heavy streaming with split markup and graphemes. */
export function createStreamingFixture(chunkCount = 1_000): string[] {
	const fragments = ["text ", "**bold", "** ", "café ", "👨‍👩‍👧‍👦 ", "`code`, ", "\n", "[link]", "(https://omp.sh) "];
	const chunks = new Array<string>(chunkCount);
	for (let index = 0; index < chunkCount; index++) chunks[index] = `${fragments[index % fragments.length]}${index}`;
	return chunks;
}
