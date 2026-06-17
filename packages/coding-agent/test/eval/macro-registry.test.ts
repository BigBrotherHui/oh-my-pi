import { describe, expect, it } from "bun:test";
import {
	clearAllMacroDefinitions,
	clearMacroRuntime,
	lookupMacroDefinition,
	recordMacroStatusEvent,
} from "@oh-my-pi/pi-coding-agent/eval/macro-registry";

const cwd = "/repo";

describe("macro registry", () => {
	it("routes registered names by normalized eval session", () => {
		clearAllMacroDefinitions();
		recordMacroStatusEvent("python:s1", cwd, {
			op: "macro",
			action: "register",
			runtime: "py",
			name: "pow2",
			revision: 1,
		});
		const lookup = lookupMacroDefinition("s1", cwd, "pow2");
		if (lookup.status !== "found") throw new Error("Expected found registration");
		expect(lookup.runtime).toBe("py");
		expect(lookup.revision).toBeGreaterThan(0);
	});

	it("marks cross-runtime name collisions ambiguous", () => {
		clearAllMacroDefinitions();
		recordMacroStatusEvent("python:s1", cwd, {
			op: "macro",
			action: "register",
			runtime: "py",
			name: "dupe",
			revision: 1,
		});
		recordMacroStatusEvent("js:s1", cwd, {
			op: "macro",
			action: "register",
			runtime: "js",
			name: "dupe",
			revision: 1,
		});
		expect(lookupMacroDefinition("s1", cwd, "dupe")).toEqual({ status: "ambiguous" });
	});

	it("uses monotonic host revisions across kernel-local revision reuse", () => {
		clearAllMacroDefinitions();
		recordMacroStatusEvent("python:s1", cwd, {
			op: "macro",
			action: "register",
			runtime: "py",
			name: "x",
			revision: 1,
		});
		const first = lookupMacroDefinition("s1", cwd, "x");
		clearMacroRuntime("python:s1", cwd, "py");
		recordMacroStatusEvent("python:s1", cwd, {
			op: "macro",
			action: "register",
			runtime: "py",
			name: "x",
			revision: 1,
		});
		const second = lookupMacroDefinition("s1", cwd, "x");
		if (first.status !== "found" || second.status !== "found") throw new Error("Expected found registrations");
		expect(second.revision).toBeGreaterThan(first.revision);
	});
});
