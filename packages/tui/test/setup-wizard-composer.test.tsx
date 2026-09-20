import { describe, expect, it } from "bun:test";
import { dispatchKey, dispatchMouse, HostKeyEvent, HostMouseEvent } from "../src/host/input";
import { ComposerSceneView, type ComposerSceneContext } from "../src/setup/scenes/composer";
import { mountForTest, type TestRoot } from "../src/testing";

type Completion = "done" | "skipped";

interface ContextOptions {
	readonly rows?: number;
	readonly shape?: string;
	readonly saved?: string[];
	readonly completed?: Completion[];
}

function createContext(options: ContextOptions = {}): ComposerSceneContext {
	return {
		host: {
			composerShape: options.shape ?? "band",
			statusLine: undefined,
			saveComposerShape: async shape => {
				options.saved?.push(shape);
			},
		},
		complete(result): void {
			options.completed?.push(result);
		},
		availableRows: options.rows === undefined ? undefined : () => options.rows!,
	};
}

function press(root: TestRoot, data: string): void {
	dispatchKey(root.root, new HostKeyEvent(data));
	root.flush();
}

describe("ComposerSceneView", () => {
	it("keeps the historical preview-first layout and omits it only when the body cannot fit it", () => {
		const expanded = mountForTest(() => ComposerSceneView(createContext({ rows: 14 })), { width: 72, height: 24 });
		const compact = mountForTest(() => ComposerSceneView(createContext({ rows: 12 })), { width: 72, height: 24 });
		try {
			const expandedText = expanded.text().join("\n");
			expect(expandedText).toContain("Select a layout; live preview updates below. Press Enter to confirm.");
			expect(expandedText.indexOf("Preview:")).toBeLessThan(expandedText.indexOf("1 Status Band (Default)"));
			expect(compact.text().join("\n")).not.toContain("Preview:");
		} finally {
			expanded.dispose();
			compact.dispose();
		}
	});

	it("keeps numbered shortcuts and mouse activation connected to the controlled selection", async () => {
		const saved: string[] = [];
		const completed: Completion[] = [];
		const root = mountForTest(() => ComposerSceneView(createContext({ rows: 24, saved, completed })), {
			width: 72,
			height: 24,
		});
		try {
			press(root, "3");
			press(root, "\n");
			await Promise.resolve();
			expect(saved).toEqual(["claude"]);
			expect(completed).toEqual(["done"]);
		} finally {
			root.dispose();
		}

		const mouseSaved: string[] = [];
		const mouseCompleted: Completion[] = [];
		const mouseRoot = mountForTest(
			() => ComposerSceneView(createContext({ rows: 24, saved: mouseSaved, completed: mouseCompleted })),
			{ width: 72, height: 24 },
		);
		try {
			const row = mouseRoot.text().findIndex(line => line.includes("2 Rounded Box"));
			expect(row).toBeGreaterThanOrEqual(0);
			dispatchMouse(mouseRoot.root, new HostMouseEvent({ row, col: 4 }));
			mouseRoot.flush();
			await Promise.resolve();
			expect(mouseSaved).toEqual(["box"]);
			expect(mouseCompleted).toEqual(["done"]);
		} finally {
			mouseRoot.dispose();
		}
	});

	it("skips without persisting on Escape", () => {
		const saved: string[] = [];
		const completed: Completion[] = [];
		const root = mountForTest(() => ComposerSceneView(createContext({ rows: 24, saved, completed })), {
			width: 72,
			height: 24,
		});
		try {
			press(root, "\x1b");
			expect(saved).toEqual([]);
			expect(completed).toEqual(["skipped"]);
		} finally {
			root.dispose();
		}
	});
});
