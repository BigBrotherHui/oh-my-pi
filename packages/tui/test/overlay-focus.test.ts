import { describe, expect, it } from "bun:test";
import { StandaloneInputView } from "../src/apps/standalone-picker-view";
import { createComponent } from "../src/host/renderer";
import { mountOverlay, Portal, type OverlayDisposer } from "../src/host/overlay";
import { createSignal, type JSX } from "../src/reactive";
import { render, type RootHandle } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";
import { VirtualTerminal } from "./virtual-terminal";

function inputView(finished: Array<string | null>): JSX.Element {
	return createComponent(StandaloneInputView, {
		onFinish: value => finished.push(value),
	});
}

function showFullscreenOverlay(root: RootHandle, children: () => JSX.Element): OverlayDisposer {
	return mountOverlay(root.tui, () =>
		createComponent(Portal, {
			to: "overlay",
			fullscreen: true,
			width: "100%",
			maxHeight: "100%",
			children: children(),
		}),
	);
}

describe("TUI overlay focus", () => {
	it("keeps keyboard focus on the visible overlay when a hidden surface requests focus", () => {
		const terminal = new VirtualTerminal(80, 24);
		const editorInputs: Array<string | null> = [];
		const settingsInputs: Array<string | null> = [];
		const root = render(() => inputView(editorInputs), { terminal, theme: loadThemeSync("dark") });
		let overlay: OverlayDisposer | undefined;
		try {
			overlay = showFullscreenOverlay(root, () => inputView(settingsInputs));
			root.tui.renderNow();

			terminal.sendInput("x");
			terminal.sendInput("\r");

			expect(settingsInputs).toEqual(["x"]);
			expect(editorInputs).toEqual([]);
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});

	it("allows a visible overlay to delegate focus to an owned prompt", () => {
		const terminal = new VirtualTerminal(80, 24);
		const editorInputs: Array<string | null> = [];
		const codeInputs: Array<string | null> = [];
		const root = render(() => inputView(editorInputs), { terminal, theme: loadThemeSync("dark") });
		let overlay: OverlayDisposer | undefined;
		try {
			overlay = showFullscreenOverlay(root, () => inputView(codeInputs));
			root.tui.renderNow();

			terminal.sendInput("code");
			terminal.sendInput("\r");

			expect(codeInputs).toEqual(["code"]);
			expect(editorInputs).toEqual([]);
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});

	it("hands focus to the live editor-slot owner after a fullscreen overlay closes (issue #3349)", () => {
		const terminal = new VirtualTerminal(80, 24);
		const editorInputs: Array<string | null> = [];
		const approvalInputs: Array<string | null> = [];
		const [approvalVisible, setApprovalVisible] = createSignal(false);
		const root = render(() => () => (approvalVisible() ? inputView(approvalInputs) : inputView(editorInputs)), {
			terminal,
			theme: loadThemeSync("dark"),
		});
		let overlay: OverlayDisposer | undefined;
		try {
			overlay = showFullscreenOverlay(root, () => inputView([]));
			root.tui.renderNow();
			setApprovalVisible(true);
			root.tui.renderNow();
			overlay.dispose();
			overlay = undefined;
			root.tui.renderNow();

			terminal.sendInput("approve");
			terminal.sendInput("\r");
			expect(approvalInputs).toEqual(["approve"]);
			expect(editorInputs).toEqual([]);
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});

	it("restores input to the current retained editor slot after an overlay closes", () => {
		const terminal = new VirtualTerminal(80, 24);
		const editorInputs: Array<string | null> = [];
		const approvalInputs: Array<string | null> = [];
		const [approvalVisible, setApprovalVisible] = createSignal(false);
		const root = render(() => () => (approvalVisible() ? inputView(approvalInputs) : inputView(editorInputs)), {
			terminal,
			theme: loadThemeSync("dark"),
		});
		let overlay: OverlayDisposer | undefined;
		try {
			overlay = mountOverlay(root.tui, () =>
				createComponent(Portal, {
					to: "overlay",
					children: inputView([]),
				}),
			);
			root.tui.renderNow();
			setApprovalVisible(true);
			root.tui.renderNow();
			overlay.dispose();
			overlay = undefined;
			root.tui.renderNow();

			terminal.sendInput("approve");
			terminal.sendInput("\r");
			expect(approvalInputs).toEqual(["approve"]);
			expect(editorInputs).toEqual([]);
		} finally {
			overlay?.dispose();
			root.dispose();
		}
	});
});
