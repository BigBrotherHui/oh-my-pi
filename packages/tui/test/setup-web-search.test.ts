import { describe, expect, it } from "bun:test";
import { dispatchKey, dispatchMouse, HostKeyEvent, HostMouseEvent } from "../src/host/input";
import { createSignal } from "../src/reactive";
import { WebSearchSceneView, type WebSearchSceneContext } from "@oh-my-pi/pi-tui/setup/scenes/web-search";
import { mountForTest, type TestRoot } from "../src/testing";
import type { SearchProviderId } from "@oh-my-pi/pi-tui/tools/web-search";

type SetupResult = "done" | "skipped";

interface WebSearchFixture {
	readonly context: WebSearchSceneContext;
	readonly checked: SearchProviderId[];
	readonly saved: Array<SearchProviderId | "auto">;
	readonly completed: SetupResult[];
}

function createFixture(
	options: {
		readonly available?: Readonly<Partial<Record<SearchProviderId, boolean>>>;
		readonly selection?: SearchProviderId | "auto";
		readonly rows?: () => number;
		readonly active?: () => boolean;
	} = {},
): WebSearchFixture {
	const checked: SearchProviderId[] = [];
	const saved: Array<SearchProviderId | "auto"> = [];
	const completed: SetupResult[] = [];
	return {
		context: {
			host: {
				webSearchSelection: options.selection ?? "auto",
				isSearchProviderAvailable(id): Promise<boolean> {
					checked.push(id);
					return Promise.resolve(options.available?.[id] ?? true);
				},
				saveWebSearchSelection(id): void {
					saved.push(id);
				},
			},
			complete(result): void {
				completed.push(result);
			},
			availableRows: options.rows,
			active: options.active,
		},
		checked,
		saved,
		completed,
	};
}

function press(root: TestRoot, data: string): void {
	dispatchKey(root.root, new HostKeyEvent(data));
	root.flush();
}

describe("WebSearchSceneView", () => {
	it("keeps the historical full provider catalog, descriptions, and overflow search", () => {
		const fixture = createFixture({ rows: () => 13 });
		const root = mountForTest(() => WebSearchSceneView(fixture.context), { width: 120, height: 24 });
		try {
			const initial = root.text().join("\n");
			expect(initial).toContain("Choose the provider the web_search tool should prefer.");
			expect(initial).toContain("Automatically uses the first configured provider.");
			expect(fixture.checked).toEqual([]);
			expect(initial).toContain("  Type to search");
			const autoDescription = "Automatically uses the first configured web-search provider";
			const autoRow = initial.split("\n").find(line => line.includes(autoDescription));
			expect(autoRow?.indexOf(autoDescription)).toBe(34);

			for (const character of "none") press(root, character);
			const filtered = root.text().join("\n");
			expect(filtered).toContain("  Search: none");
			expect(filtered).toContain("None");
			expect(filtered).toContain("Disables web search");
		} finally {
			root.dispose();
		}
	});

	it("checks a highlighted provider, persists unavailable choices, and keeps the historical guidance", async () => {
		const fixture = createFixture({ available: { none: false }, rows: () => 13 });
		const root = mountForTest(() => WebSearchSceneView(fixture.context), { width: 120, height: 24 });
		try {
			root.text();
			press(root, "\x1b[F");
			await Promise.resolve();
			root.flush();
			const ready = root.text().join("\n");
			expect(fixture.checked).toEqual(["none"]);
			expect(ready).toContain("Needs credentials");

			press(root, "\n");
			const saved = root.text().join("\n");
			expect(fixture.saved).toEqual(["none"]);
			expect(saved).toContain("Web search set to None");
			expect(saved).toContain("Not configured yet — add its API key or sign in to enable it.");
		} finally {
			root.dispose();
		}
	});

	it("defers hidden availability work and resets saved state when its retained tab is reactivated", async () => {
		const [active, setActive] = createSignal(false);
		const fixture = createFixture({ rows: () => 13, active, selection: "parallel" });
		const root = mountForTest(() => WebSearchSceneView(fixture.context), { width: 120, height: 24 });
		try {
			root.flush();
			expect(fixture.checked).toEqual([]);

			setActive(true);
			root.flush();
			await Promise.resolve();
			root.flush();
			expect(fixture.checked).toEqual(["parallel"]);

			press(root, "\n");
			expect(root.text().join("\n")).toContain("Web search set to Parallel");

			setActive(false);
			root.flush();
			setActive(true);
			root.flush();
			await Promise.resolve();
			root.flush();

			expect(fixture.checked).toEqual(["parallel", "parallel"]);
			expect(root.text().join("\n")).not.toContain("Web search set to Parallel");
		} finally {
			root.dispose();
		}
	});

	it("uses compact row budgets, direct mouse selection, and escape cancellation", () => {
		const fixture = createFixture({ rows: () => 7 });
		const root = mountForTest(() => WebSearchSceneView(fixture.context), { width: 72, height: 24 });
		try {
			const compact = root.text().join("\n");
			expect(compact).toContain("Auto");
			expect(compact).not.toContain("Gemini");

			root.rows();
			dispatchMouse(root.root, new HostMouseEvent({ row: 3, col: 0 }));
			expect(fixture.saved).toEqual(["parallel"]);

			press(root, "\x1b");
			expect(fixture.completed).toEqual(["skipped"]);
		} finally {
			root.dispose();
		}
	});
});
