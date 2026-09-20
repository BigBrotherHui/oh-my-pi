import { describe, expect, it } from "bun:test";
import { createAutoresearchDashboardStore } from "../src/autoresearch/dashboard";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { JSX } from "@oh-my-pi/pi-tui/reactive";
import { mountForTest } from "@oh-my-pi/pi-tui/testing";
import type { ExperimentResult } from "@oh-my-pi/pi-tui/tools/autoresearch";
import type { AutoresearchRuntime } from "../src/autoresearch/types";

function result(runNumber: number): ExperimentResult {
	return {
		runNumber,
		commit: `commit-${runNumber}`,
		metric: 100 + runNumber,
		metrics: {},
		status: "keep",
		description: `run ${runNumber}`,
		timestamp: runNumber,
		segment: 1,
		confidence: null,
		modifiedPaths: [],
		scopeDeviations: [],
		justification: null,
		flagged: false,
		flaggedReason: null,
	};
}

function runtime(results: ExperimentResult[], autoresearchMode = true): AutoresearchRuntime {
	return {
		autoresearchMode,
		autoResumeArmed: false,
		lastAutoResumePendingRunNumber: null,
		lastRunDuration: null,
		lastRunAsi: null,
		lastRunArtifactDir: null,
		lastRunNumber: null,
		lastRunSummary: null,
		runningExperiment: null,
		goal: null,
		state: {
			results,
			bestMetric: results.at(-1)?.metric ?? null,
			bestDirection: "higher",
			metricName: "score",
			metricUnit: "pts",
			secondaryMetrics: [],
			name: "throughput",
			goal: null,
			currentSegment: 1,
			maxExperiments: null,
			confidence: null,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			notes: "",
			branch: "main",
			baselineCommit: null,
			sessionId: 1,
		},
	};
}

describe("autoresearch dashboard store", () => {
	it("mounts a live deferred widget, expands it, and removes it when its session has no state", () => {
		let widget: (() => JSX.Element) | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: (() => JSX.Element) | undefined): void {
					widget = content;
				},
			},
		} as unknown as ExtensionContext;
		const state = runtime([result(1)]);
		const store = createAutoresearchDashboardStore(state);
		store.updateWidget(ctx, state);
		expect(widget).toBeDefined();
		const root = mountForTest(widget!, { width: 100 });
		try {
			expect(root.text().join("\n")).toContain("ctrl+x expand");
			store.toggleWidget(ctx, state);
			expect(root.text().join("\n")).toContain("ctrl+x collapse");

			store.updateWidget(ctx, runtime([], false));
			expect(widget).toBeUndefined();
		} finally {
			root.dispose();
		}
	});
});
