import { describe, expect, it } from "bun:test";
import { TranscriptView, createTranscriptStore } from "../src/chat/transcript-store";
import { TranscriptController } from "../src/compositor/transcript";
import { createPaintContext } from "../src/host/paint";
import { resolveStyle } from "../src/style/cascade";
import { mountForTest } from "../src/testing";
import { cellGrid } from "./cell-grid";
import "../src/host/elements/text";
import "../src/host/elements/transcript";
import "../src/host/elements/transcript-block";

describe("reactive transcript acceptance", () => {
	it("trims transparent card breathing room but preserves tinted blank rows", () => {
		const store = createTranscriptStore();
		store.append({
			id: "plain",
			state: "settled",
			view: () => (
				<box padding={{ y: 1 }}>
					<text>plain</text>
				</box>
			),
		});
		store.append({
			id: "tinted",
			state: "settled",
			view: () => (
				<box padding={{ y: 1 }} background="toolSuccessBg">
					<text>tinted</text>
				</box>
			),
		});
		const root = mountForTest(() => <TranscriptView store={store} />, { width: 20 });
		try {
			expect(root.text().map(row => row.trimEnd())).toEqual(["plain", "", "", "tinted", ""]);
			const grid = cellGrid(root.rows(), 20);
			expect(grid[1]!.every(cell => cell.bg === null)).toBe(true);
			expect(grid[2]!.every(cell => cell.bg !== null)).toBe(true);
			expect(grid[4]!.every(cell => cell.bg !== null)).toBe(true);
		} finally {
			root.dispose();
		}
	});
	it("updates a streaming block without replacing settled siblings", () => {
		const store = createTranscriptStore();
		store.append({ id: "settled", state: "settled", view: () => <text>settled</text> });
		store.append({ id: "stream", view: () => <text>partial</text> });
		const root = mountForTest(() => <TranscriptView store={store} />, { width: 30 });
		try {
			root.flush();
			const transcript = root.root.node.children[0];
			if (transcript?.kind !== "element") throw new Error("Expected transcript host element");
			const settledBlock = transcript.children.find(
				node => node.kind === "element" && node.tag === "transcript-block",
			);
			if (settledBlock?.kind !== "element") throw new Error("Expected settled transcript block");
			store.replace("stream", { view: () => <text>complete result</text> });
			expect(root.text(30)).toEqual(["settled", "", "complete result"]);
			expect(transcript.children.find(node => node.kind === "element" && node.tag === "transcript-block")?.id).toBe(
				settledBlock.id,
			);
		} finally {
			root.dispose();
		}
	});

	it("keeps settled rows eligible for compositor commitment", () => {
		const store = createTranscriptStore();
		store.append({ id: "done", state: "settled", view: () => <text>settled row</text> });
		const root = mountForTest(() => <TranscriptView store={store} />, { width: 30 });
		try {
			root.flush();
			const transcript = root.root.node.children[0];
			if (transcript?.kind !== "element" || !(transcript.state instanceof TranscriptController))
				throw new Error("Expected transcript controller");
			const context = createPaintContext(root.root, node => resolveStyle(node, { theme: root.root.theme }), {
				now: 0,
			});
			const batch = transcript.state.peekFlushBatch(30, context);
			expect(batch?.rows.map(Bun.stripANSI)).toEqual(["settled row", ""]);
		} finally {
			root.dispose();
		}
	});
});
