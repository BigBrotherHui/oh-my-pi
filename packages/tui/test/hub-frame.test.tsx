import { describe, expect, test } from "bun:test";
import { HubFrameView } from "../src/overlays/hub-frame";
import { mountForTest } from "../src/testing";
import "../src/host/elements/frame";
import "../src/host/elements/hr";
import "../src/host/elements/scroll";
import "../src/host/elements/sized";
import "../src/host/elements/split";
import "../src/host/elements/stack";
import "../src/host/elements/text";

function rows(prefix: string, count: number) {
	return (
		<stack>
			{Array.from({ length: count }, (_, index) => (
				<text>
					{prefix}
					{index}
				</text>
			))}
		</stack>
	);
}

describe("HubFrameView", () => {
	test("restores the full-height split frame and pins the footer under both panes", () => {
		const root = mountForTest(
			() => (
				<HubFrameView
					title="Agents"
					sidebar={rows("scope-", 20)}
					body={rows("detail-", 20)}
					footer={<text>↑/↓ select · Enter open</text>}
					sidebarWidth={16}
					viewportHeight={16}
				/>
			),
			{ width: 50 },
		);
		try {
			const rendered = root.text();
			expect(rendered).toHaveLength(16);
			expect(rendered[0]![19]).toBe("┬");
			expect(rendered[1]).toContain("scope-0");
			expect(rendered[1]).toContain("detail-0");
			expect(rendered[12]).toContain("scope-11");
			expect(rendered[12]).toContain("detail-11");
			expect(rendered[13]![19]).toBe("┴");
			expect(rendered[14]).toContain("↑/↓ select · Enter open");
			expect(rendered[15]).toMatch(/^╰.*╯$/);
		} finally {
			root.dispose();
		}
	});

	test("keeps sidebar and detail offsets independent", () => {
		const root = mountForTest(
			() => (
				<HubFrameView
					title="Agents"
					sidebar={rows("scope-", 20)}
					body={rows("detail-", 20)}
					footer={<text>footer</text>}
					sidebarWidth={16}
					sidebarOffset={4}
					bodyOffset={9}
					viewportHeight={14}
				/>
			),
			{ width: 50 },
		);
		try {
			const rendered = root.text().join("\n");
			expect(rendered).toContain("scope-4");
			expect(rendered).toContain("detail-9");
			expect(rendered).not.toContain("scope-3");
			expect(rendered).not.toContain("detail-8");
		} finally {
			root.dispose();
		}
	});

	test("clamps the sidebar at narrow widths and supports a body-only frame", () => {
		const narrow = mountForTest(
			() => (
				<HubFrameView
					title="Agents"
					sidebar={rows("scope-", 2)}
					body={rows("detail-", 2)}
					footer={<text>footer</text>}
					sidebarWidth={24}
					viewportHeight={14}
				/>
			),
			{ width: 10 },
		);
		const bodyOnly = mountForTest(
			() => <HubFrameView title="Activity" body={rows("activity-", 20)} bodyOffset={4} viewportHeight={12} />,
			{ width: 40 },
		);
		try {
			const narrowRows = narrow.text();
			expect(narrowRows).toHaveLength(14);
			expect(narrowRows[0]![6]).toBe("┬");
			expect(narrowRows.every(row => row.length === 10)).toBe(true);

			const bodyRows = bodyOnly.text();
			expect(bodyRows).toHaveLength(12);
			expect(bodyRows[0]).not.toContain("┬");
			expect(bodyRows[1]).toContain("activity-4");
			expect(bodyRows.at(-1)).toMatch(/^╰.*╯$/);
		} finally {
			narrow.dispose();
			bodyOnly.dispose();
		}
	});
});
