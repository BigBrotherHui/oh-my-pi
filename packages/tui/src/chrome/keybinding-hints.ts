import { type AppKeybinding, formatKeyHints, type KeybindingsManager } from "../app-keybindings";
import { getKeybindings, type Keybinding } from "../keybindings";

export function editorKey(action: Keybinding): string {
	return formatKeyHints(getKeybindings().getKeys(action));
}

export function appKey(keybindings: KeybindingsManager, action: AppKeybinding): string {
	return formatKeyHints(keybindings.getKeys(action));
}
