import { expect, test, vi } from "bun:test";
import { createTranscriptStore, TranscriptView, type TranscriptStore } from "../../src/chat/transcript-store";
import { ToolBlock, ToolBlockSummary } from "../../src/chat/tool-block";
import { createToolCallModel } from "../../src/tools/model";
import { ComposerChromeView, createComposerChromeStore } from "../../src/prompt/composer";
import { render } from "../../src/root";
import { createLayoutEffect, createSignal, Show } from "../../src/reactive";
import { loadThemeSync } from "../../src/theme/loader";
import { VirtualTerminal } from "../virtual-terminal";

test("completed tool output remains intact behind a pinned stream instead of becoming a summary", () => {
	const terminal = new VirtualTerminal(60, 10);
	const transcript = createTranscriptStore();
	const model = createToolCallModel({ id: "profile", toolName: "bash", label: "Bash" });
	model.applyArgsChunk({ command: "profile-startup" });
	model.markRunning();
	model.applyResult({
		content: [{ type: "text", text: Array.from({ length: 8 }, (_, index) => `profile result ${index}`).join("\n") }],
	});
	transcript.append({ id: "pinned", view: () => <text>Assistant still streaming</text> });
	transcript.append({
		id: "profile",
		state: "settled",
		toolActivity: true,
		onAllocation: allocation => model.setUi({ allocation }),
		view: () => <ToolBlock model={model} />,
		compactView: () => <ToolBlockSummary model={model} />,
	});
	transcript.append({
		id: "latest",
		view: () => <text>{"New assistant prose\n".repeat(3).trimEnd()}</text>,
	});
	const root = render(
		() => (
			<stack>
				<TranscriptView store={transcript} />
				<text>editor-tail</text>
			</stack>
		),
		{ terminal, theme: loadThemeSync("dark") },
	);
	try {
		root.tui.renderNow();
		const viewport = terminal.getViewport().join("\n");
		expect(viewport).toContain("profile result 7");
		expect(viewport).not.toContain("profile-startup");
		expect(viewport).toContain("New assistant prose");

		transcript.replace("pinned", { state: "settled" });
		transcript.replace("latest", { state: "settled" });
		root.tui.renderNow();
		root.dispose();
		const history = terminal.getScrollBuffer().join("\n");
		expect(history.match(/profile-startup/g)).toHaveLength(1);
		for (let index = 0; index < 8; index++) expect(history.split(`profile result ${index}`)).toHaveLength(2);
	} finally {
		root.dispose();
	}
});

test("live tools receive the transcript budget after surrounding chrome", () => {
	const terminal = new VirtualTerminal(40, 8);
	const transcript = createTranscriptStore();
	const [allocation, setAllocation] = createSignal(0);
	transcript.append({ id: "tool", onAllocation: setAllocation, view: () => <text>allocation {allocation()}</text> });
	const root = render(
		() => (
			<stack>
				<text>header</text>
				<TranscriptView store={transcript} />
				<text>footer</text>
			</stack>
		),
		{ terminal, theme: loadThemeSync("dark") },
	);
	try {
		root.tui.renderNow();
		expect(terminal.getViewport().join("\n")).toContain("allocation 6");
		terminal.resize(40, 5);
		root.tui.renderNow();
		expect(terminal.getViewport().join("\n")).toContain("allocation 3");
	} finally {
		root.dispose();
	}
});

test("layout hooks observe scroll geometry after transcript chrome allocation", () => {
	const terminal = new VirtualTerminal(40, 8);
	const transcript = createTranscriptStore();
	const [allocation, setAllocation] = createSignal(0);
	const [observedHeight, setObservedHeight] = createSignal(0);
	let measuredHeight = 0;
	transcript.append({
		id: "tool",
		onAllocation: setAllocation,
		view: () => (
			<scroll
				height={allocation()}
				onViewport={viewport => {
					measuredHeight = viewport.height;
				}}
			>
				<text>{"line\n".repeat(20)}</text>
			</scroll>
		),
	});
	const root = render(
		() => {
			createLayoutEffect(() => setObservedHeight(measuredHeight));
			return (
				<stack>
					<text>layout {observedHeight()}</text>
					<TranscriptView store={transcript} />
				</stack>
			);
		},
		{ terminal, theme: loadThemeSync("dark") },
	);
	try {
		root.tui.renderNow();
		expect(terminal.getViewport().join("\n")).toContain("layout 7");
		terminal.resize(40, 5);
		root.tui.renderNow();
		expect(terminal.getViewport().join("\n")).toContain("layout 4");
	} finally {
		root.dispose();
	}
});

test("a remounted transcript emits new history after prior batches were accepted", () => {
	const terminal = new VirtualTerminal(40, 3);
	const first = createTranscriptStore();
	const second = createTranscriptStore();
	const [store, setStore] = createSignal(first);
	const root = render(
		() => (
			<Show when={store()} keyed>
				{(active: TranscriptStore) => <TranscriptView store={active} />}
			</Show>
		),
		{ terminal, theme: loadThemeSync("dark") },
	);
	try {
		for (let index = 0; index < 8; index++) {
			first.append({ id: `first-${index}`, state: "settled", view: () => <text>first-{index}</text> });
			root.tui.renderNow();
		}
		setStore(second);
		for (let index = 0; index < 8; index++) {
			second.append({ id: `second-${index}`, state: "settled", view: () => <text>second-{index}</text> });
			root.tui.renderNow();
		}
		root.dispose();
		const rows = terminal.getScrollBuffer().map(row => row.trim());
		for (let index = 0; index < 8; index++) expect(rows.filter(row => row === `second-${index}`)).toHaveLength(1);
	} finally {
		root.dispose();
	}
});

