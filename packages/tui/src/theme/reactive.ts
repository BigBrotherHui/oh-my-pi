import { createComponent, createContext, createSignal, type Accessor, type JSX, untrack, useContext } from "solid-js";
import type { Color } from "../core/style";
import { Damage } from "../host/types";
import { TERMINAL, type TerminalInfo } from "../terminal-capabilities";
import { isValidThemeColor, type ThemeBg, type ThemeColor } from "./schema";
import type { SymbolKey } from "./symbols";
import { onThemeChange, theme as currentTheme, type Theme } from "./theme";

/** Theme values and terminal capabilities exposed to reactive views. */
export interface ThemeAccess {
	/** Current palette; reading it tracks palette replacement. */
	readonly theme: Accessor<Theme>;
	/** Resolve a semantic foreground or background token, with optional foreground contrast context. */
	token(name: ThemeColor | ThemeBg, background?: ThemeBg): Color;
	/** Resolve a glyph through the current symbol preset. */
	symbol(key: SymbolKey): string;
	/** Immutable terminal feature snapshot for capability-gated views. */
	readonly capabilities: Readonly<TerminalInfo>;
}

/** Root-owned reactive theme signal and its explicit lifecycle. */
export interface ThemeSignal extends ThemeAccess {
	/** Replace the root palette and invalidate the host root at the required granularity. */
	setTheme(theme: Theme): void;
	/** Disconnect the global theme-change bridge. */
	dispose(): void;
}

/** Host integration options for a root theme signal. */
export interface ThemeSignalOptions {
	/** Terminal capabilities visible through `useTheme()`. */
	readonly capabilities?: Readonly<TerminalInfo>;
	/** Root-only damage callback used by the compositor. */
	readonly invalidate?: (damage: Damage) => void;
}

/** Props for a nested reactive theme provider. */
export interface ThemeScopeProps {
	readonly theme: Theme;
	readonly capabilities?: Readonly<TerminalInfo>;
	readonly children?: JSX.Element;
}

const ThemeContext = createContext<ThemeAccess>();

/** Create a root palette signal and bridge assignments from the legacy theme singleton. */
export function createThemeSignal(initial: Theme, options: ThemeSignalOptions = {}): ThemeSignal {
	const [theme, writeTheme] = createSignal(initial, { equals: false });
	let disposed = false;

	const setTheme = (next: Theme): void => {
		if (disposed || theme() === next) return;
		const damage = theme().getSymbolPreset() === next.getSymbolPreset() ? Damage.Paint : Damage.Layout;
		writeTheme(() => next);
		options.invalidate?.(damage);
	};
	const unbind = onThemeChange(() => {
		if (currentTheme !== undefined) setTheme(currentTheme);
	});
	const access: ThemeSignal = {
		theme,
		setTheme,
		dispose() {
			if (disposed) return;
			disposed = true;
			unbind();
		},
		token(name, background) {
			const current = theme();
			if (!isValidThemeColor(name)) return current.bgColor(name);
			return background === undefined ? current.fgColor(name) : current.fgOnBgColor(name, background);
		},
		symbol(key) {
			return theme().symbol(key);
		},
		capabilities: options.capabilities ?? TERMINAL,
	};

	return access;
}

/** Read the nearest root or nested theme provider. */
export function useTheme(): ThemeAccess {
	const access = useContext(ThemeContext);
	if (access === undefined) throw new Error("useTheme() requires a TUI root or ThemeScope");
	return access;
}

/** Install a root theme signal around a view without requiring TSX in the compositor. */
export function withThemeSignal(signal: ThemeAccess, view: () => JSX.Element): JSX.Element {
	return createComponent(ThemeContext.Provider, {
		value: signal,
		get children() {
			return untrack(view);
		},
	});
}

/** Override the palette for a reactive subtree while retaining root capabilities. */
export function ThemeScope(props: ThemeScopeProps): JSX.Element {
	const parent = useTheme();
	const access: ThemeAccess = {
		theme: () => props.theme,
		token(name, background) {
			const current = props.theme;
			if (!isValidThemeColor(name)) return current.bgColor(name);
			return background === undefined ? current.fgColor(name) : current.fgOnBgColor(name, background);
		},
		symbol(key) {
			return props.theme.symbol(key);
		},
		get capabilities() {
			return props.capabilities ?? parent.capabilities;
		},
	};
	return createComponent(ThemeContext.Provider, {
		value: access,
		get children() {
			return props.children;
		},
	});
}
