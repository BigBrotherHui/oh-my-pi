import { createSignal } from "solid-js";
import { renderToText } from "../../src/testing";
import { clearMemoryMutations, createMemoryRoot, renderMemory } from "./memory-renderer";

/** Render static JSX entities and literal/runtime strings through the terminal compiler. */
export function renderTextFixture(input: string): string[] {
	return renderToText(
		() => (
			<stack>
				<text>&lt;raw&gt; &amp; &#x3BB;</text>
				<text>{"<literal>&amp;"}</text>
				<text>{input}</text>
			</stack>
		),
		80,
	);
}

/** Observable result of the preload-compiled reactive runtime fixture. */
export interface RuntimeFixtureResult {
	readonly initialText: string | undefined;
	readonly updatedText: string | undefined;
	readonly retainedTextIdentity: boolean;
	readonly viewRuns: number;
}

/** Mount pragma-free TSX and update one signal without rerunning its view. */
export function runRuntimeFixture(): RuntimeFixtureResult {
	const root = createMemoryRoot();
	const [count, setCount] = createSignal(0);
	let viewRuns = 0;
	const dispose = renderMemory(() => {
		viewRuns++;
		return <box>{count()}</box>;
	}, root);
	const counter = root.children[0];
	if (!counter) throw new Error("runtime fixture did not mount its counter element");
	const originalTextNode = counter.children[0];
	if (!originalTextNode) throw new Error("runtime fixture did not mount its text node");
	const initialText = originalTextNode.text;
	clearMemoryMutations();
	setCount(1);
	const updatedTextNode = counter.children[0];
	if (!updatedTextNode) throw new Error("runtime fixture removed its text node during an update");
	const result = {
		initialText,
		updatedText: updatedTextNode.text,
		retainedTextIdentity: updatedTextNode === originalTextNode,
		viewRuns,
	};
	dispose();
	return result;
}
