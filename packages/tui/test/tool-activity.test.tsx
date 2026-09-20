import { expect, test } from "bun:test";
import { ToolActivityView } from "../src/chrome/tool-activity";
import { TranscriptView, createTranscriptStore } from "../src/chat/transcript-store";
import { TranscriptController } from "../src/compositor/transcript";
import { createSignal, type Setter } from "../src/reactive";
import { mountForTest } from "../src/testing";
import "../src/host/elements/stack";
import "../src/host/elements/text";
import "../src/host/elements/transcript";
import "../src/host/elements/transcript-block";

test("hides activity while retained content continues to receive live updates", () => {
	let setVisible: Setter<boolean> | undefined;
	let setStatus: Setter<string> | undefined;
	const root = mountForTest(() => {
		const [visible, setVisibleValue] = createSignal(true);
		const [status, setStatusValue] = createSignal("running");
		setVisible = setVisibleValue;
		setStatus = setStatusValue;
		return (
			<ToolActivityView visible={visible}>
				<stack>
					<text>{status()}</text>
					<text>worker-7</text>
				</stack>
			</ToolActivityView>
		);
	});
	try {
		expect(root.text()).toEqual(["running", "worker-7"]);
		if (setVisible === undefined || setStatus === undefined) throw new Error("activity signals were not initialized");

		setVisible(false);
		expect(root.text()).toEqual([]);
		setStatus("completed");
		expect(root.text()).toEqual([]);

		setVisible(true);
		expect(root.text()).toEqual(["completed", "worker-7"]);
	} finally {
		root.dispose();
	}
});

test("compacts only tools whose own live output exceeds the viewport", () => {
	const store = createTranscriptStore();
	store.append({
		id: "assistant",
		state: "settled",
		view: () => (
			<stack>
				<text>assistant 1</text>
				<text>assistant 2</text>
				<text>assistant 3</text>
			</stack>
		),
	});
	store.append({
		id: "tool",
		toolActivity: true,
		compactView: () => <text>tool summary</text>,
		view: () => (
			<stack>
				<text>tool 1</text>
				<text>tool 2</text>
				<text>tool 3</text>
			</stack>
		),
	});
	const root = mountForTest(() => <TranscriptView store={store} />);
	try {
		root.flush();
		const transcript = root.root.node.children[0];
		if (transcript?.kind !== "element" || !(transcript.state instanceof TranscriptController)) {
			throw new Error("Expected retained transcript controller");
		}
		transcript.state.setCapacity(4);

		expect(root.text()).toEqual(["", "tool 1", "tool 2", "tool 3"]);
		store.replace("tool", { view: () => <text>{"tool 1\ntool 2\ntool 3\ntool 4\ntool 5"}</text> });
		expect(root.text()).toEqual(["assistant 2", "assistant 3", "", "tool summary"]);
		store.replace("tool", { state: "settled" });
		expect(root.text()).toEqual(["tool 2", "tool 3", "tool 4", "tool 5"]);
	} finally {
		root.dispose();
	}
});
