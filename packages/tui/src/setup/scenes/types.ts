import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { OAuthBrowserSessionRequest } from "@oh-my-pi/pi-ai/oauth/types";
import type { Terminal } from "../../terminal";
import type { ComposerPreviewStatusSource } from "../../overlays/composer-shape-preview";
import type { ComposerShape } from "../../overlays/composer-shape-registry";
import type { ModelBrowserSource } from "../../overlays/model-browser";
import type { Theme, SymbolPreset } from "../../theme/theme";
import type { SearchProviderId } from "../../tools/web-search";
import type { Accessor, JSX } from "../../reactive";
import type { TUI } from "../../tui";

/** Domain effects and root dependencies used by onboarding views. */
export interface SetupHost {
	/** Existing retained application surface that owns the fullscreen setup portal. */
	readonly tui: TUI;
	readonly terminal: Terminal;
	readonly theme: Theme;
	readonly statusLine: ComposerPreviewStatusSource | undefined;
	readonly composerShape: ComposerShape;
	readonly symbolPreset: SymbolPreset;
	readonly colorBlindMode: boolean;
	readonly webSearchSelection: SearchProviderId | "auto";
	readonly disabledProviders: readonly string[];
	readonly authStorage: AuthStorage;
	readonly modelSource: ModelBrowserSource;
	getModels(): { available: Model[]; all: Model[]; current: Model | undefined };
	refreshModels(): Promise<void>;
	selectModel(model: Model, selector: string): Promise<void>;
	refreshProvider(provider: string): Promise<void>;
	saveComposerShape(shape: ComposerShape): Promise<void>;
	saveSymbolPreset(preset: SymbolPreset): void;
	saveColorBlindMode(enabled: boolean): void;
	saveTheme(mode: "dark" | "light", name: string): void;
	isSearchProviderAvailable(id: SearchProviderId): Promise<boolean>;
	saveWebSearchSelection(id: SearchProviderId | "auto"): void;
	captureBrowserSession(request: OAuthBrowserSessionRequest, signal?: AbortSignal): Promise<string>;
	copyToClipboard(text: string): Promise<void>;
	openInBrowser(url: string): void;
	markComplete(version: number): Promise<void>;
	playWelcomeIntro(): void;
	showError(message: string): void;
}

/** Root dependencies for the self-contained startup splash. */
export interface SetupUiHost {
	readonly terminal: Terminal;
	readonly theme: Theme;
}

/** One scene's terminal result. */
export type SetupSceneResult = "done" | "skipped";

/** Final result returned by the wizard runner. */
export interface SetupResult {
	readonly status: "completed" | "cancelled";
	readonly scenes: readonly { readonly id: string; readonly result: SetupSceneResult }[];
}

/** Reactive scene inputs supplied by the wizard. */
export interface SetupSceneContext {
	readonly host: SetupHost;
	/** Scene-body rows remaining after the wizard's title, tabs, and footer. */
	readonly availableRows?: Accessor<number>;
	complete(result: SetupSceneResult): void;
}

/** Versioned reactive onboarding scene. */
export interface SetupScene {
	readonly id: string;
	readonly title: string;
	readonly subtitle?: string;
	readonly minVersion: number;
	shouldRun?(host: SetupHost): boolean | Promise<boolean>;
	View(context: SetupSceneContext): JSX.Element;
}