test("root shutdown presents the final reactive state before releasing its views", () => {
	const terminal = new VirtualTerminal(40, 6);
	const [result, setResult] = createSignal("running");
	const root = render(() => <text>{result()}</text>, { terminal, theme: loadThemeSync("dark") });
	try {
		root.tui.renderNow();
		setResult("completed");
		root.dispose();
		expect(
			terminal
				.getScrollBuffer()
				.map(row => row.trim())
				.filter(Boolean),
		).toEqual(["completed"]);
		root.dispose();
		expect(
			terminal
				.getScrollBuffer()
				.map(row => row.trim())
				.filter(Boolean),
		).toEqual(["completed"]);
	} finally {
		root.dispose();
	}
});

test("root shutdown commits the last settled result without dropping or duplicating it", () => {
	const terminal = new VirtualTerminal(40, 6);
	const transcript = createTranscriptStore();
	transcript.append({ id: "result", view: () => <text>running</text> });
	const store = createComposerChromeStore({ transcript, showWelcome: false, editor: <text>editor-tail</text> });
	const root = render(() => <ComposerChromeView store={store} />, { terminal, theme: loadThemeSync("dark") });
	try {
		root.tui.renderNow();
		transcript.replace("result", { state: "settled", view: () => <text>final result</text> });
		root.dispose();
		expect(
			terminal
				.getScrollBuffer()
				.map(row => row.trim())
				.filter(Boolean),
		).toEqual(["final result", "editor-tail"]);
	} finally {
		root.dispose();
	}
});

test("stream patches keep their position and a session replacement discards the prior history ledger", () => {
	const terminal = new VirtualTerminal(40, 7);
	const transcript = createTranscriptStore();
	const store = createComposerChromeStore({
		transcript,
		showWelcome: false,
		headerBefore: <text>welcome</text>,
		editor: <text>editor</text>,
	});
	const root = render(() => <ComposerChromeView store={store} />, { terminal, theme: loadThemeSync("dark") });
	const rows = () =>
		terminal
			.getScrollBuffer()
			.map(row => row.trim())
			.filter(Boolean);
	try {
		transcript.append({ id: "assistant", view: () => <text>answer-start</text> });
		transcript.append({ id: "tool", view: () => <text>tool-running</text> });
		root.tui.renderNow();
		transcript.replace("assistant", { view: () => <text>answer-updated</text> });
		root.tui.renderNow();
		expect(rows()).toEqual(["welcome", "answer-updated", "tool-running", "editor"]);
		transcript.replace("assistant", { state: "settled" });
		transcript.replace("tool", { state: "settled" });
		for (let index = 0; index < 4; index++) {
			transcript.append({ id: `old-${index}`, state: "settled", view: () => <text>{`old-${index}`}</text> });
			root.tui.renderNow();
		}
		transcript.clear();
		transcript.append({ id: "new", state: "settled", view: () => <text>new-session</text> });
		root.tui.resetDisplay();
		root.tui.renderNow();
		expect(rows()).toEqual(["welcome", "new-session", "editor"]);
		for (let index = 0; index < 4; index++) {
			transcript.append({ id: `new-${index}`, state: "settled", view: () => <text>{`new-${index}`}</text> });
			root.tui.renderNow();
		}
		expect(rows()).toEqual(["welcome", "new-session", "new-0", "new-1", "new-2", "new-3", "editor"]);
	} finally {
		root.dispose();
	}
});

test("a late welcome intro cannot pin a replacement transcript behind its retired owner clock", () => {
	vi.useFakeTimers();
	const terminal = new VirtualTerminal(60, 8);
	const transcript = createTranscriptStore();
	const store = createComposerChromeStore({ transcript, showWelcome: true, editor: <text>editor-tail</text> });
	const root = render(() => <ComposerChromeView store={store} />, { terminal, theme: loadThemeSync("dark") });
	try {
		root.tui.renderNow();
		store.playWelcomeIntro();
		transcript.clear();
		for (let index = 0; index < 8; index++)
			transcript.append({
				id: `replacement-${index}`,
				state: "settled",
				view: () => <text>replacement-{index}</text>,
			});
		root.tui.resetDisplay();
		root.tui.renderNow();
		expect(terminal.getScrollBuffer().join("\n")).not.toContain("replacement-0");

		vi.advanceTimersByTime(4_000);
		root.tui.renderNow();
		root.dispose();
		const history = terminal.getScrollBuffer().join("\n");
		for (let index = 0; index < 8; index++) expect(history.split(`replacement-${index}`)).toHaveLength(2);
	} finally {
		root.dispose();
		vi.useRealTimers();
	}
});

test("welcome history precedes messages without duplicated rows across retirement and repaint", () => {
	const terminal = new VirtualTerminal(40, 6);
	const transcript = createTranscriptStore();
	const store = createComposerChromeStore({
		transcript,
		showWelcome: false,
		headerBefore: <text>welcome-header</text>,
		editor: <text>editor-tail</text>,
	});
	const root = render(() => <ComposerChromeView store={store} />, {
		terminal,
		theme: loadThemeSync("dark"),
	});
	try {
		root.tui.renderNow();
		for (let index = 1; index <= 5; index++) {
			transcript.append({ id: `message-${index}`, state: "settled", view: () => <text>{`message-${index}`}</text> });
			root.tui.renderNow();
		}
		const expected = [
			"welcome-header",
			"message-1",
			"message-2",
			"message-3",
			"message-4",
			"message-5",
			"editor-tail",
		];
		const visible = () =>
			terminal
				.getScrollBuffer()
				.map(row => row.trim())
				.filter(Boolean);
		expect(visible()).toEqual(expected);
		root.tui.renderNow();
		root.tui.renderNow();
		expect(visible()).toEqual(expected);
	} finally {
		root.dispose();
	}
});
