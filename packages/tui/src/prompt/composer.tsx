import type { RichText } from "../core/richtext";
import type { Style } from "../core/style";
import { TranscriptView, type TranscriptStore } from "../chat/transcript-store";
import { batch, createSignal, Show, type Accessor, type JSX } from "../reactive";
import type { ResizeScrollbackMode } from "../tui";
import {
	createWelcomeStore,
	type LspServerInfo,
	type RecentSession,
	type WelcomeData,
	type WelcomeStore,
	WelcomeView,
} from "./welcome";

/** Live settings that affect the composer before and after session adoption. */
export interface ComposerPreferences {
	readonly quiet: boolean;
	readonly composerShape: string;
	readonly showHardwareCursor: boolean;
	readonly maxInlineImages: number;
	readonly resizeScrollback: ResizeScrollbackMode;
	readonly imeSafeCursor: boolean;
	readonly autocompleteMaxVisible: number;
	readonly spellingTypoDetection: boolean;
	readonly spellingAutocomplete: boolean;
	readonly spellingAutocorrect: boolean;
}

/** Settings-schema-compatible defaults used when constructing a composer chrome store. */
export const COMPOSER_DEFAULTS: ComposerPreferences = {
	quiet: false,
	composerShape: "band",
	showHardwareCursor: true,
	maxInlineImages: 8,
	resizeScrollback: "rebuild",
	imeSafeCursor: false,
	autocompleteMaxVisible: 10,
	spellingTypoDetection: true,
	spellingAutocomplete: true,
	spellingAutocorrect: false,
};

/** Welcome data supplied initially or patched as startup resolves it. */
export interface ComposerWelcomeUpdate {
	readonly version?: string;
	readonly modelName?: string;
	readonly providerName?: string;
	readonly recentSessions?: readonly RecentSession[];
	readonly lspServers?: readonly LspServerInfo[];
}

/** Cached status chrome from a previous startup. */
export interface ComposerStatusSnapshot {
	readonly shape: string;
	readonly borderStyle?: Style;
	readonly topBorder?: {
		readonly content: RichText;
		readonly width: number;
	};
	readonly bottomRows: RichText;
}

/** One click target's row span within the mutable viewport (half-open `[start, end)`). */
export interface ViewportClickSpan {
	readonly start: number;
	readonly end: number;
	readonly candidates: (local: number) => string[];
}

/** Resolve click candidates for one mutable viewport row. */
export function routeViewportClick(spans: readonly ViewportClickSpan[], index: number): string[] {
	if (!Number.isInteger(index) || index < 0) return [];
	for (const span of spans) {
		if (index >= span.start && index < span.end) return span.candidates(index - span.start);
	}
	return [];
}

/** Reserved click-candidate id for the pinned HUD expander row. */
export const PINNED_HUD_TOGGLE_ID = "@omp:toggle-pinned-hud";

/** Chrome content; factories mount reactive resources under the chrome root's owner. */
export type ComposerChromeSlot = JSX.Element | (() => JSX.Element);

export interface ComposerChromeSlots {
	readonly editor?: ComposerChromeSlot;
	readonly headerBefore?: ComposerChromeSlot;
	readonly headerAfter?: ComposerChromeSlot;
	readonly beforeEditor?: ComposerChromeSlot;
	readonly status?: ComposerChromeSlot;
	readonly afterEditor?: ComposerChromeSlot;
}

/** Reactive state for the declarative composer root. Root lifecycle stays with `render()`. */
export interface ComposerChromeStore {
	readonly transcript: TranscriptStore;
	readonly preferences: Accessor<ComposerPreferences>;
	readonly welcome: Accessor<ComposerWelcomeUpdate>;
	/** Startup welcome panel state; rendered above the transcript until dismissed. */
	readonly welcomeStore: WelcomeStore;
	readonly showWelcome: Accessor<boolean>;
	readonly editor: Accessor<ComposerChromeSlot>;
	readonly headerBefore: Accessor<ComposerChromeSlot>;
	readonly headerAfter: Accessor<ComposerChromeSlot>;
	readonly beforeEditor: Accessor<ComposerChromeSlot>;
	readonly status: Accessor<ComposerChromeSlot>;
	readonly afterEditor: Accessor<ComposerChromeSlot>;
	readonly viewportClickSpans: Accessor<readonly ViewportClickSpan[]>;
	readonly hoveredClickId: Accessor<string | undefined>;
	setPreferences(update: Partial<ComposerPreferences>): void;
	updateWelcome(update: ComposerWelcomeUpdate): void;
	/** Start the logo intro animation (no-op when the welcome is hidden). */
	playWelcomeIntro(): void;
	setShowWelcome(visible: boolean): void;
	setSlots(slots: ComposerChromeSlots): void;
	setHeaderExtras(before: ComposerChromeSlot, after: ComposerChromeSlot): void;
	setViewportClickSpans(spans: readonly ViewportClickSpan[]): void;
	viewportClickCandidates(index: number): string[];
	setHoveredClickId(id: string | undefined): void;
}

