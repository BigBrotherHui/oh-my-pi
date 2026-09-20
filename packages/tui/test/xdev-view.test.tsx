import { afterEach, describe, expect, it } from "bun:test";
import { mountForTest, type TestRoot } from "../src/testing";
import { createComponent } from "../src/host/renderer";
import { ToolBlock } from "../src/chat/tool-block";
import { createToolCallModel } from "../src/tools/model";
import {
	decodeInnerArgs,
	displayDeviceLabel,
	resolveInnerXdevTool,
	xdevActivitySummary,
	xdevToolView,
} from "../src/tools/xdev";
import { registerToolView, resolveToolView, toolViews } from "../src/tools/registry";
import { loadThemeSync } from "../src/theme/loader";

const mounted: TestRoot[] = [];
afterEach(() => {
	for (const root of mounted.splice(0)) root.dispose();
});

describe("xdev tools and dispatch", () => {
	it("registers xdev view in toolViews", () => {
		expect(toolViews.get("xdev")).toBe(xdevToolView);
	});

	it("decodes inner args from JSON strings and partial streams", () => {
		const parsed = decodeInnerArgs('{"action": "status", "target": "main"}');
		expect(parsed.action).toBe("status");
		expect(parsed.target).toBe("main");
		expect(parsed.__partialJson).toBeUndefined();

		const partial = decodeInnerArgs('{"ops":[{"meta":{"kind":"edit"},"body":"line 1\\nline 2');
		expect(partial.ops).toEqual([{ meta: { kind: "edit" }, body: "line 1\nline 2" }]);
		expect(decodeInnerArgs('{"body":"line\\u00').body).toBe("line\\u00");

		const empty = decodeInnerArgs("");
		expect(empty).toEqual({});

		expect(decodeInnerArgs('{"action":"status"} trailing')).toEqual({});

		const nonString = decodeInnerArgs(null);
		expect(nonString).toEqual({});
	});

	it("formats display device labels", () => {
		expect(displayDeviceLabel("lsp")).toBe("lsp");
		expect(displayDeviceLabel("mcp__github_search")).toBe("github/search");
		expect(displayDeviceLabel("mcp__github_search", { label: "GitHub Search" })).toBe("GitHub Search");
	});

	it("generates compact activity summary picking verb and object", () => {
		const jsonContent = JSON.stringify({
			action: "references",
			symbol: "myFunction",
			file: "index.ts",
		});
		const summary = xdevActivitySummary("lsp", jsonContent);
		expect(summary.label).toBe("lsp");
		expect(summary.detail).toBe("references myFunction");

		const proseContent = "First line of report\nSecond line of report";
		const proseSummary = xdevActivitySummary("report_issue", proseContent);
		expect(proseSummary.label).toBe("report_issue");
		expect(proseSummary.detail).toBe("First line of report");
	});

	it("resolves inner tool selection from xd:// path and content", () => {
		const selection = resolveInnerXdevTool({
			path: "xd://ast_edit",
			content: JSON.stringify({ ops: [{ pat: "$A", out: "$B" }] }),
		});
		expect(selection).toBeDefined();
		expect(selection?.toolName).toBe("ast_edit");
		expect(selection?.args.ops).toEqual([{ pat: "$A", out: "$B" }]);
		expect(selection?.rawArgs).toBe(JSON.stringify({ ops: [{ pat: "$A", out: "$B" }] }));

		const nonXd = resolveInnerXdevTool({ path: "/tmp/file.ts", content: "hello" });
		expect(nonXd).toBeUndefined();

		// A streamed path remains provisional until the content field starts.
		// Do not replace the write card with a device view while a provider may
		// still revise an `xd://` prefix into a regular path.
		expect(resolveInnerXdevTool({ path: "xd://ast_edit" })).toBeUndefined();

		const unmounted = resolveInnerXdevTool(
			{ path: "xd://unmounted", content: "{}" },
			name => name === "mounted_only",
		);
		expect(unmounted).toBeUndefined();
	});

	it("delegates xd write calls via a readonly presentation", () => {
		const bespokeView = {
			view: () => <text>Bespoke Device Content</text>,
		};
		registerToolView("my_device", bespokeView);

		const outer = createToolCallModel({
			id: "write-call-1",
			toolName: "write",
			label: "Write",
		});
		outer.applyArgsChunk({
			path: "xd://my_device",
			content: JSON.stringify({ query: "active" }),
		});
		outer.markRunning();

		const resolved = resolveToolView("write", {
			model: outer,
			resolveInnerTool: args => resolveInnerXdevTool(args),
		});

		expect(resolved.definition).toBe(bespokeView);
		expect(resolved.model?.id).toBe("write-call-1:inner");
		expect(resolved.model?.toolName).toBe("my_device");
		expect(resolved.model?.output).toBe(outer.output);

		const root = mountForTest(() => createComponent(resolved.definition.view, resolved.model!), {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		mounted.push(root);

		expect(root.text().join("\n")).toContain("Bespoke Device Content");
	});

	it("keeps an approved delegated view mounted through argument and result streaming", () => {
		let viewRuns = 0;
		const streamingView = {
			view: (props: {
				readonly args: { readonly action?: string };
				readonly output: { text(): string };
				readonly phase: string;
				readonly outcome?: string;
			}) => {
				viewRuns++;
				return (
					<stack>
						<text>{props.args.action}</text>
						<text>{props.output.text()}</text>
						<text>{`${props.phase}:${props.outcome ?? "live"}`}</text>
					</stack>
				);
			},
		};
		registerToolView("streaming_device", streamingView);

		const outer = createToolCallModel({
			id: "write-call-stream",
			toolName: "write",
			label: "Write",
		});
		outer.applyArgsChunk({
			path: "xd://streaming_device",
			content: JSON.stringify({ action: "first" }),
		});
		outer.markRunning();
		outer.setUi({ allocation: Number.MAX_SAFE_INTEGER });

		const root = mountForTest(
			() => <ToolBlock model={outer} source={{ resolveInnerTool: args => resolveInnerXdevTool(args) }} />,
			{ width: 80, theme: loadThemeSync("dark") },
		);
		mounted.push(root);
		expect(root.text().join("\n")).toContain("first");
		expect(viewRuns).toBe(1);

		outer.applyArgsChunk({ content: JSON.stringify({ action: "second" }) });
		root.flush();
		expect(root.text().join("\n")).toContain("second");
		expect(viewRuns).toBe(1);

		outer.applyResult({ content: "streaming output" }, { partial: true });
		root.flush();
		expect(root.text().join("\n")).toContain("streaming output");
		expect(viewRuns).toBe(1);

		outer.applyResult({ content: "cancelled output", status: "cancelled" });
		root.flush();
		expect(root.text().join("\n")).toContain("settled:cancelled");
		expect(viewRuns).toBe(1);
	});
});
