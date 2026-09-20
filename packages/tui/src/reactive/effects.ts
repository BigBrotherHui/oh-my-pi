import { getOwner, onCleanup, runWithOwner } from "solid-js";
import type { Owner } from "solid-js";

/** A root-owned queue flushed at layout and terminal-commit boundaries. */
export interface EffectQueue {
	/** Add a persistent post-layout hook and return its remover. */
	registerLayoutHook(hook: () => void): () => void;
	/** Add a persistent post-commit hook and return its remover. */
	registerCommitHook(hook: () => void): () => void;
	/** Run a stable snapshot of the live layout hooks. */
	flushLayoutHooks(): void;
	/** Run a stable snapshot of the live commit hooks. */
	flushCommitHooks(): void;
}

const EFFECT_QUEUE = Symbol("pi-tui.effect-queue");

interface EffectOwner extends Owner {
	[EFFECT_QUEUE]?: EffectQueue;
}

function rootOf(owner: Owner): EffectOwner {
	let root = owner;
	while (root.owner) root = root.owner;
	return root as EffectOwner;
}

function requiredOwner(owner: Owner | null): Owner {
	if (!owner) throw new Error("TUI effects must be created or flushed within a reactive owner");
	return owner;
}

function createQueue(): EffectQueue {
	const layoutHooks = new Set<() => void>();
	const commitHooks = new Set<() => void>();

	function register(hooks: Set<() => void>, hook: () => void): () => void {
		hooks.add(hook);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			hooks.delete(hook);
		};
	}

	function flush(hooks: Set<() => void>): void {
		for (const hook of [...hooks]) {
			if (hooks.has(hook)) hook();
		}
	}

	return {
		registerLayoutHook(hook) {
			return register(layoutHooks, hook);
		},
		registerCommitHook(hook) {
			return register(commitHooks, hook);
		},
		flushLayoutHooks() {
			flush(layoutHooks);
		},
		flushCommitHooks() {
			flush(commitHooks);
		},
	};
}

/** Return the effect queue associated with an owner's root. */
export function getEffectQueue(owner: Owner | null = getOwner()): EffectQueue {
	const root = rootOf(requiredOwner(owner));
	return (root[EFFECT_QUEUE] ??= createQueue());
}

function registerOwnedHook(kind: "layout" | "commit", hook: () => void, owner: Owner | null): () => void {
	const actualOwner = requiredOwner(owner);
	const queue = getEffectQueue(actualOwner);
	const unregister = kind === "layout" ? queue.registerLayoutHook(hook) : queue.registerCommitHook(hook);
	runWithOwner(actualOwner, () => onCleanup(unregister));
	return unregister;
}

/** Register a layout-boundary hook owned by the supplied or current owner. */
export function registerLayoutHook(hook: () => void, owner: Owner | null = getOwner()): () => void {
	return registerOwnedHook("layout", hook, owner);
}

/** Register a commit-boundary hook owned by the supplied or current owner. */
export function registerCommitHook(hook: () => void, owner: Owner | null = getOwner()): () => void {
	return registerOwnedHook("commit", hook, owner);
}

/** Run all live layout hooks for an owner's root. */
export function flushLayoutHooks(owner: Owner | null = getOwner()): void {
	getEffectQueue(owner).flushLayoutHooks();
}

/** Run all live commit hooks for an owner's root. */
export function flushCommitHooks(owner: Owner | null = getOwner()): void {
	getEffectQueue(owner).flushCommitHooks();
}

/** Register a callback to run after layouts that include this owner. */
export function createLayoutEffect(fn: () => void): void {
	registerLayoutHook(fn);
}

/** Register a callback to run after terminal commits that include this owner. */
export function createCommitEffect(fn: () => void): void {
	registerCommitHook(fn);
}
