import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { hubToolView } from "@oh-my-pi/pi-tui/tools/hub";
import type { CoordinationDetails, HubDetails, HubRenderArgs } from "@oh-my-pi/pi-tui/tools/hub-contract";
import { createToolCallModel } from "../src/tools/model";
import { createStore } from "../src/reactive";
import { loadThemeSync } from "../src/theme/loader";
import type { DaemonSnapshot } from "../src/tools/hub-contract";
import { DaemonRow } from "../src/tools/hub-process";

it("updates a retained process status glyph when readiness becomes failure", () => {
	const theme = loadThemeSync("dark");
	const [daemon, setDaemon] = createStore<DaemonSnapshot>({
		id: "worker-1",
		name: "worker",
		state: "starting",
		createdAt: 0,
		startedAt: 0,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
	});
	const root = mountForTest(() => DaemonRow({ daemon, now: () => 0 }), { width: 80, theme });
	try {
		expect(root.text()[0]!.trimStart().startsWith(theme.symbol("status.warning"))).toBe(true);
		setDaemon("state", "failed");
		expect(root.text()[0]!.trimStart().startsWith(theme.symbol("status.error"))).toBe(true);
	} finally {
		root.dispose();
	}
});

describe("hubToolView jobs", () => {
	it("retains job status, model metadata, previews, and active agent rows", () => {
		const model = createToolCallModel<HubRenderArgs, HubDetails>({
			id: "hub-jobs",
			toolName: "hub",
			label: "hub",
		});
		model.applyArgsChunk({ op: "jobs" });
		const details: CoordinationDetails = {
			op: "jobs",
			jobs: [
				{
					id: "BuildWorker",
					type: "task",
					status: "running",
					label: "Compiling the retained renderer",
					durationMs: 1_200,
					resolvedModel: "provider/model:high",
					advisor: true,
				},
				{
					id: "FailedProbe",
					type: "bash",
					status: "failed",
					label: "Checking terminal rows",
					durationMs: 3_400,
					errorText: "probe failed",
				},
			],
			agents: [{ id: "DetachedWorker", parentId: "Main", activity: "reading source", ageMs: 9_000, live: true }],
		};
		model.applyResult({ content: [{ type: "text", text: "" }], details }, { partial: true });
		model.setUi({ expanded: true });
		const root = mountForTest(() => hubToolView.view(model), { width: 120 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("waiting on 1 of 2 jobs");
			expect(text).toContain("BuildWorker");
			expect(text).toContain("Compiling the retained renderer");
			expect(text).toContain("FailedProbe");
			expect(text).toContain("probe failed");
			expect(text).toContain("DetachedWorker");
			expect(text).toContain("reading source");
		} finally {
			root.dispose();
		}
	});

	it("keeps compact job rows within the historical label and preview budgets", () => {
		const model = createToolCallModel<HubRenderArgs, HubDetails>({
			id: "hub-compact",
			toolName: "hub",
			label: "hub",
		});
		model.applyArgsChunk({ op: "jobs" });
		const details: CoordinationDetails = {
			op: "jobs",
			jobs: [
				{
					id: "bg_24",
					type: "bash",
					status: "failed",
					label: "bun test packages/ai\nwith --coverage\nin the retained workspace",
					durationMs: 6_100,
					errorText: "uncaught exception\nstack frame two\nstack frame three",
				},
			],
		};
		model.applyResult({ content: [{ type: "text", text: "" }], details }, { partial: true });
		const root = mountForTest(() => hubToolView.view(model), { width: 120 });
		try {
			const lines = root.text();
			const text = lines.join("\n");
			expect(lines.some(line => line.includes("bg_24") && line.includes("bun test packages/ai"))).toBe(true);
			expect(text).toContain("uncaught exception");
			expect(text).not.toContain("stack frame two");
			expect(text).not.toContain("more label lines");
			expect(text).toContain("…");
		} finally {
			root.dispose();
		}
	});

	it("previews task-result envelopes without their transport markup", () => {
		const model = createToolCallModel<HubRenderArgs, HubDetails>({
			id: "hub-envelope",
			toolName: "hub",
			label: "hub",
		});
		model.applyArgsChunk({ op: "jobs" });
		const details: CoordinationDetails = {
			op: "jobs",
			jobs: [
				{
					id: "Scout",
					type: "task",
					status: "completed",
					label: "Scout",
					durationMs: 8_700,
					resultText:
						'<task-result>\n<output>\n{\n  "ok": true,\n  "summary": "probe complete"\n}\n</output>\n</task-result>',
				},
			],
		};
		model.applyResult({ content: [{ type: "text", text: "" }], details });
		model.setUi({ expanded: true });
		const root = mountForTest(() => hubToolView.view(model), { width: 120 });
		try {
			const text = root.text().join("\n");
			expect(text).toContain('"summary": "probe complete"');
			expect(text).not.toContain("<task-result");
			expect(text).not.toContain("<output>");
		} finally {
			root.dispose();
		}
	});

	it("hides a sealed bare wait that only repeats still-running jobs", () => {
		const model = createToolCallModel<HubRenderArgs, HubDetails>({
			id: "hub-poll",
			toolName: "hub",
			label: "hub",
		});
		model.applyArgsChunk({ op: "wait", ids: [] });
		const details: CoordinationDetails = {
			op: "wait",
			jobs: [{ id: "StillRunning", type: "task", status: "running", label: "StillRunning", durationMs: 100 }],
		};
		model.applyResult({ content: [{ type: "text", text: "" }], details });
		const root = mountForTest(() => hubToolView.view(model), { width: 100 });
		try {
			expect(root.text().join("\n")).not.toContain("StillRunning");
		} finally {
			root.dispose();
		}
	});
});
