import { scheduler } from "node:timers/promises";
import { ProcessTerminal, type Terminal } from "@oh-my-pi/pi-tui/terminal";
import { render, type RootHandle } from "@oh-my-pi/pi-tui/root";
import {
	COMPOSER_DEFAULTS,
	ComposerChromeView,
	createComposerChromeStore,
	type ComposerChromeStore,
	type ComposerPreferences,
	type ComposerWelcomeUpdate,
} from "@oh-my-pi/pi-tui/prompt/composer";
import { createTranscriptStore } from "@oh-my-pi/pi-tui/chat/transcript-store";
import type { LspServerInfo, RecentSession } from "@oh-my-pi/pi-tui/prompt/welcome";
import {
	type ComposerThemePreferences,
	readComposerStartupCache,
	writeComposerLspCache,
	writeComposerRecentSessionsCache,
	writeComposerUiCache,
} from "@oh-my-pi/pi-tui/prompt/composer-cache";
import { initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import * as logger from "@oh-my-pi/pi-utils/logger";

/** Inputs available at the CLI prepaint boundary before command modules load. */
export interface PrepaintComposerOptions {
	readonly terminal?: Terminal;
	readonly now?: () => number;
	readonly version?: string;
	readonly cwd?: string;
	readonly preferences?: Partial<ComposerPreferences>;
	readonly theme?: ComposerThemePreferences;
	readonly recentSessions?: () => Promise<RecentSession[]>;
	readonly cache?: boolean;
	/** Clear native terminal history before drawing the speculative first frame. */
	readonly clearScrollback?: boolean;
}

/** Final settings pushed into the live chrome after Settings and the theme resolve. */
export interface PrepaintComposerPreferences extends ComposerPreferences {
	readonly theme: ComposerThemePreferences;
}

interface PendingPrepaintRoot {
	readonly root: RootHandle;
	readonly terminal: Terminal;
	readonly chrome: ComposerChromeStore;
	readonly cwd: string;
	readonly cache: boolean;
	recentSessions?: Promise<RecentSession[] | undefined>;
}

let pendingPrepaintRoot: PendingPrepaintRoot | undefined;

/** Ownership token for the root that drew the speculative first frame. */
export class ComposerLease {
	readonly root: RootHandle;
	readonly terminal: Terminal;
	readonly chrome: ComposerChromeStore;
	/** Recent-session rows already loading in parallel with the runtime module graph. */
	readonly recentSessions?: Promise<RecentSession[] | undefined>;
	#adopted = false;

	constructor(pending: PendingPrepaintRoot) {
		this.root = pending.root;
		this.terminal = pending.terminal;
		this.chrome = pending.chrome;
		this.recentSessions = pending.recentSessions;
	}

	/** Mark the caller as the root owner without interrupting terminal input. */
	adopt(): void {
		this.#adopted = true;
	}

	/** Dispose a root that never reached interactive mode. */
	dispose(): void {
		if (!this.#adopted) this.root.dispose();
	}
}

/** Start the reactive terminal root with cached startup data before command modules load. */
export function beginStartupComposer(options: PrepaintComposerOptions = {}): void {
	if (pendingPrepaintRoot) throw new Error("A prepaint root is already active");
	const cwd = options.cwd ?? process.cwd();
	const cache = options.cache !== false;
	const cached = cache
		? readComposerStartupCache(cwd)
		: {
				preferences: undefined,
				theme: undefined,
				welcome: undefined,
				recentSessions: [],
				lspServers: [],
				status: undefined,
			};
	const themePreferences = { ...cached.theme, ...options.theme };
	initThemeSync(
		themePreferences.symbolPreset,
		themePreferences.colorBlindMode,
		themePreferences.darkTheme,
		themePreferences.lightTheme,
	);
	const preferences = { ...COMPOSER_DEFAULTS, ...cached.preferences, ...options.preferences };
	const welcome: ComposerWelcomeUpdate = {
		version: options.version ?? "",
		modelName: cached.welcome?.modelName,
		providerName: cached.welcome?.providerName,
		recentSessions: cached.recentSessions,
		lspServers: cached.lspServers,
	};
	const terminal = options.terminal ?? new ProcessTerminal();
	const chrome = createComposerChromeStore({ transcript: createTranscriptStore(), preferences, welcome });
	const root = render(() => ComposerChromeView({ store: chrome }), {
		terminal,
		theme,
		clearScrollback: options.clearScrollback,
		deferInput: true,
	});
	root.tui.setResizeScrollback(preferences.resizeScrollback);
	const pending: PendingPrepaintRoot = { root, terminal, chrome, cwd, cache };
	pendingPrepaintRoot = pending;
	// Keep filesystem discovery out of the synchronous prepaint turn. render()
	// already queued the first frame; recents can begin once the event loop yields.
	pending.recentSessions = loadRecentSessionsAfterFirstFrame(pending, options.recentSessions);
}

/** Take the live prepaint root away from the module-level startup owner. */
export function takeStartupComposerLease(): ComposerLease | undefined {
	const pending = pendingPrepaintRoot;
	pendingPrepaintRoot = undefined;
	return pending ? new ComposerLease(pending) : undefined;
}

/** Stop and forget any prepaint root that never reached InteractiveMode. */
export function stopPendingStartupComposer(): void {
	pendingPrepaintRoot?.root.dispose();
	pendingPrepaintRoot = undefined;
}

/** Apply final settings to the pending chrome and cache them for the next first frame. */
export function applyStartupComposerPreferences(update: PrepaintComposerPreferences): void {
	const pending = pendingPrepaintRoot;
	if (!pending) return;
	const preferences: ComposerPreferences = {
		quiet: update.quiet,
		composerShape: update.composerShape,
		showHardwareCursor: update.showHardwareCursor,
		maxInlineImages: update.maxInlineImages,
		resizeScrollback: update.resizeScrollback,
		imeSafeCursor: update.imeSafeCursor,
		autocompleteMaxVisible: update.autocompleteMaxVisible,
		spellingTypoDetection: update.spellingTypoDetection,
		spellingAutocomplete: update.spellingAutocomplete,
		spellingAutocorrect: update.spellingAutocorrect,
	};
	pending.chrome.setPreferences(preferences);
	pending.root.tui.setResizeScrollback(preferences.resizeScrollback);
	if (pending.cache) {
		void writeComposerUiCache(pending.cwd, preferences, update.theme).catch(error => {
			logger.debug("composer UI cache write failed", { error });
		});
	}
}

/** Apply discovered project LSP rows and cache them for the next first frame. */
export function setStartupComposerLspServers(servers: LspServerInfo[]): void {
	const pending = pendingPrepaintRoot;
	if (!pending) return;
	pending.chrome.updateWelcome({ lspServers: servers });
	if (pending.cache) {
		void writeComposerLspCache(pending.cwd, servers).catch(error => {
			logger.debug("composer LSP cache write failed", { error });
		});
	}
}

async function loadRecentSessionsAfterFirstFrame(
	pending: PendingPrepaintRoot,
	loadOverride: (() => Promise<RecentSession[]>) | undefined,
): Promise<RecentSession[] | undefined> {
	await scheduler.yield();
	try {
		const sessions = loadOverride ? await loadOverride() : await loadRecentSessions(pending.cwd);
		if (pending.cache) {
			void writeComposerRecentSessionsCache(pending.cwd, sessions).catch(error => {
				logger.debug("composer recent sessions cache write failed", { error });
			});
		}
		if (pendingPrepaintRoot === pending) pending.chrome.updateWelcome({ recentSessions: sessions });
		return sessions;
	} catch (error) {
		logger.debug("composer recent sessions load failed", { error });
		return undefined;
	}
}

async function loadRecentSessions(cwd: string): Promise<RecentSession[]> {
	const [{ getRecentSessions }, { computeDefaultSessionDir }, { FileSessionStorage }] = await Promise.all([
		import("../session/session-listing"),
		import("../session/session-paths"),
		import("../session/session-storage"),
	]);
	const storage = new FileSessionStorage();
	const dir = computeDefaultSessionDir(cwd, storage);
	const list = await getRecentSessions(dir, 4, storage);
	return list.map(session => ({ name: session.name, timeAgo: session.timeAgo }));
}
