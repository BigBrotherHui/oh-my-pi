import { describe, expect, it } from "bun:test";
import { createToolCallModel } from "../src/tools/model";
import { vibeToolView, type VibeRenderArgs, type VibeScreenSnapshot, type VibeToolDetails } from "../src/tools/vibe";
import { renderToRows } from "../src/testing";

function screen(overrides: Partial<VibeScreenSnapshot> = {}): VibeScreenSnapshot {
	return {
		id: "Anna",
		cli: "fast",
		state: "running",
		turns: 1,
		queued: 0,
		trace: [],
		outputTail: [],
		lastActivityAt: 0,
		...overrides,
	};
}

interface RenderOptions {
	readonly args?: VibeRenderArgs;
	readonly details?: VibeToolDetails;
	readonly expanded?: boolean;
	readonly isError?: boolean;
	readonly toolName?: string;
	readonly width?: number;
}

function renderVibe(options: RenderOptions): string[] {
	const model = createToolCallModel<VibeRenderArgs, VibeToolDetails>({
		id: "vibe-test",
		toolName: options.toolName ?? "vibe",
		label: "vibe",
	});
	model.applyArgsChunk(options.args ?? {});
	model.markRunning();
	if (options.details) {
		model.applyResult({
			content: [{ type: "text", text: "fallback" }],
			details: options.details,
			isError: options.isError,
		});
	} else if (options.isError) {
		model.applyResult({ content: [{ type: "text", text: "fallback" }], isError: true });
	}
	model.setUi({ expanded: options.expanded ?? false });
	return renderToRows(() => vibeToolView.view(model), options.width ?? 100).map(Bun.stripANSI);
}

describe("vibe tool view", () => {
	it("renders the live wall with trace, stream tail, model, and active intent", () => {
		const rows = renderVibe({
			expanded: true,
			details: {
				op: "wait",
				screens: [
					screen({
						turnMessage: "Build the widget",
						trace: ["read(src/foo.ts)", "bash(bun test)"],
						currentTool: "edit",
						lastIntent: "Fixing the parser",
						outputTail: ["The parser now accepts nested arrays"],
						model: "prov/fast-model",
					}),
				],
				wait: { settled: [], stillRunning: ["Anna"], timedOut: false, waiting: true },
			},
		});
		const text = rows.join("\n");
		expect(text).toContain("vibe wait — watching the wall");
		expect(text).toContain("Anna");
		expect(text).toContain("Build the widget");
		expect(text).toContain("read(src/foo.ts)");
		expect(text).toContain("bash(bun test)");
		expect(text).toContain("edit: Fixing the parser");
		expect(text).toContain("The parser now accepts nested arrays");
		expect(text).toContain("prov/fast-model");
	});

	it("keeps the historical collapsed trace and output budgets", () => {
		const rows = renderVibe({
			details: {
				op: "list",
				screens: [
					screen({
						trace: ["trace one", "trace two", "trace three"],
						outputTail: ["output one", "output two"],
					}),
				],
			},
		});
		const text = rows.join("\n");
		expect(text).not.toContain("trace one");
		expect(text).toContain("trace two");
		expect(text).toContain("trace three");
		expect(text).not.toContain("output one");
		expect(text).toContain("output two");
	});

	it("renders spawn calls as the compact mini-composer while pending", () => {
		const rows = renderVibe({
			toolName: "vibe_spawn",
			args: { cli: "fast", name: "Scout", prompt: "first line\nsecond line\nthird line" },
		});
		const text = rows.join("\n");
		expect(text).toContain("vibe spawn fast · Scout");
		expect(text).toContain("> first line");
		expect(text).toContain("  second line");
		expect(text).not.toContain("third line");
		expect(text).toContain("booting CLI…");
	});

	it("renders delivery and wait completion outcomes without losing their action state", () => {
		const sendRows = renderVibe({
			toolName: "vibe_send",
			args: { session: "Scout", message: "Keep investigating" },
			details: {
				op: "send",
				screens: [],
				send: { id: "Scout", mode: "queued" },
			},
		});
		expect(sendRows.join("\n")).toContain("mid-turn — queued as the next turn");

		const waitRows = renderVibe({
			expanded: true,
			details: {
				op: "wait",
				screens: [
					screen({ state: "idle", lastActivity: "result retained" }),
					screen({ id: "Bea", state: "dead", lastActivity: "worker stopped" }),
				],
				wait: {
					settled: [
						{ id: "Anna", jobId: "job-1", status: "failed" },
						{ id: "Bea", jobId: "job-2", status: "cancelled" },
					],
					stillRunning: [],
					timedOut: true,
				},
			},
		});
		const text = waitRows.join("\n");
		expect(text).toContain("timed out");
		expect(text).toContain("turn failed — result delivered");
		expect(text).toContain("turn cancelled — result delivered");
		expect(text).toContain("result retained");
		expect(text).toContain("worker stopped");
	});

	it("uses the terminal error fallback when no structured details arrive", () => {
		const rows = renderVibe({
			toolName: "vibe_kill",
			args: { session: "Scout" },
			isError: true,
		});
		const text = rows.join("\n");
		expect(text).toContain("vibe kill Scout");
		expect(text).toContain("fallback");
	});

	it("clips every historical mini-terminal row at the allocated width", () => {
		const rows = renderVibe({
			expanded: true,
			width: 48,
			details: {
				op: "list",
				screens: [
					screen({
						id: "VeryLongSessionNameForTruncation",
						trace: [`read(${"x".repeat(200)})`],
						outputTail: ["y".repeat(300)],
						currentTool: "bash",
						currentToolArgs: "z".repeat(200),
					}),
				],
			},
		});
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(48);
	});
});
