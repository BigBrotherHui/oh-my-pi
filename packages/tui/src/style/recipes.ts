import type { StyleProps } from "./types";

const recipes = new Map<string, StyleProps>();

/** Register or replace a named style recipe. */
export function defineRecipe(name: string, style: StyleProps): void {
	const normalized = name.trim();
	if (normalized.length === 0) throw new Error("Recipe name cannot be empty");
	recipes.set(normalized, Object.freeze({ ...style }));
}

/** Look up a named recipe, returning undefined for an unregistered name. */
export function getRecipe(name: string): StyleProps | undefined {
	return recipes.get(name);
}

/** Return the registered recipe names in deterministic insertion order. */
export function recipeNames(): readonly string[] {
	return [...recipes.keys()];
}

defineRecipe("tool.card.receiving", { background: "toolPendingBg" });
defineRecipe("tool.card.queued", { background: "toolPendingBg" });
defineRecipe("tool.card.running", { background: "toolPendingBg" });
defineRecipe("tool.card.success", { background: "toolSuccessBg" });
defineRecipe("tool.card.error", { background: "toolErrorBg" });
defineRecipe("tool.header", { color: "accent" });
defineRecipe("tool.header.meta", { color: "dim" });
