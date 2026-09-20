import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandNoticeView } from "@oh-my-pi/pi-coding-agent/modes/components/reactive-controller-views";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ComposerChromeView } from "@oh-my-pi/pi-tui/prompt/composer";
import { CustomEditorView } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { mountForTest, type TestRoot } from "@oh-my-pi/pi-tui/testing";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("working status layout", () => {
	let auth: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let root: TestRoot;
	let directory: TempDir;

	beforeAll(() => initTheme(false));
	beforeEach(async () => {
		resetSettingsForTest();
		directory = TempDir.createSync("@omp-working-status-");
		await Settings.init({ inMemory: true, cwd: directory.path() });
		auth = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(auth);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(directory.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.chrome.setShowWelcome(false);
		mode.chatContainer.append({ id: "marker", view: () => CommandNoticeView({ text: "transcript-marker" }) });
		mode.chrome.setSlots({ editor: () => CommandNoticeView({ text: "editor-marker" }), status: undefined });
		root = mountForTest(() => ComposerChromeView({ store: mode.chrome }), { width: 28, height: 24 });
	});
	afterEach(async () => {
		root?.dispose();
		mode?.stop();
		await session?.dispose();
		auth?.close();
		directory?.removeSync();
		resetSettingsForTest();
	});

	function betweenTranscriptAndEditor(): string[] {
		const rows = root.text();
		const start = rows.findIndex(row => row.includes("transcript-marker"));
		const end = rows.findIndex(row => row.includes("editor-marker"));
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		return rows.slice(start + 1, end).map(row => row.trim());
	}

	it("truncates long working text instead of pushing the editor down", () => {
		mode.ensureLoadingAnimation();
		mode.setWorkingMessage(`Investigating ${"long path ".repeat(12)}TAIL`);
		const rows = betweenTranscriptAndEditor();
		expect(rows).toHaveLength(2);
		expect(rows[0]).toBe("");
		expect(rows[1]).toContain("Investigating");
		expect(rows[1]).toContain("…");
		expect(rows.join("\n")).not.toContain("TAIL");
	});

	it("applies composer shape changes to the live editor rather than only its status line", () => {
		mode.chrome.setSlots({ editor: () => CustomEditorView({ editor: mode.editor }) });
		mode.editor.setText("draft-shape");
		settings.override("composer.shape", "box");
		mode.syncComposerShape();
		const boxed = root.text().join("\n");
		expect(boxed).toContain(root.root.theme.boxRound.topLeft);
		expect(boxed).toContain("draft-shape");

		settings.override("composer.shape", "borderless");
		mode.syncComposerShape();
		const borderless = root.text().join("\n");
		expect(borderless).not.toContain(root.root.theme.boxRound.topLeft);
		expect(borderless).not.toContain(root.root.theme.boxRound.bottomLeft);
		expect(borderless).toContain("draft-shape");
	});

	for (const shape of ["band", "box"]) {
		it(`restores one idle spacer after working stops in ${shape} mode`, async () => {
			mode.chrome.setPreferences({ composerShape: shape });
			mode.ensureLoadingAnimation();
			mode.setWorkingMessage("Working");
			expect(betweenTranscriptAndEditor()).toHaveLength(shape === "band" ? 2 : 3);
			await mode.eventController.handleEvent({ type: "agent_end", messages: [] });
			expect(betweenTranscriptAndEditor()).toEqual([""]);
			mode.statusContainer.append(() => undefined);
			expect(betweenTranscriptAndEditor()).toEqual([""]);
		});
	}
});
