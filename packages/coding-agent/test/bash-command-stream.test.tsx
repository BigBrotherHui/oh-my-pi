import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { PythonResult } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-tui/theme";
import { mountForTest, type TestRoot } from "@oh-my-pi/pi-tui/testing";
import type { TranscriptEntry } from "@oh-my-pi/pi-tui/chat/transcript-store";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

let darkTheme: Theme;
const roots: TestRoot[] = [];

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Expected dark theme");
	darkTheme = theme;
});

afterEach(() => {
	for (const root of roots.splice(0)) root.dispose();
});

function createContext(
	executeBash: InteractiveModeContext["session"]["executeBash"],
	executePython: InteractiveModeContext["session"]["executePython"] = async () => {
		throw new Error("unexpected Python execution");
	},
	isStreaming = false,
) {
	const showError = vi.fn();
	const ctx = createInteractiveModeContext({
		session: { isStreaming, executeBash, executePython },
		sessionManager: { getCwd: () => "/tmp" },
		ui: { terminal: { columns: 100, rows: 40 } },
		showError,
		showWarning: vi.fn(),
	});
	return { ctx, entries: ctx.chatContainer.entries, showError };
}

function mountEntry(entry: TranscriptEntry): TestRoot {
	const root = mountForTest(entry.view, { width: 100, theme: darkTheme });
	roots.push(root);
	return root;
}

const successfulResult: BashResult = {
	output: "final output",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	totalLines: 1,
	totalBytes: 12,
	outputLines: 1,
	outputBytes: 12,
};

