import { createComponent, createContext, type JSX, useContext } from "solid-js";
import { formatKeyHints } from "../app-keybindings";
import { getKeybindings, type Keybinding, type KeyId } from "../keybindings";

/** Keybinding capabilities accepted by a reactive TUI root. */
export interface Keymap {
	getKeys(action: Keybinding): KeyId[];
	matches(key: string, action: Keybinding): boolean;
}

/** Reactive-view access to root key hints and matching. */
export interface KeymapAccess {
	/** Return the platform-formatted keys currently bound to an action. */
	hint(action: Keybinding): string;
	/** Test terminal key data against an action's current bindings. */
	matches(action: Keybinding, key: string): boolean;
}

/** Props for the root-scoped keymap provider. */
export interface KeymapProviderProps {
	readonly keymap: Keymap;
	readonly children: JSX.Element;
}

const KeymapContext = createContext<Keymap>();

/** Install a root-scoped keymap for descendants. */
export function KeymapProvider(props: KeymapProviderProps): JSX.Element {
	return createComponent(KeymapContext.Provider, {
		get value() {
			return props.keymap;
		},
		get children() {
			return props.children;
		},
	});
}

/** Read the active keymap, falling back to the existing process-wide bindings. */
export function useKeymap(): KeymapAccess {
	const scoped = useContext(KeymapContext);
	return {
		hint(action) {
			const keymap = scoped ?? getKeybindings();
			return formatKeyHints(keymap.getKeys(action));
		},
		matches(action, key) {
			const keymap = scoped ?? getKeybindings();
			return keymap.matches(key, action);
		},
	};
}
