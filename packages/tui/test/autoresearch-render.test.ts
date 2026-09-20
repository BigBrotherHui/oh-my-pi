import { beforeAll, describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	initExperimentToolView,
	logExperimentToolView,
	runExperimentToolView,
	updateNotesToolView,
	type InitExperimentDetails,
	type LogDetails,
	type RunDetails,
	type RunExperimentProgressDetails,
	type UpdateNotesDetails,
} from "@oh-my-pi/pi-tui/tools/autoresearch";
import { createToolCallModel } from "@oh-my-pi/pi-tui/tools/model";

beforeAll(async () => {
	await initTheme();
});

describe("autoresearch tool views", () => {
	it("renders init_experiment tool view", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const model = createToolCallModel<{ name: string }, InitExperimentDetails>({
			id: "auto-1",
			toolName: "init_experiment",
			label: "init_experiment",
		});
		model.applyArgsChunk({ name: "speedup-v1" });
		model.applyResult({ content: [{ type: "text", text: "Experiment initialized: speedup-v1" }] });

		const root = mountForTest(() => initExperimentToolView.view(model), { width: 100, theme: theme! });
		const text = root.text().join("\n");

		expect(text).toContain("init_experiment");
		expect(text).toContain("speedup-v1");
		expect(text).toContain("Experiment initialized: speedup-v1");
		root.dispose();
	});

	it("renders log_experiment tool view with metrics and status", async () => {
		const theme = await getThemeByName("dark");
		const model = createToolCallModel<{ status: "keep"; description: string }, LogDetails>({
			id: "auto-2",
			toolName: "log_experiment",
			label: "log_experiment",
		});
		model.applyArgsChunk({ status: "keep", description: "Optimize inner loop" });
		const logDetails: LogDetails = {
			experiment: {
				runNumber: 1,
				commit: "abc1234",
				metric: 42.5,
				metrics: { latency: 42.5 },
				status: "keep",
				description: "Optimize inner loop",
				timestamp: 123456789,
				segment: 1,
				confidence: 1.5,
				modifiedPaths: ["src/loop.ts"],
				scopeDeviations: [],
				justification: null,
				flagged: false,
				flaggedReason: null,
			},
			state: {
				results: [],
				bestMetric: 50.0,
				bestDirection: "lower",
				metricName: "latency",
				metricUnit: "ms",
				secondaryMetrics: [],
				name: "speedup-v1",
				goal: null,
				currentSegment: 1,
				maxExperiments: null,
				confidence: 1.5,
				scopePaths: [],
				offLimits: [],
				constraints: [],
				notes: "",
				branch: "main",
				baselineCommit: "def5678",
				sessionId: 1,
			},
			wallClockSeconds: 10,
			scopeDeviations: [],
			justification: null,
			flaggedRuns: [],
		};
		model.applyResult({ content: [{ type: "text", text: "" }], details: logDetails });

		const root = mountForTest(() => logExperimentToolView.view(model), { width: 100, theme: theme! });
		const text = root.text().join("\n");

		expect(text).toContain("log_experiment");
		expect(text).toContain("KEEP");
		expect(text).toContain("Optimize inner loop");
		expect(text).toContain("latency=42.50ms");
		expect(text).toContain("baseline 50ms");
		root.dispose();
	});

	it("renders run_experiment tool view with pass/fail output", async () => {
		const theme = await getThemeByName("dark");
		const model = createToolCallModel<{}, RunDetails | RunExperimentProgressDetails>({
			id: "auto-3",
			toolName: "run_experiment",
			label: "run_experiment",
		});
		const runDetails: RunDetails = {
			runNumber: 2,
			runDirectory: "/tmp/run",
			benchmarkLogPath: "/tmp/log",
			command: "bash autoresearch.sh",
			exitCode: 0,
			durationSeconds: 3.2,
			passed: true,
			crashed: false,
			timedOut: false,
			tailOutput: "Benchmark complete.\nScore: 100",
			parsedMetrics: { score: 100 },
			parsedPrimary: 100,
			parsedAsi: null,
			metricName: "score",
			metricUnit: "pts",
			preRunDirtyPaths: [],
			abandonedPriorRun: null,
		};
		model.applyResult({ content: [{ type: "text", text: "" }], details: runDetails });

		const root = mountForTest(() => runExperimentToolView.view(model), { width: 100, theme: theme! });
		const text = root.text().join("\n");

		expect(text).toContain("run_experiment");
		expect(text).toContain("PASS 3.2s score=100pts");
		expect(text).toContain("Benchmark complete.");
		root.dispose();
	});

	it("keeps run output compact until expanded and shows the full-output location", async () => {
		const theme = await getThemeByName("dark");
		const model = createToolCallModel<{}, RunDetails | RunExperimentProgressDetails>({
			id: "auto-compact",
			toolName: "run_experiment",
			label: "run_experiment",
		});
		model.applyResult({
			content: [{ type: "text", text: "" }],
			details: {
				runNumber: 3,
				runDirectory: "/tmp/run",
				benchmarkLogPath: "/tmp/log",
				command: "bash autoresearch.sh",
				exitCode: 0,
				durationSeconds: 1,
				passed: true,
				crashed: false,
				timedOut: false,
				tailOutput: "first\nsecond\nthird\nfourth\nfifth\nsixth",
				parsedMetrics: null,
				parsedPrimary: null,
				parsedAsi: null,
				metricName: "score",
				metricUnit: "pts",
				preRunDirtyPaths: [],
				abandonedPriorRun: null,
				truncation: {
					content: "",
					truncated: true,
					totalLines: 6,
					totalBytes: 31,
				},
				fullOutputPath: "/tmp/autoresearch/full.log",
			},
		});

		const root = mountForTest(() => runExperimentToolView.view(model), { width: 100, theme: theme! });
		const compact = root.text().join("\n");

		expect(compact).not.toContain("first");
		expect(compact).toContain("second");
		expect(compact).toContain("sixth");

		model.setUi({ expanded: true });
		const expanded = root.text().join("\n");

		expect(expanded).toContain("first");
		expect(expanded).toContain("Full output: /tmp/autoresearch/full.log");
		root.dispose();
	});

	it("renders update_notes tool view", async () => {
		const theme = await getThemeByName("dark");
		const model = createToolCallModel<{ body: string }, UpdateNotesDetails>({
			id: "auto-4",
			toolName: "update_notes",
			label: "update_notes",
		});
		model.applyArgsChunk({ body: "Note: need to check memory allocation." });
		model.applyResult({ content: [{ type: "text", text: "Notes updated successfully." }] });

		const root = mountForTest(() => updateNotesToolView.view(model), { width: 100, theme: theme! });
		const text = root.text().join("\n");

		expect(text).toContain("update_notes");
		expect(text).toContain("Notes updated successfully.");
		root.dispose();
	});
});