describe("user shell execution transcript", () => {
	it("keeps one BashExecutionStream view live through chunks and settles after final output", async () => {
		const result = Promise.withResolvers<BashResult>();
		const executeBash = vi.fn((_command: string, onChunk?: (chunk: string) => void) => {
			onChunk?.("streaming output\n");
			return result.promise;
		});
		const { ctx, entries } = createContext(executeBash);
		const pending = new CommandController(ctx).handleBashCommand("echo output");

		expect(entries()).toHaveLength(1);
		const root = mountEntry(entries()[0]!);
		expect(root.text().join("\n")).toContain("Running… (esc to cancel)");
		expect(root.text().join("\n")).toContain("streaming output");

		result.resolve(successfulResult);
		await pending;

		expect(root.text().join("\n")).toContain("final output");
		expect(root.text().join("\n")).not.toContain("Running… (esc to cancel)");
		expect(entries()[0]!.state).toBe("settled");
	});

	it("settles the live view before reporting execution failure", async () => {
		const executeBash = vi.fn(async () => {
			throw new Error("shell unavailable");
		});
		const { ctx, entries, showError } = createContext(executeBash);
		await new CommandController(ctx).handleBashCommand("echo output");

		const root = mountEntry(entries()[0]!);
		expect(root.text().join("\n")).not.toContain("Running… (esc to cancel)");
		expect(entries()[0]!.state).toBe("settled");
		expect(showError).toHaveBeenCalledWith("Bash command failed: shell unavailable");
	});

	it("keeps Python execution reactive until final output and metadata settle", async () => {
		const python = Promise.withResolvers<PythonResult>();
		const executePython = vi.fn((_code: string, onChunk?: (chunk: string) => void) => {
			onChunk?.("streaming Python\n");
			return python.promise;
		});
		const { ctx, entries } = createContext(vi.fn(), executePython);
		const pending = new CommandController(ctx).handlePythonCommand("print('ok')");

		expect(entries()).toHaveLength(1);
		const root = mountEntry(entries()[0]!);
		expect(root.text().join("\n")).toContain("Running… (esc to cancel)");
		expect(root.text().join("\n")).toContain("streaming Python");

		python.resolve({
			output: "final Python",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 12,
			outputLines: 1,
			outputBytes: 12,
			displayOutputs: [],
			stdinRequested: false,
		});
		await pending;

		expect(root.text().join("\n")).toContain("final Python");
		expect(root.text().join("\n")).not.toContain("Running… (esc to cancel)");
		expect(entries()[0]!.state).toBe("settled");
	});

	it("moves a streaming shell execution once while preserving its live stream", async () => {
		const result = Promise.withResolvers<BashResult>();
		let onChunk: ((chunk: string) => void) | undefined;
		const executeBash = vi.fn((_command: string, chunk?: (chunk: string) => void) => {
			onChunk = chunk;
			chunk?.("before move\n");
			return result.promise;
		});
		const { ctx, entries } = createContext(executeBash, undefined, true);
		const pending = new CommandController(ctx).handleBashCommand("echo output");

		const preview = mountForTest(ctx.pendingMessagesContainer.view, { width: 100, theme: darkTheme });
		roots.push(preview);
		expect(preview.text().join("\n")).toContain("before move");

		new UiHelpers(ctx).flushPendingExecutions();

		expect(ctx.pendingMessagesContainer.entries()).toHaveLength(0);
		expect(entries()).toHaveLength(1);
		const root = mountEntry(entries()[0]!);
		onChunk?.("after move\n");
		await Bun.sleep(60);
		expect(root.text().join("\n")).toContain("after move");

		result.resolve(successfulResult);
		await pending;

		expect(entries()).toHaveLength(1);
		expect(root.text().join("\n")).toContain("final output");
		expect(entries()[0]!.state).toBe("settled");
	});

	it("moves completed Python work as a settled execution", async () => {
		const result = Promise.withResolvers<PythonResult>();
		const executePython = vi.fn((_code: string, onChunk?: (chunk: string) => void) => result.promise);
		const { ctx, entries } = createContext(vi.fn(), executePython, true);
		const pending = new CommandController(ctx).handlePythonCommand("print('ok')");

		result.resolve({
			output: "final Python",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 12,
			outputLines: 1,
			outputBytes: 12,
			displayOutputs: [],
			stdinRequested: false,
		});
		await pending;

		new UiHelpers(ctx).flushPendingExecutions();

		expect(entries()).toHaveLength(1);
		const root = mountEntry(entries()[0]!);
		expect(root.text().join("\n")).toContain("final Python");
		expect(root.text().join("\n")).not.toContain("Running… (esc to cancel)");
		expect(entries()[0]!.state).toBe("settled");
	});

	it("preserves a deferred shell failure when it moves to the transcript", async () => {
		const executeBash = vi.fn(async () => {
			throw new Error("shell unavailable");
		});
		const { ctx, entries, showError } = createContext(executeBash, undefined, true);
		await new CommandController(ctx).handleBashCommand("echo output");

		new UiHelpers(ctx).flushPendingExecutions();

		expect(entries()).toHaveLength(1);
		const root = mountEntry(entries()[0]!);
		expect(root.text().join("\n")).not.toContain("Running… (esc to cancel)");
		expect(entries()[0]!.state).toBe("settled");
		expect(showError).toHaveBeenCalledWith("Bash command failed: shell unavailable");
	});

	it("drops a deferred execution when its owning session is no longer visible", async () => {
		const result = Promise.withResolvers<BashResult>();
		const executeBash = vi.fn(() => result.promise);
		const { ctx, entries } = createContext(executeBash, undefined, true);
		const pending = new CommandController(ctx).handleBashCommand("echo output");

		await ctx.sessionManager.newSession();
		new UiHelpers(ctx).flushPendingExecutions();

		expect(ctx.pendingMessagesContainer.entries()).toHaveLength(0);
		expect(entries()).toHaveLength(0);

		result.resolve(successfulResult);
		await pending;

		expect(entries()).toHaveLength(0);
	});

	it("moves deferred shell and Python executions in command order", async () => {
		const bash = Promise.withResolvers<BashResult>();
		const python = Promise.withResolvers<PythonResult>();
		const executeBash = vi.fn(() => bash.promise);
		const executePython = vi.fn(() => python.promise);
		const { ctx, entries } = createContext(executeBash, executePython, true);
		const controller = new CommandController(ctx);
		const bashExecution = controller.handleBashCommand("echo shell");
		const pythonExecution = controller.handlePythonCommand("print('python')");

		new UiHelpers(ctx).flushPendingExecutions();

		expect(entries()).toHaveLength(2);
		expect(entries()[0]!.id.startsWith("bash:")).toBe(true);
		expect(entries()[1]!.id.startsWith("python:")).toBe(true);

		bash.resolve(successfulResult);
		python.resolve({
			output: "final Python",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 12,
			outputLines: 1,
			outputBytes: 12,
			displayOutputs: [],
			stdinRequested: false,
		});
		await Promise.all([bashExecution, pythonExecution]);
	});
});
