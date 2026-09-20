import { describe, expect, it } from "bun:test";
import { createEffect, createRoot } from "../../src/reactive";
import { createToolCallModel, stableToolEntityId } from "../../src/tools/model";
import galleryResult from "../../src/tools/fixtures/gallery-result.json" with { type: "json" };
import providerResult from "../../src/tools/fixtures/provider-tool-result.json" with { type: "json" };
import sessionResult from "../../src/tools/fixtures/session-tool-result.json" with { type: "json" };

function model() {
	return createToolCallModel({ id: "call-1", toolName: "bash", label: "Bash" });
}

describe("tool call phase and outcome normalization", () => {
	const cases = [
		{
			name: "result-level error without details",
			result: { content: [{ type: "text", text: "failed" }], isError: true },
			outcome: "failed",
		},
		{
			name: "string error payload",
			result: { error: "provider rejected the request" },
			outcome: "failed",
		},
		{
			name: "details-level error",
			result: { content: [], details: { isError: true } },
			outcome: "failed",
		},
		{
			name: "non-zero exit code",
			result: { content: [], details: { exitCode: 7 } },
			outcome: "failed",
		},
		{
			name: "timeout takes precedence over generic failure",
			result: { content: [], isError: true, details: { timedOut: true, cancelled: true, exitCode: 137 } },
			outcome: "timed_out",
		},
		{
			name: "cancellation takes precedence over generic failure",
			result: { content: [], isError: true, details: { cancelled: true, exitCode: 130 } },
			outcome: "cancelled",
		},
		{
			name: "synthetic interrupt skip takes precedence over every error signal",
			result: {
				content: [],
				isError: true,
				details: {
					__synthetic: true,
					source: "interrupt_skipped",
					executed: false,
					timedOut: true,
					exitCode: 1,
				},
			},
			outcome: "skipped",
		},
		{
			name: "interrupted started call is also a benign skip",
			result: {
				content: [],
				isError: true,
				details: { __interrupted: true, source: "interrupt_skipped", execution: "started" },
			},
			outcome: "skipped",
		},
		{
			name: "clean result succeeds",
			result: { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 } },
			outcome: "success",
		},
	] as const;

	for (const testCase of cases) {
		it(testCase.name, () => {
			const call = model();
			call.markQueued();
			call.markRunning();
			call.applyResult(testCase.result, { partial: false });
			expect(call.phase).toBe("settled");
			expect(call.outcome).toBe(testCase.outcome);
		});
	}

	it("distinguishes queued and partial states from terminal outcomes", () => {
		const call = model();
		call.markQueued();
		expect(call.phase).toBe("queued");
		expect(call.outcome).toBeUndefined();
		call.applyResult({ content: [{ type: "text", text: "still running" }], isError: true }, { partial: true });
		expect(call.phase).toBe("running");
		expect(call.outcome).toBeUndefined();
		expect(call.output.capture()).toBe("streaming");
	});
	it("keeps returned background work routable through its terminal result", () => {
		const call = model();
		const output = call.output;
		call.applyResult({
			content: [{ type: "text", text: "started" }],
			details: { async: { state: "running", jobId: "job-7", type: "bash" } },
		});
		expect(call.phase).toBe("running");
		expect(call.output).toBe(output);
		call.applyResult(
			{
				content: [{ type: "text", text: "completed" }],
				details: { async: { state: "completed", jobId: "job-7", type: "bash" } },
			},
			{ partial: false },
		);
		expect(call.phase).toBe("settled");
		expect(call.outcome).toBe("success");
		expect(call.output).toBe(output);
		expect(call.output.text()).toBe("completed");
	});
});

