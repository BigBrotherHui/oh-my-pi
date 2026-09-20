import { describe, expect, it } from "bun:test";
import { createComponent, createRoot } from "solid-js";
import { KeymapProvider, type Keymap, type KeymapAccess, useKeymap } from "../../src/host/keymap";

function accessFor(keymap: Keymap): { readonly access: KeymapAccess; readonly dispose: () => void } {
	let access: KeymapAccess | undefined;
	const dispose = createRoot(ownerDispose => {
		createComponent(KeymapProvider, {
			keymap,
			get children() {
				access = useKeymap();
				return undefined;
			},
		});
		return ownerDispose;
	});
	if (!access) throw new Error("Keymap provider did not evaluate its child");
	return { access, dispose };
}

describe("useKeymap", () => {
	it("formats hints and matches against current binding state", () => {
		let enabled = true;
		const keymap: Keymap = {
			getKeys() {
				return enabled ? ["ctrl+x"] : [];
			},
			matches(key) {
				return enabled && key === "\x18";
			},
		};
		const owned = accessFor(keymap);
		expect(owned.access.hint("tui.select.cancel")).toBe("Ctrl+X");
		expect(owned.access.matches("tui.select.cancel", "\x18")).toBe(true);

		enabled = false;
		expect(owned.access.hint("tui.select.cancel")).toBe("");
		expect(owned.access.matches("tui.select.cancel", "\x18")).toBe(false);
		owned.dispose();
	});
});
