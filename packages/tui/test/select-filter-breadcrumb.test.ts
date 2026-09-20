import { afterEach, describe, expect, it } from "bun:test";
import { currentLoopPhase, popLoopPhase, takeRecentLoopPhase } from "@oh-my-pi/pi-utils";
import type { SelectOption } from "../src/host/elements/select";
import { createSelectController, type SelectController } from "../src/overlays/select-overlay";
import { createRoot } from "../src/reactive";

const items: SelectOption[] = [
	{ value: "alpha", label: "Alpha" },
	{ value: "beta", label: "Beta" },
	{ value: "gamma", label: "Gamma" },
];

afterEach(() => {
	while (currentLoopPhase() !== undefined) popLoopPhase();
	takeRecentLoopPhase();
});

function withController(run: (controller: SelectController) => void): void {
	createRoot(dispose => {
		try {
			run(createSelectController({ options: () => items, maxRows: () => 2 }));
		} finally {
			dispose();
		}
	});
}

describe("native select fuzzy-filter loop-phase breadcrumb", () => {
	it("wraps fuzzy filtering in a ui.select-filter breadcrumb the watchdog can read", () => {
		withController(controller => {
			controller.setQuery("al");

			expect(currentLoopPhase()).toBeUndefined();
			expect(takeRecentLoopPhase()).toBe("ui.select-filter");
		});
	});

	it("does not breadcrumb an empty or whitespace query", () => {
		withController(controller => {
			controller.setQuery("   ");

			expect(takeRecentLoopPhase()).toBeUndefined();
		});
	});
});
