import { afterEach, describe, expect, it, vi } from "bun:test";

import { createHookInputController, HookInputView, type HookInputProps } from "@oh-my-pi/pi-tui/overlays/hook-input";
import { dispatchHostInput } from "../src/host/overlay";
import { mountForTest } from "../src/testing";

function createProps(overrides: Partial<HookInputProps> = {}): HookInputProps {
	return {
		title: "Prompt",
		onSubmit: () => {},
		onCancel: () => {},
		...overrides,
	};
}

describe("HookInput", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resets its millisecond timeout on interaction and expires once when idle", () => {
		vi.useFakeTimers();

		const onCancel = vi.fn();
		const onTimeout = vi.fn();
		const controller = createHookInputController(
			createProps({
				onCancel,
				options: { timeout: 1_000, onTimeout },
			}),
		);

		vi.advanceTimersByTime(900);
		controller.reset();
		expect(controller.title()).toBe("Prompt (1s)");

		vi.advanceTimersByTime(900);
		controller.reset();

		vi.advanceTimersByTime(900);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		vi.advanceTimersByTime(200);
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onCancel).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("starts focused, submits and cancels through the single-line input", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const controller = createHookInputController(createProps({ onSubmit, onCancel }));
		const root = mountForTest(() => HookInputView({ controller, onSubmit, onCancel }), { width: 28 });

		try {
			dispatchHostInput(root.root, "h");
			dispatchHostInput(root.root, "i");
			dispatchHostInput(root.root, "\r");
			expect(onSubmit).toHaveBeenCalledWith("hi");

			dispatchHostInput(root.root, "\x1b");
			expect(onCancel).toHaveBeenCalledTimes(1);
		} finally {
			root.dispose();
			controller.dispose();
		}
	});

	it("keeps the historical one-line form spacing and clips safely when narrow", () => {
		const controller = createHookInputController(createProps());
		const root = mountForTest(() => HookInputView({ controller, onSubmit: () => {}, onCancel: () => {} }), {
			width: 28,
		});

		try {
			const wide = root.text();
			expect(wide).toHaveLength(7);
			expect(wide[1]).toMatch(/^│ {26}│$/);
			expect(wide[2]).toContain("> ");
			expect(wide[3]).toMatch(/^│ {26}│$/);
			expect(wide[4]).toContain("enter submit  esc cancel");
			expect(wide[5]).toMatch(/^│ {26}│$/);

			for (const row of root.text(4)) expect(row.length).toBeLessThanOrEqual(4);
		} finally {
			root.dispose();
			controller.dispose();
		}
	});

	it("pastes through the focused field without submitting a newline", () => {
		const onSubmit = vi.fn();
		const controller = createHookInputController(createProps({ onSubmit }));
		const root = mountForTest(() => HookInputView({ controller, onSubmit, onCancel: () => {} }), { width: 28 });

		try {
			dispatchHostInput(root.root, "\x1b[200~first\nsecond\x1b[201~");
			dispatchHostInput(root.root, "\r");
			expect(onSubmit).toHaveBeenCalledWith("firstsecond");
		} finally {
			root.dispose();
			controller.dispose();
		}
	});
});
