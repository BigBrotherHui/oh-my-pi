import { describe, expect, test } from "bun:test";
import { TranscriptView, createTranscriptStore } from "../src/chat/transcript-store";
import { TranscriptController } from "../src/compositor/transcript";
import { createPaintContext } from "../src/host/paint";
import { resolveStyle } from "../src/style/cascade";
import { mountForTest, type TestRoot } from "../src/testing";
import "../src/host/elements/text";
import "../src/host/elements/transcript";
import "../src/host/elements/transcript-block";

function contextFor(root: TestRoot) {
	return createPaintContext(root.root, node => resolveStyle(node, { theme: root.root.theme }), { now: 0 });
}

describe("reactive transcript store", () => {
	test("preserves entries through grow/shrink, interrupted streams, resize, late replacement, and committed expansion", () => {
		const store = createTranscriptStore();
		store.append({ id: "settled", state: "settled", view: () => <text>settled row</text> });
		store.append({ id: "stream", view: () => <text>streaming partial</text> });
		const root = mountForTest(() => <TranscriptView store={store} />, { width: 24 });
		root.flush();

		const transcript = root.root.node.children[0];
		if (transcript?.kind !== "element" || !(transcript.state instanceof TranscriptController)) {
			throw new Error("Expected retained transcript controller");
		}
		const controller = transcript.state;
		expect(controller.blockStates()).toEqual(["settled", "active"]);
		controller.setCapacity(1);
		expect(root.text(24)).toEqual(["streaming partial"]);
		controller.setCapacity(4);
		expect(root.text(24)).toEqual(["settled row", "", "streaming partial"]);

		expect(store.canRemove("settled")).toBe(true);
		const settledBatch = controller.peekFlushBatch(24, contextFor(root));
		if (!settledBatch) throw new Error("Expected settled history batch");
		expect(store.canRemove("settled")).toBe(false);
		expect(store.remove("settled")).toBe(false);
		controller.acknowledgeHistory(settledBatch.id);
		expect(controller.blockStates()).toEqual(["committed", "active"]);
		expect(store.canRemove("settled")).toBe(false);
		expect(store.canRemove("stream")).toBe(true);

		// A result can arrive after a narrow frame has committed an earlier block.
		expect(
			store.replace("stream", {
				state: "settled",
				view: () => <text>late result complete</text>,
			}),
		).toBe(true);
		expect(root.text(12)).toEqual(["late result", "complete"]);
		expect(root.text(40)).toEqual(["late result complete"]);

		// Expanding after commit only replaces the live entry; history stays immutable.
		store.replace("stream", {
			view: () => (
				<stack>
					<text>late result complete</text>
					<text>expanded detail</text>
				</stack>
			),
		});
		expect(root.text(40)).toEqual(["late result complete", "expanded detail"]);
		root.dispose();
	});

	test("rejects duplicate identities and reports absent removals", () => {
		const store = createTranscriptStore();
		store.append({ id: "one", view: () => <text>one</text> });
		expect(() => store.append({ id: "one", view: () => <text>duplicate</text> })).toThrow(
			"Transcript entry already exists",
		);
		expect(store.remove("missing")).toBe(false);
		expect(store.remove("one")).toBe(true);
		expect(store.entries()).toEqual([]);
	});

	test("retains its header while mutable entries clear", () => {
		const store = createTranscriptStore();
		const root = mountForTest(() => <TranscriptView store={store} header={<text>welcome</text>} />, { width: 24 });
		try {
			expect(root.text()).toEqual(["welcome"]);
			store.append({ id: "entry", view: () => <text>entry</text> });
			expect(root.text()).toEqual(["welcome", "", "entry"]);
			store.clear();
			expect(root.text()).toEqual(["welcome"]);
		} finally {
			root.dispose();
		}
	});
});
