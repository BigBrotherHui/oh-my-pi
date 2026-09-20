import { beforeAll, describe, expect, it } from "bun:test";
import { createSignal, type Setter } from "../../src/reactive";
import { mountForTest } from "../../src/testing";
import { initTheme } from "../../src/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

describe("Solid layout host integration", () => {
	it("mounts row allocation and a JSX frame title through the universal renderer", () => {
		const root = mountForTest(
			() => (
				<frame title={<span>Title</span>} paddingX={0} paddingY={0}>
					<row gap={1}>
						<text width={1} wrap="none">
							L
						</text>
						<path value="abcdefghij" target="/tmp/abcdefghij" overflow="middle" shrink={1} minWidth={3} />
						<text width={1} wrap="none">
							R
						</text>
					</row>
				</frame>
			),
			{ width: 12 },
		);
		try {
			const rows = root.text();
			expect(rows[0]).toContain("Title");
			expect(rows[1]).toBe("│L ab…hij R│");
		} finally {
			root.dispose();
		}
	});

	it("keeps a JSX title slot reactive after its detached node is adopted", () => {
		let setTitle: Setter<string> | undefined;
		const root = mountForTest(
			() => {
				const [title, updateTitle] = createSignal("before");
				setTitle = updateTitle;
				return (
					<frame title={<span>{title()}</span>} paddingX={0} paddingY={0} renderEmpty>
						<text wrap="none">body</text>
					</frame>
				);
			},
			{ width: 12 },
		);
		try {
			expect(root.text()[0]).toContain("before");
			setTitle?.("after");
			expect(root.text()[0]).toContain("after");
			const frame = root.root.node.children[0];
			expect(frame?.kind === "element" ? frame.slots.get("title")?.length : 0).toBe(1);
		} finally {
			root.dispose();
		}
	});
});
