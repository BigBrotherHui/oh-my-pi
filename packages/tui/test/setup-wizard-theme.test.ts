import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dispatchKey, HostKeyEvent } from "../src/host/input";
import { mountForTest } from "../src/testing";
import { initTheme, onThemeChange, theme } from "../src/theme/theme";
import { ThemeSceneView, type ThemeSceneContext } from "../src/setup/scenes/theme";

interface ThemeFixture {
	readonly context: ThemeSceneContext;
	readonly results: SetupResult[];
}

type SetupResult = "done" | "skipped";

function createThemeFixture(availableRows: number): ThemeFixture {
	const results: SetupResult[] = [];
	return {
		context: {
			host: {
				symbolPreset: "nerd",
				colorBlindMode: false,
				saveSymbolPreset(): void {},
				saveColorBlindMode(): void {},
				saveTheme(): void {},
			},
			availableRows(): number {
				return availableRows;
			},
			complete(result): void {
				results.push(result);
			},
		},
		results,
	};
}

beforeEach(async () => {
	await initTheme(false, "nerd", false, "titanium", "light");
});
function waitForThemeChanges(expected: number): Promise<void> {
	const settled = Promise.withResolvers<void>();
	let changes = 0;
	const stop = onThemeChange(() => {
		changes++;
		if (changes < expected) return;
		stop();
		settled.resolve();
	});
	return settled.promise;
}

afterEach(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

describe("ThemeSceneView", () => {
	it("keeps every curated choice visible in the historical compact body budget", () => {
		const fixture = createThemeFixture(11);
		const root = mountForTest(() => ThemeSceneView(fixture.context), { width: 80, height: 24 });
		try {
			const rendered = root.text().join("\n");
			expect(rendered).toContain("Theme changes preview live. Nothing is saved until you press Enter.");
			expect(rendered).toContain("Esc skips this step");
			expect(rendered).not.toContain("Preview");
			for (const label of ["Match terminal", "Titanium", "Light", "Colorblind colors", "ANSI-safe", "Browse all…"]) {
				expect(rendered).toContain(label);
			}
		} finally {
			root.dispose();
		}
	});

	it("restores the full status-line and editor preview when the body can contain it", () => {
		const fixture = createThemeFixture(21);
		const root = mountForTest(() => ThemeSceneView(fixture.context), { width: 88, height: 40 });
		try {
			const rendered = root.text().join("\n");
			expect(rendered).toContain("Preview");
			expect(rendered).toContain("Status line");
			expect(rendered).toContain("sonnet");
			expect(rendered).toContain("~/project");
			expect(rendered).toContain("Editor");
			expect(rendered).toContain("enter send · shift+enter newline · / commands");
		} finally {
			root.dispose();
		}
	});

	it("restores the original glyph presentation after moving from ANSI-safe to Titanium", async () => {
		const fixture = createThemeFixture(11);
		const root = mountForTest(() => ThemeSceneView(fixture.context), { width: 80, height: 24 });
		try {
			root.flush();
			const ansiPreviewed = waitForThemeChanges(3);
			dispatchKey(root.root, new HostKeyEvent("5"));
			root.flush();
			await ansiPreviewed;
			expect(theme.getSymbolPreset()).toBe("ascii");

			const titaniumPreviewed = waitForThemeChanges(3);
			dispatchKey(root.root, new HostKeyEvent("2"));
			root.flush();
			await titaniumPreviewed;
			expect(fixture.results).toEqual([]);
			expect(theme.getSymbolPreset()).toBe("nerd");
		} finally {
			root.dispose();
		}
	});
});
