import { describe, expect, it } from "bun:test";
import { createHookSelectorController } from "../src/overlays/hook-selector";

describe("hook selector slider", () => {
	it("exposes the initial slider segment", () => {
		const controller = createHookSelectorController(
			"Choose",
			["One"],
			() => {},
			() => {},
			{ slider: { segments: [{ label: "Low" }, { label: "High" }], index: 1 } },
		);
		expect(controller.sliderIndex()).toBe(1);
	});

	it("moves only within slider bounds and notifies on real changes", () => {
		const changes: number[] = [];
		const controller = createHookSelectorController(
			"Choose",
			["One"],
			() => {},
			() => {},
			{
				slider: {
					segments: [{ label: "Low" }, { label: "High" }],
					index: 0,
					onChange: index => changes.push(index),
				},
			},
		);

		controller.handleInput("\x1b[D");
		controller.handleInput("\x1b[C");
		controller.handleInput("\x1b[C");

		expect(controller.sliderIndex()).toBe(1);
		expect(changes).toEqual([1]);
	});

	it("uses left and right callbacks when no slider is configured", () => {
		const directions: string[] = [];
		const controller = createHookSelectorController(
			"Choose",
			["One"],
			() => {},
			() => {},
			{ onLeft: () => directions.push("left"), onRight: () => directions.push("right") },
		);

		controller.handleInput("\x1b[D");
		controller.handleInput("\x1b[C");

		expect(directions).toEqual(["left", "right"]);
	});
});
