import type { ToolCallModel } from "@oh-my-pi/pi-tui/tools/model";

export interface ToolPresentationOptions {
	readonly expanded: boolean;
	readonly showImages: boolean;
	readonly hidden: boolean;
}

/**
 * Transcript-owned presentation state for every rendered tool model.
 * Execution routing is intentionally separate: settled cards remain responsive
 * to expansion, image visibility, and native row allocation changes.
 */
export class ToolPresentationRegistry {
	readonly #models = new Set<ToolCallModel>();
	readonly #allocations = new Map<ToolCallModel, number>();
	#expanded: boolean;
	#showImages: boolean;
	#hidden: boolean;

	constructor(options: ToolPresentationOptions) {
		this.#expanded = options.expanded;
		this.#showImages = options.showImages;
		this.#hidden = options.hidden;
	}

	register(model: ToolCallModel): void {
		this.#models.add(model);
		this.#apply(model);
	}

	unregister(model: ToolCallModel): void {
		this.#models.delete(model);
		this.#allocations.delete(model);
	}

	clear(): void {
		this.#models.clear();
		this.#allocations.clear();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		for (const model of this.#models) model.setUi({ expanded });
	}

	setVisibility(options: Pick<ToolPresentationOptions, "showImages" | "hidden">): void {
		this.#showImages = options.showImages;
		this.#hidden = options.hidden;
		for (const model of this.#models) this.#apply(model);
	}

	setAllocation(model: ToolCallModel, rows: number): void {
		if (!this.#models.has(model)) return;
		const allocation = Math.max(0, Math.trunc(rows));
		this.#allocations.set(model, allocation);
		model.setUi({ allocation: this.#hidden ? 0 : allocation });
	}

	#apply(model: ToolCallModel): void {
		model.setUi({
			expanded: this.#expanded,
			showImages: this.#showImages && !this.#hidden,
			allocation: this.#hidden ? 0 : (this.#allocations.get(model) ?? 0),
		});
	}
}