describe("tool call reactive reconciliation", () => {
	it("retains unchanged nested argument identity across streamed snapshots", () => {
		interface Args {
			command?: string;
			options?: { cwd?: string; limit?: number };
		}
		const call = createToolCallModel<Args>({ id: "args-1", toolName: "bash", label: "Bash" });
		call.applyArgsChunk({ command: "echo one", options: { cwd: "/tmp", limit: 10 } });
		const options = call.args.options;
		call.applyArgsChunk('{"command":"echo two","options":{"cwd":"/tmp","limit":10}}');
		expect(call.args.command).toBe("echo two");
		expect(call.args.options).toBe(options);
	});

	it("replaces omitted arguments for raw and explicit snapshots", () => {
		const call = createToolCallModel<{ command?: string; cwd?: string }>({
			id: "args-snapshot",
			toolName: "bash",
			label: "Bash",
		});
		call.applyArgsChunk({ command: "echo one", cwd: "/tmp" });
		call.applyArgsChunk('{"command":"echo two"}');
		expect(call.args).toEqual({ command: "echo two" });
		call.applyArgsChunk({ cwd: "/work" }, { snapshot: true });
		expect(call.args).toEqual({ cwd: "/work" });
	});

	it("invalidates only the changed details field", async () => {
		interface Details {
			tokenCount?: number;
			status?: string;
		}
		const call = createToolCallModel<Record<string, unknown>, Details>({
			id: "details-1",
			toolName: "task",
			label: "Task",
		});
		call.applyResult({ content: [], details: { tokenCount: 1, status: "running" } }, { partial: true });
		let tokenRuns = 0;
		let statusRuns = 0;
		let noticeRuns = 0;
		let dispose = () => {};
		createRoot(rootDispose => {
			dispose = rootDispose;
			createEffect(() => {
				void call.details?.tokenCount;
				tokenRuns++;
			});
			createEffect(() => {
				void call.details?.status;
				statusRuns++;
			});
			createEffect(() => {
				void call.output.notices().length;
				noticeRuns++;
			});
		});
		await Promise.resolve();
		expect([tokenRuns, statusRuns, noticeRuns]).toEqual([1, 1, 1]);
		call.applyResult({ content: [], details: { tokenCount: 2 } }, { partial: true });
		await Promise.resolve();
		expect(call.details).toEqual({ tokenCount: 2, status: "running" });
		expect([tokenRuns, statusRuns, noticeRuns]).toEqual([2, 1, 1]);
		dispose();
	});

	it("turns streaming snapshots into granular document changes and rejects stale updates", () => {
		const call = model();
		const changes: string[] = [];
		call.output.subscribe(change => changes.push(change.kind));
		const outputIdentity = call.output;
		call.applyResult({ content: "hello" }, { partial: true });
		call.applyResult({ content: "hello world" }, { partial: true });
		call.applyResult({ content: "hello brave world" }, { partial: true });
		call.applyResult({ content: "hello brave world!" }, { partial: false });
		expect(call.output).toBe(outputIdentity);
		expect(call.output.text()).toBe("hello brave world!");
		expect(changes).toEqual(["append", "append", "replace", "append"]);
		expect(call.output.capture()).toBe("complete");
		call.applyResult({ content: "stale" }, { partial: true });
		expect(call.output.text()).toBe("hello brave world!");
	});

	it("normalizes partial snapshots against merged details without duplicating notices", () => {
		const call = model();
		call.applyResult(
			{
				content: "working\nWall time: 1.00 seconds",
				details: { wallTimeMs: 1_000 },
			},
			{ partial: true },
		);
		call.applyResult(
			{
				content: "working\nWall time: 1.00 seconds\nCommand exited with code 2",
				details: { exitCode: 2 },
			},
			{ partial: true },
		);
		expect(call.output.text()).toBe("working");
		expect(call.notices).toEqual([
			{ kind: "wall-time", text: "Wall: 1.00s" },
			{ kind: "exit-code", text: "Exit: 2" },
		]);
		expect(call.output.notices()).toEqual(call.notices);
	});

	it("patches UI fields without invalidating unrelated field observers", async () => {
		const call = model();
		let allocationRuns = 0;
		let imageRuns = 0;
		let dispose = () => {};
		createRoot(rootDispose => {
			dispose = rootDispose;
			createEffect(() => {
				void call.ui.allocation;
				allocationRuns++;
			});
			createEffect(() => {
				void call.ui.showImages;
				imageRuns++;
			});
		});
		await Promise.resolve();
		call.setUi({ allocation: 12 });
		await Promise.resolve();
		expect([allocationRuns, imageRuns]).toEqual([2, 1]);
		dispose();
	});
});

describe("historical tool result normalization", () => {
	it("normalizes gallery, persisted-session, and provider variants identically", () => {
		const fixtures: unknown[] = [galleryResult, sessionResult, providerResult];
		const snapshots = fixtures.map((fixture, index) => {
			const call = createToolCallModel({ id: `history-${index}`, toolName: "read", label: "Read" });
			call.applyResult(fixture, { partial: false });
			return {
				text: call.output.text(),
				capture: call.output.capture(),
				notices: call.notices,
				images: call.images,
				details: call.details,
				outcome: call.outcome,
			};
		});
		expect(snapshots[1]).toEqual(snapshots[0]);
		expect(snapshots[2]).toEqual(snapshots[0]);
		expect(snapshots[0]?.text).toBe("alpha\nbeta");
		expect(snapshots[0]?.capture).toBe("truncated");
		expect(snapshots[0]?.notices).toEqual([
			{
				kind: "truncated",
				text: "Showing lines 1-2 of 4. Read artifact://42 for full output",
			},
		]);
	});

	it("separates shell footers and artifact recovery from the output document", () => {
		const call = model();
		call.applyResult(
			{
				content: [
					{
						type: "text",
						text: [
							"compiler output",
							"[raw output: artifact://91]",
							"Wall time: 1.25 seconds",
							"Command exited with code 2",
						].join("\n"),
					},
				],
				details: { wallTimeMs: 1250, exitCode: 2 },
			},
			{ partial: false },
		);
		expect(call.output.text()).toBe("compiler output");
		expect(call.notices).toEqual([
			{ kind: "wall-time", text: "Wall: 1.25s" },
			{ kind: "exit-code", text: "Exit: 2" },
			{ kind: "info", text: "Raw output: artifact://91" },
		]);
		expect(call.output.notices()).toEqual(call.notices);
		expect(call.outcome).toBe("failed");
	});

	it("uses tool, position, and normalized content for missing child ids", () => {
		const content = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		expect(stableToolEntityId("read", 0, content)).toBe(stableToolEntityId("read", 0, { ...content }));
		expect(stableToolEntityId("read", 1, content)).not.toBe(stableToolEntityId("read", 0, content));
		expect(stableToolEntityId("write", 0, content)).not.toBe(stableToolEntityId("read", 0, content));
	});

	it("keeps duplicate labels distinct by call id", () => {
		const first = createToolCallModel({ id: "call-a", toolName: "read", label: "Read" });
		const second = createToolCallModel({ id: "call-b", toolName: "read", label: "Read" });
		expect(first.label).toBe(second.label);
		expect(first.id).not.toBe(second.id);
		expect(first).not.toBe(second);
	});
});
