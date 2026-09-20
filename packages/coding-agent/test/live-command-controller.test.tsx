import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { CustomEditor, CustomEditorView } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { render } from "@oh-my-pi/pi-tui/root";
import { getEditorTheme, initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LiveCommandController", () => {
	it("mounts the visualizer under the editor root, honors the configured stop key, and restores the draft", async () => {
		const terminal = new VirtualTerminal(80, 16);
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("draft");
		const ctx = createInteractiveModeContext({
			editor,
			keybindings: KeybindingsManager.inMemory({ "app.live.toggle": "ctrl+l" }),
		});
		ctx.editorContainer.append(() => <CustomEditorView editor={editor} />);
		const root = render(ctx.editorContainer.view, { terminal, theme });
		ctx.ui = root.tui;
		const initialHardwareCursor = root.tui.getShowHardwareCursor();
		const initialTerminalCursor = editor.getUseTerminalCursor();
		const resumeVocalizer = vi.fn();
		vi.spyOn(vocalizer, "suspend").mockReturnValue(resumeVocalizer);
		let muteCalls = 0;
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			vi.spyOn(session, "toggleMute").mockImplementation(() => {
				muteCalls += 1;
			});
			return session;
		});

		try {
			await controller.handleCommand();
			root.tui.renderNow();
			expect(terminal.getViewport().join("\n")).toContain("connecting");
			terminal.sendInput(" ");
			expect(muteCalls).toBe(1);

			terminal.sendInput("\x0c");
			for (let index = 0; controller.active && index < 20; index += 1) await Promise.resolve();
			root.tui.renderNow();
			expect(controller.active).toBe(false);
			expect(resumeVocalizer).toHaveBeenCalledTimes(1);
			expect(root.tui.getShowHardwareCursor()).toBe(initialHardwareCursor);
			expect(editor.getUseTerminalCursor()).toBe(initialTerminalCursor);

			terminal.sendInput(" restored");
			expect(editor.getText()).toBe("draft restored");
		} finally {
			controller.dispose();
			root.dispose();
		}
	});
});
