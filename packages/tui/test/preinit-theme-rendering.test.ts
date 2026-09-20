import { describe, expect, it } from "bun:test";

const CHILD_ENV = {
	...Bun.env,
	KITTY_WINDOW_ID: "",
	GHOSTTY_RESOURCES_DIR: "",
	WEZTERM_PANE: "",
	ITERM_SESSION_ID: "",
	VSCODE_PID: "",
	ALACRITTY_WINDOW_ID: "",
	TERM_PROGRAM: "Apple_Terminal",
	TERM: "xterm-256color",
	COLORTERM: "",
	WT_SESSION: "",
};

async function expectFreshModuleRender(script: string): Promise<void> {
	const proc = Bun.spawn([process.execPath, "-e", script], {
		stdout: "pipe",
		stderr: "pipe",
		env: CHILD_ENV,
	});
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(code).toBe(0);
	expect(stdout).toBe("ok");
}

// `bun test` shares one module registry across files, so sibling theme initialization
// hides pre-init failures. Each case uses a fresh process to reproduce the module graph
// created by plugin/extension loading before `initTheme`/`initThemeSync`.
describe("rendering before theme initialization (#10864)", () => {
	const testing = new URL("../src/testing.ts", import.meta.url).pathname;
	it("uses detected terminal capabilities for a magic-keyword gradient", async () => {
		const entry = Bun.resolveSync("@oh-my-pi/pi-tui/prompt/magic-keywords", import.meta.dir);
		await expectFreshModuleRender(`
			import { highlightMagicKeywords } from ${JSON.stringify(entry)};
			const text = "please ultrathink about this";
			const out = highlightMagicKeywords(text, undefined, 0);
			if (out.replaceAll(/\\x1b\\[[0-9;]*m/g, "") !== text) throw new Error("visible-text-changed");
			if (!out.includes("\\x1b[38;5;")) throw new Error("no-256-color-gradient");
			if (out.includes("\\x1b[38;2;")) throw new Error("unsupported-truecolor-gradient");
			process.stdout.write("ok");
		`);
	});

	it("constructs and renders a retained tool view", async () => {
		const entry = new URL("../src/tools/bash.tsx", import.meta.url).pathname;
		const models = new URL("../src/tools/model.ts", import.meta.url).pathname;
		await expectFreshModuleRender(`
			import { bashToolView } from ${JSON.stringify(entry)};
			import { createToolCallModel } from ${JSON.stringify(models)};
			import { renderToText } from ${JSON.stringify(testing)};
			const model = createToolCallModel({ id: "id", toolName: "bash", label: "Bash" });
			model.applyArgsChunk({ command: "echo hi" });
			const out = renderToText(() => bashToolView.view(model), 80).join("\\n");
			if (!out.includes("echo hi")) throw new Error("tool-output-missing");
			process.stdout.write("ok");
		`);
	});

	it("constructs and renders assistant Markdown", async () => {
		const entry = new URL("../src/chat/assistant-message.tsx", import.meta.url).pathname;
		const testing = new URL("../src/testing.ts", import.meta.url).pathname;
		await expectFreshModuleRender(`
			import { AssistantMessageView } from ${JSON.stringify(entry)};
			import { renderToRows } from ${JSON.stringify(testing)};
			const message = {
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const out = Bun.stripANSI(renderToRows(() => AssistantMessageView({ message, expanded: false }), 80).join("\\n"));
			if (!out.includes("hello")) throw new Error("assistant-output-missing");
			process.stdout.write("ok");
		`);
	});

	it("constructs and renders a user message", async () => {
		const entry = new URL("../src/chat/user-message.tsx", import.meta.url).pathname;
		await expectFreshModuleRender(`
			import { UserMessageView } from ${JSON.stringify(entry)};
			import { renderToText } from ${JSON.stringify(testing)};
			const out = renderToText(() => UserMessageView({ text: "hello" }), 80).join("\\n");
			if (!out.includes("hello")) throw new Error("user-output-missing");
			process.stdout.write("ok");
		`);
	});

	it("constructs and renders the usage dashboard", async () => {
		const entry = new URL("../src/overlays/usage-dashboard.tsx", import.meta.url).pathname;
		await expectFreshModuleRender(`
			import { UsageDashboardView } from ${JSON.stringify(entry)};
			import { renderToText } from ${JSON.stringify(testing)};
			const out = renderToText(() => UsageDashboardView({
				options: {
					reports: [],
					renderDetail: () => "",
					loadActivity: async push => push([]),
					onClose() {},
				},
			}), 80).join("\\n");
			if (!out.includes("Usage")) throw new Error("usage-output-missing");
			process.stdout.write("ok");
		`);
	});
});
