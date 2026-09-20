import { describe, expect, it } from "bun:test";
import {
	AutoresearchDashboardView,
	AutoresearchDashboardWidgetView,
	type AutoresearchDashboardRuntime,
} from "../src/apps/autoresearch-dashboard";
import { dispatchKey, HostKeyEvent } from "../src/host/input";
import { createSignal } from "../src/reactive";
import { mountForTest } from "../src/testing";
import type { ExperimentResult } from "../src/tools/autoresearch";

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

function runtime(results: ExperimentResult[], dashboardExpanded = false): AutoresearchDashboardRuntime {
	return {
		autoresearchMode: true,
		dashboardExpanded,
		state: {
			results,
			bestMetric: results.length > 0 ? results[results.length - 1]!.metric : null,
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
		lastRunSummary: null,
		runningExperiment: null,
	};
}

describe("autoresearch dashboard", () => {
	it("updates the inline widget from compact to the historical expanded panel", () => {
		const [snapshot, setSnapshot] = createSignal(runtime([result(1)]));
		const root = mountForTest(() => AutoresearchDashboardWidgetView({ runtime: snapshot }), { width: 100 });
		try {
			expect(root.text().join("\n")).toContain("ctrl+x expand");
			setSnapshot(runtime([result(1)], true));
			const text = root.text().join("\n");
			expect(text).toContain("ctrl+x collapse");
			expect(text).toContain("run 1");
		} finally {
			root.dispose();
		}
	});

	it("scrolls the overlay to the latest run and closes from its historical hotkey", () => {
		const [snapshot] = createSignal(runtime(Array.from({ length: 16 }, (_, index) => result(index + 1))));
		let closed = 0;
		const root = mountForTest(
			() =>
				AutoresearchDashboardView({
					runtime: snapshot,
					onClose: () => {
						closed += 1;
					},
				}),
			{ width: 100, height: 10 },
		);
		try {
			root.text();
			dispatchKey(root.root, new HostKeyEvent("G"));
			expect(root.text().join("\n")).toContain("run 16");
			dispatchKey(root.root, new HostKeyEvent("q"));
			expect(closed).toBe(1);
		} finally {
			root.dispose();
		}
	});
});
