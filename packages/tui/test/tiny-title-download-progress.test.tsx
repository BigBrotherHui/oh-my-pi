import { describe, expect, it } from "bun:test";
import {
	TinyTitleDownloadProgressView,
	openTinyTitleDownloadProgress,
} from "../src/overlays/tiny-title-download-progress";
import { createSignal } from "../src/reactive";
import { render } from "../src/root";
import { mountForTest } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";
import { VirtualTerminal } from "./virtual-terminal";

describe("tiny title download progress", () => {
	it("keeps the historic narrow progress layout and selects the most advanced incomplete file", () => {
		const root = mountForTest(
			() => (
				<TinyTitleDownloadProgressView
					modelLabel="Qwen"
					event={{
						status: "progress_total",
						progress: 50,
						loaded: 1024,
						total: 2048,
						files: {
							"models/starting.bin": { loaded: 300, total: 1000 },
							"models/weights.bin": { loaded: 800, total: 1000 },
						},
					}}
				/>
			),
			{ width: 40, theme: loadThemeSync("dark") },
		);
		try {
			expect(root.text()).toEqual([
				"─".repeat(40),
				" Tiny model Downloading Qwen".padEnd(40),
				` ${"█".repeat(4)}${"░".repeat(4)}  50% 1.0KB / 2.0KB weights.bin`,
				"─".repeat(40),
			]);
		} finally {
			root.dispose();
		}
	});

	it("streams updates through the overlay, exposes failure, and disposes cleanly", () => {
		const terminal = new VirtualTerminal(64, 12);
		const [draft, setDraft] = createSignal("");
		const root = render(() => <input prompt="Draft: " value={draft()} onChange={setDraft} />, {
			terminal,
			theme: loadThemeSync("dark"),
		});
		const overlay = openTinyTitleDownloadProgress(root.tui, "Qwen", {
			status: "progress",
			progress: 50,
			loaded: 1024,
			total: 2048,
			file: "models/weights.bin",
		});
		try {
			root.tui.renderNow();
			const downloading = terminal.getViewport().join("\n");
			expect(downloading).toContain("Tiny model Downloading Qwen");
			expect(downloading).toContain("  50% 1.0KB / 2.0KB weights.bin");

			terminal.sendInput("x");
			expect(draft()).toBe("x");

			overlay.update({ status: "error" });
			root.tui.renderNow();
			const failed = terminal.getViewport().join("\n");
			expect(failed).toContain("Tiny model Failed Qwen");
			expect(failed).not.toContain("weights.bin");

			overlay.dispose();
			expect(root.tui.hasOverlay()).toBe(false);
		} finally {
			overlay.dispose();
			root.dispose();
		}
	});
});
