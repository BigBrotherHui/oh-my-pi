import { beforeAll, describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { debugToolView, type DebugRenderArgs, type DebugToolDetails } from "@oh-my-pi/pi-tui/tools/debug";
import { createToolCallModel } from "@oh-my-pi/pi-tui/tools/model";

beforeAll(async () => {
	await initTheme();
});

describe("debugToolView", () => {
	it("renders session snapshot and output in a debugger frame", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const model = createToolCallModel<DebugRenderArgs, DebugToolDetails>({
			id: "call-dbg-1",
			toolName: "debug",
			label: "debug",
		});
		model.applyArgsChunk({ action: "step_in" });
		model.applyResult({
			content: [{ type: "text", text: "Stopped at breakpoint in main.py:42\nVariable x = 10" }],
			details: {
				action: "step_in",
				success: true,
				snapshot: {
					id: "sess-1",
					adapter: "python",
					status: "stopped",
					cwd: "/work",
					program: "main.py",
					line: 42,
					needsConfigurationDone: false,
				},
			},
		});

		const root = mountForTest(() => debugToolView.view(model), { width: 100, theme: theme! });
		const text = root.text().join("\n");

		expect(text).toContain(theme!.symbol("tool.debug"));
		expect(text).toContain("Debug");
		expect(text).toContain("step in");
		expect(text).toContain("Session sess-1");
		expect(text).toContain("Adapter: python");
		expect(text).toContain("Stopped at breakpoint in main.py:42");
		expect(text).toContain("Variable x = 10");
		root.dispose();
	});

	it("keeps streaming output within the historical collapsed and expanded row budgets", async () => {
		const theme = await getThemeByName("dark");
		const model = createToolCallModel<DebugRenderArgs, DebugToolDetails>({
			id: "call-dbg-preview",
			toolName: "debug",
			label: "debug",
		});
		model.applyArgsChunk({ action: "output" });
		model.markRunning();
		model.applyResult(
			{
				content: [{ type: "text", text: "one\ntwo\nthree\nfour" }],
				details: { action: "output", success: true },
			},
			{ partial: true },
		);

		const root = mountForTest(() => debugToolView.view(model), { width: 100, theme: theme! });
		const collapsed = root.text().join("\n");
		expect(collapsed).toContain("one");
		expect(collapsed).toContain("three");
		expect(collapsed).not.toContain("four");
		expect(collapsed).toContain("… 1 more lines");

		model.setUi({ expanded: true });
		expect(root.text().join("\n")).toContain("four");
		root.dispose();
	});

	it("distinguishes debugger failures from cancelled calls", async () => {
		const theme = await getThemeByName("dark");
		const failed = createToolCallModel<DebugRenderArgs, DebugToolDetails>({
			id: "call-dbg-error",
			toolName: "debug",
			label: "debug",
		});
		failed.applyResult({
			content: [{ type: "text", text: "adapter failed" }],
			details: { action: "launch", success: false },
			isError: true,
		});
		const failedRoot = mountForTest(() => debugToolView.view(failed), { width: 100, theme: theme! });
		expect(failedRoot.text().join("\n")).toContain(theme!.symbol("status.error"));
		failedRoot.dispose();

		const cancelled = createToolCallModel<DebugRenderArgs, DebugToolDetails>({
			id: "call-dbg-aborted",
			toolName: "debug",
			label: "debug",
		});
		cancelled.applyResult({
			content: [{ type: "text", text: "cancelled" }],
			details: { action: "launch", success: true },
			status: "aborted",
		});
		const cancelledRoot = mountForTest(() => debugToolView.view(cancelled), { width: 100, theme: theme! });
		expect(cancelledRoot.text().join("\n")).toContain(theme!.symbol("status.aborted"));
		cancelledRoot.dispose();
	});
});