export interface ComposerChromeStoreOptions extends ComposerChromeSlots {
	readonly transcript: TranscriptStore;
	readonly preferences?: Partial<ComposerPreferences>;
	readonly welcome?: ComposerWelcomeUpdate;
	/** Render the welcome panel initially (default `true` unless `preferences.quiet`). */
	readonly showWelcome?: boolean;
	readonly viewportClickSpans?: readonly ViewportClickSpan[];
}

function definedWelcomeFields(update: ComposerWelcomeUpdate): Partial<WelcomeData> {
	return {
		...(update.version !== undefined ? { version: update.version } : {}),
		...(update.modelName !== undefined ? { modelName: update.modelName } : {}),
		...(update.providerName !== undefined ? { providerName: update.providerName } : {}),
		...(update.recentSessions !== undefined ? { recentSessions: update.recentSessions } : {}),
		...(update.lspServers !== undefined ? { lspServers: update.lspServers } : {}),
	};
}

/** Create the mutable chrome state consumed by `ComposerChromeView`. */
export function createComposerChromeStore(options: ComposerChromeStoreOptions): ComposerChromeStore {
	const [preferences, setPreferences] = createSignal<ComposerPreferences>({
		...COMPOSER_DEFAULTS,
		...options.preferences,
	});
	const [welcome, setWelcome] = createSignal<ComposerWelcomeUpdate>(options.welcome ?? {});
	const welcomeStore = createWelcomeStore(definedWelcomeFields(options.welcome ?? {}));
	const [showWelcome, setShowWelcome] = createSignal(options.showWelcome ?? !(options.preferences?.quiet ?? false));
	const [editor, setEditor] = createSignal<ComposerChromeSlot>(options.editor);
	const [headerBefore, setHeaderBefore] = createSignal<ComposerChromeSlot>(options.headerBefore);
	const [headerAfter, setHeaderAfter] = createSignal<ComposerChromeSlot>(options.headerAfter);
	const [beforeEditor, setBeforeEditor] = createSignal<ComposerChromeSlot>(options.beforeEditor);
	const [status, setStatus] = createSignal<ComposerChromeSlot>(options.status);
	const [afterEditor, setAfterEditor] = createSignal<ComposerChromeSlot>(options.afterEditor);
	const [viewportClickSpans, setViewportClickSpans] = createSignal<readonly ViewportClickSpan[]>(
		options.viewportClickSpans ?? [],
	);
	const [hoveredClickId, setHoveredClickId] = createSignal<string | undefined>();

	return {
		transcript: options.transcript,
		preferences,
		welcome,
		welcomeStore,
		showWelcome,
		editor,
		headerBefore,
		headerAfter,
		beforeEditor,
		status,
		afterEditor,
		viewportClickSpans,
		hoveredClickId,
		setPreferences: update => setPreferences(current => ({ ...current, ...update })),
		updateWelcome: update =>
			batch(() => {
				setWelcome(current => ({ ...current, ...update }));
				welcomeStore.update(definedWelcomeFields(update));
			}),
		playWelcomeIntro: () => {
			if (showWelcome()) welcomeStore.playIntro();
		},
		setShowWelcome,
		setSlots: slots =>
			batch(() => {
				if ("editor" in slots) setEditor(() => slots.editor);
				if ("headerBefore" in slots) setHeaderBefore(() => slots.headerBefore);
				if ("headerAfter" in slots) setHeaderAfter(() => slots.headerAfter);
				if ("beforeEditor" in slots) setBeforeEditor(() => slots.beforeEditor);
				if ("status" in slots) setStatus(() => slots.status);
				if ("afterEditor" in slots) setAfterEditor(() => slots.afterEditor);
			}),
		setHeaderExtras: (before, after) =>
			batch(() => {
				setHeaderBefore(() => before);
				setHeaderAfter(() => after);
			}),
		setViewportClickSpans,
		viewportClickCandidates: index => routeViewportClick(viewportClickSpans(), index),
		setHoveredClickId,
	};
}

function ComposerChromeSlotView(props: { readonly slot: Accessor<ComposerChromeSlot> }): JSX.Element {
	return (
		<Show when={props.slot()} keyed>
			{(slot: ComposerChromeSlot) => (typeof slot === "function" ? slot() : slot)}
		</Show>
	);
}

/** Declarative transcript/editor/chrome layout driven entirely by `ComposerChromeStore`. */
export function ComposerChromeView(props: { readonly store: ComposerChromeStore }): JSX.Element {
	const store = props.store;
	return (
		<stack>
			<TranscriptView
				store={store.transcript}
				headerSettled={store.welcomeStore.introStartedAt() === undefined}
				header={() => (
					<stack>
						<ComposerChromeSlotView slot={store.headerBefore} />
						<Show when={store.showWelcome()}>
							<WelcomeView store={store.welcomeStore} />
						</Show>
						<ComposerChromeSlotView slot={store.headerAfter} />
					</stack>
				)}
			/>
			<ComposerChromeSlotView slot={store.beforeEditor} />
			<ComposerChromeSlotView slot={store.editor} />
			<ComposerChromeSlotView slot={store.status} />
			<ComposerChromeSlotView slot={store.afterEditor} />
		</stack>
	);
}
