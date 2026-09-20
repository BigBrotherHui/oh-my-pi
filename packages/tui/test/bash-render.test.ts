import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-tui/theme";
import { bashToolView, type BashRenderArgs, type BashToolDetails } from "@oh-my-pi/pi-tui/tools/bash";
import { createToolCallModel } from "@oh-my-pi/pi-tui/tools/model";
import { mountForTest, type TestRoot } from "../src/testing";
import { cellGrid } from "./cell-grid";
import { previewWindowRows } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";

describe("bashToolView", () => {
	let uiTheme: Theme;
	const roots: TestRoot[] = [];
	const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("Expected dark theme");
		uiTheme = loaded;
	});

	afterEach(() => {
		for (const root of roots.splice(0)) root.dispose();
		if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
		if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
	});

	it("shows rendered env assignments in the command preview", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({ id: "b1", toolName: "bash", label: "Bash" });
		model.applyArgsChunk({
			command: "printf '%s' \"$MERMAID\"",
			env: { MERMAID: 'line "one"\ntwo' },
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const rendered = sanitizeText(root.text().join("\n"));
		expect(rendered).toContain('MERMAID="line \\"one\\"\\ntwo"');
		expect(rendered).toContain("printf '%s' \"$MERMAID\"");
	});

	it("stringifies malformed env values in the command preview", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({ id: "b2", toolName: "bash", label: "Bash" });
		model.applyArgsChunk({
			command: 'echo "$DEBUG"',
			env: { DEBUG: true },
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const rendered = sanitizeText(root.text().join("\n"));
		expect(rendered).toContain('DEBUG="true"');
		expect(rendered).toContain('echo "$DEBUG"');
	});

	it("shows partial env assignments while tool args are still streaming", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({ id: "b3", toolName: "bash", label: "Bash" });
		model.applyArgsChunk('{"command":"printf \'%s\' \\"$MERMAID\\"","env":{"MERMAID":"line 1\\nline 2');

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const rendered = sanitizeText(root.text().join("\n"));
		expect(rendered).toContain('MERMAID="line 1\\nline 2"');
		expect(rendered).toContain("printf '%s' \"$MERMAID\"");
	});

	it("drops env assignments omitted from a newer raw argument snapshot", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({
			id: "b3-snapshot",
			toolName: "bash",
			label: "Bash",
		});
		model.applyArgsChunk('{"command":"echo $OLD","env":{"OLD":"present"}}');
		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		expect(sanitizeText(root.text().join("\n"))).toContain('OLD="present"');
		model.applyArgsChunk('{"command":"echo fresh"}');
		root.flush();
		expect(sanitizeText(root.text().join("\n"))).not.toContain('OLD="present"');
	});

	it("sanitizes command tabs and shortens home cwd in previews", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({ id: "b4", toolName: "bash", label: "Bash" });
		model.applyArgsChunk({
			command: "printf\t'%s'",
			cwd: path.join(os.homedir(), "projects", "demo"),
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const rendered = sanitizeText(root.text().join("\n"));
		expect(rendered).toContain("~/projects/demo");
		expect(rendered).not.toContain(os.homedir());
		expect(rendered).not.toContain("\t");
	});

	it("renders the pending command inside its frame without a redundant Bash title", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({ id: "b5", toolName: "bash", label: "Bash" });
		model.applyArgsChunk({ command: "sleep 30" });

		const root = mountForTest(() => bashToolView.view(model), { width: 60, theme: uiTheme });
		roots.push(root);

		const lines = root.text();
		expect(lines.length).toBeGreaterThanOrEqual(3);
		const fullText = lines.join("\n");
		expect(fullText).toContain("$ sleep 30");
		expect(fullText).not.toContain("Bash");
		expect(fullText).not.toContain("Output");
	});

	it("adds the output divider only after the first streamed result", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({
			id: "b5-stream",
			toolName: "bash",
			label: "Bash",
		});
		model.applyArgsChunk({ command: "sleep 30" });

		const root = mountForTest(() => bashToolView.view(model), { width: 60, theme: uiTheme });
		roots.push(root);
		expect(sanitizeText(root.text().join("\n"))).not.toContain("Output");

		model.markRunning();
		root.flush();
		expect(sanitizeText(root.text().join("\n"))).not.toContain("Output");

		model.applyResult(
			{ content: [{ type: "text", text: "started" }], details: {}, isError: false },
			{ partial: true },
		);
		root.flush();

		expect(sanitizeText(root.text().join("\n"))).toContain("Output");
	});

	it("shows the effective timeout from result details when it differs from call args", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({ id: "b6", toolName: "bash", label: "Bash" });
		model.applyArgsChunk({ command: "python3 scripts/edit-benchmark.py", timeout: 1200 });
		model.applyResult({
			content: [{ type: "text", text: "" }],
			details: { timeoutSeconds: 120 },
			isError: false,
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const rendered = sanitizeText(root.text().join("\n"));
		expect(rendered).toContain("Timeout: 120s");
		expect(rendered).not.toContain("Timeout: 1200s");
	});

	it("renders wall time alongside timeout label and strips textual notice", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({ id: "b7", toolName: "bash", label: "Bash" });
		model.applyArgsChunk({ command: "echo hi" });
		model.applyResult({
			content: [{ type: "text", text: "hello\n\nWall time: 1.23 seconds" }],
			details: { timeoutSeconds: 5, wallTimeMs: 1230 },
			isError: false,
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const rendered = sanitizeText(root.text().join("\n"));
		expect(rendered).toContain("Wall: 1.23s");
		expect(rendered).toContain("Timeout: 5s");
		expect(rendered).not.toContain("Wall time: 1.23 seconds");
	});

	it("renders a backgrounded job as a static footer notice", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({ id: "b8", toolName: "bash", label: "Bash" });
		model.applyArgsChunk({ command: "sleep 30" });
		model.applyResult({
			content: [
				{
					type: "text",
					text: "started\n\nBackgrounded as job bash-42; result will be delivered automatically.",
				},
			],
			details: {
				timeoutSeconds: 300,
				async: { state: "running", jobId: "bash-42", type: "bash" },
			},
			isError: false,
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const rendered = sanitizeText(root.text().join("\n"));
		expect(rendered).toContain("started");
		expect(rendered).toContain("Backgrounded: bash-42");
		expect(rendered).not.toContain("result will be delivered automatically");
	});

	it("folds raw output artifact notices into status footer", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({ id: "b9", toolName: "bash", label: "Bash" });
		model.applyArgsChunk({ command: "bun run check:types" });
		model.applyResult({
			content: [{ type: "text", text: "filtered\n[raw output: artifact://13]\n\nWall time: 0.08 seconds" }],
			details: { timeoutSeconds: 300, wallTimeMs: 80 },
			isError: false,
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const rendered = sanitizeText(root.text().join("\n"));
		expect(rendered).toContain("filtered");
		expect(rendered).toContain("Wall: 0.08s");
		expect(rendered).toContain("Timeout: 300s");
		expect(rendered).toContain("Artifact: 13");
		expect(rendered).not.toContain("[raw output: artifact://13]");
	});

	it("renders exit status in footer and strips textual exit notice for failed commands", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({
			id: "b10",
			toolName: "bash",
			label: "Bash",
		});
		model.applyArgsChunk({ command: "false" });
		model.applyResult({
			content: [{ type: "text", text: "boom\n\nWall time: 0.02 seconds\n\nCommand exited with code 1" }],
			details: { timeoutSeconds: 300, wallTimeMs: 20, exitCode: 1 },
			isError: true,
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const rendered = sanitizeText(root.text().join("\n"));
		expect(rendered).toContain("Wall: 0.02s");
		expect(rendered).toContain("Timeout: 300s");
		expect(rendered).toContain("Exit: 1");
		expect(rendered).not.toContain("Command exited with code 1");
		expect(rendered).not.toContain("Wall time: 0.02 seconds");
		expect(rendered).toContain("boom");
	});

	it("renders a timed-out command with warning border instead of error border", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({
			id: "b11",
			toolName: "bash",
			label: "Bash",
		});
		model.applyArgsChunk({ command: "sleep 10" });
		model.applyResult({
			content: [{ type: "text", text: "[Command timed out after 1 seconds]\n" }],
			details: { timeoutSeconds: 1, timedOut: true },
			isError: false,
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const grid = cellGrid(root.rows(), 120);
		expect(grid.length).toBeGreaterThanOrEqual(3);
		expect(model.outcome).toBe("timed_out");
		const rendered = root.rows().join("\n");
		const warningAnsi = uiTheme.fg("warning", "").replace("\x1b[39m", "");
		const errorAnsi = uiTheme.fg("error", "").replace("\x1b[39m", "");
		expect(rendered).toContain(warningAnsi);
		expect(rendered).not.toContain(errorAnsi);
	});

	it("omits the status footer for a successful command", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({
			id: "b12",
			toolName: "bash",
			label: "Bash",
		});
		model.applyArgsChunk({ command: "sleep 0.01", timeout: 300 });
		model.applyResult({
			content: [{ type: "text", text: "" }],
			details: { timeoutSeconds: 300, wallTimeMs: 20 },
			isError: false,
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const rendered = sanitizeText(root.text().join("\n"));
		expect(rendered).toContain("Wall: 0.02s");
		expect(rendered).toContain("Timeout: 300s");
		expect(rendered).not.toContain("Exit:");
	});

	it("bypasses truncation/styling for SIXEL lines", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const sixel = "\x1bPqabc\x1b\\";
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({
			id: "b13",
			toolName: "bash",
			label: "Bash",
		});
		model.applyArgsChunk({ command: "echo sixel" });
		model.applyResult({
			content: [{ type: "text", text: `line one\n${sixel}\nline two` }],
			details: {},
			isError: false,
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 80, theme: uiTheme });
		roots.push(root);

		const lines = root.rows();
		expect(lines.filter(line => line.includes(sixel))).toHaveLength(1);
	});

	it("renders every line of a multi-line bash command", () => {
		const command = 'for f in a b; do\n\techo "$f"\ndone';
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({
			id: "b14",
			toolName: "bash",
			label: "Bash",
		});
		model.applyArgsChunk({ command });
		model.applyResult({
			content: [{ type: "text", text: "" }],
			details: {},
			isError: false,
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const rendered = root.text().map(line => sanitizeText(line));
		const findLine = (needle: string) => rendered.findIndex(line => line.includes(needle));
		const forLine = findLine("for f in a b; do");
		const echoLine = findLine('echo "$f"');
		const doneLine = findLine("done");
		expect(forLine).toBeGreaterThanOrEqual(0);
		expect(echoLine).toBeGreaterThanOrEqual(0);
		expect(doneLine).toBeGreaterThanOrEqual(0);
	});

	it("renders collapsed command as a viewport tail window", () => {
		const total = previewWindowRows() + 5;
		const command = Array.from({ length: total }, (_, i) => `echo step_${i}`).join("\n");

		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({
			id: "b15",
			toolName: "bash",
			label: "Bash",
		});
		model.applyArgsChunk({ command });
		model.applyResult({
			content: [{ type: "text", text: "" }],
			details: {},
			isError: false,
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 120, theme: uiTheme });
		roots.push(root);

		const rendered = sanitizeText(root.text().join("\n"));
		expect(rendered).toContain(`echo step_${total - 1}`);
		expect(rendered).toContain("earlier lines");
	});

	it("keeps a visual tail window with a complete-count expand marker", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({
			id: "b15-output",
			toolName: "bash",
			label: "Bash",
		});
		model.applyArgsChunk({ command: "printf output" });
		model.applyResult({
			content: [{ type: "text", text: Array.from({ length: 20 }, (_, index) => `output ${index}`).join("\n") }],
			details: {},
			isError: false,
		});

		const root = mountForTest(() => bashToolView.view(model), { width: 80, theme: uiTheme });
		roots.push(root);

		const rendered = sanitizeText(root.text().join("\n"));
		expect(rendered).toContain("output 19");
		expect(rendered).not.toContain("output 0");
		expect(rendered).toMatch(/earlier lines, showing \d+ of \d+/u);
		expect(rendered).toContain("Expand");
	});

	it("fine-grained reactivity: updating output does not rebuild header nodes", () => {
		const model = createToolCallModel<BashRenderArgs, BashToolDetails>({
			id: "b16",
			toolName: "bash",
			label: "Bash",
		});
		model.applyArgsChunk({ command: "make test" });

		const root = mountForTest(() => bashToolView.view(model), { width: 100, theme: uiTheme });
		roots.push(root);

		const initialNodes = root.counters().nodesCreated;
		model.applyResult({
			content: [{ type: "text", text: "step 1 passed\nstep 2 passed\n" }],
			details: { wallTimeMs: 1500 },
			isError: false,
		});
		root.flush();

		// Applying result updates existing document rather than thrashing node tree
		expect(root.text().join("\n")).toContain("step 1 passed");
		const nodesAfterResult = root.counters().nodesCreated;

		// Appending chunks to the output document streams without creating new host nodes
		model.output.apply({ kind: "append", text: "step 3 passed\n" });
		root.flush();
		expect(root.text().join("\n")).toContain("step 3 passed");
		expect(root.counters().nodesCreated).toBe(nodesAfterResult);
	});
});
