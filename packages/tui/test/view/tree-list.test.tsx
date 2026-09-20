import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "../../src/reactive";
import { mountForTest, type TestRoot } from "../../src/testing";
import { TreeList } from "../../src/view/tree-list";

type Item = { readonly id: string };

const mounted: TestRoot[] = [];
afterEach(() => {
	for (const root of mounted.splice(0)) root.dispose();
});

describe("TreeList", () => {
	test("closes the last visible branch when the optional summary is absent", () => {
		const [expanded, setExpanded] = createSignal(false);
		const root = mountForTest(
			() => (
				<TreeList
					items={["one", "two"]}
					expanded={expanded()}
					maxCollapsed={1}
					renderItem={item => <text>{item}</text>}
				/>
			),
			{ width: 20 },
		);
		mounted.push(root);
		expect(root.text().map(row => row.trimEnd())).toEqual(["├─ one", "└─ … 1 more item"]);
		setExpanded(true);
		expect(root.text().map(row => row.trimEnd())).toEqual(["├─ one", "└─ two"]);
	});
	test("a keyed move retains nodes and records one move", () => {
		const first: Item = { id: "first" };
		const second: Item = { id: "second" };
		const third: Item = { id: "third" };
		const [items, setItems] = createSignal<readonly Item[]>([first, second, third]);
		const root = mountForTest(
			() => <TreeList items={items()} expanded renderItem={item => <text>{item.id}</text>} />,
			{ width: 40 },
		);
		mounted.push(root);
		root.flush();
		const before = root.counters();
		setItems([second, first, third]);
		root.flush();
		const after = root.counters();
		expect(after.nodesCreated - before.nodesCreated).toBe(0);
		expect(after.nodesMoved - before.nodesMoved).toBe(1);
		expect(root.text().join("\n")).toContain("second");
	});
});
