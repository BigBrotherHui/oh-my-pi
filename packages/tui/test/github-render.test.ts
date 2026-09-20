import { beforeAll, describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	buildOpMeta,
	formatPrIdentifier,
	githubToolView,
	type GhToolDetails,
	type GithubToolRenderArgs,
} from "@oh-my-pi/pi-tui/tools/github";
import { createToolCallModel } from "@oh-my-pi/pi-tui/tools/model";

beforeAll(async () => {
	await initTheme();
});

describe("githubToolView", () => {
	it("renders repo view operation in a framed multi-line result", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const model = createToolCallModel<GithubToolRenderArgs, GhToolDetails>({
			id: "call-gh-1",
			toolName: "github",
			label: "github",
		});
		model.applyArgsChunk({ op: "repo_view", repo: "owner/repo", branch: "main" });
		model.applyResult({
			content: [{ type: "text", text: "owner/repo\nDescription: Test repo\nDefault branch: main" }],
		});

		const root = mountForTest(() => githubToolView.view(model), { width: 100, theme: theme! });
		try {
			const text = root.text().join("\n");
			expect(text).toContain("GitHub Repo");
			expect(text).toContain("owner/repo");
			expect(text).toContain("Description: Test repo");
		} finally {
			root.dispose();
		}
	});

	it("updates a running workflow watcher through failure logs and expansion", async () => {
		const theme = await getThemeByName("dark");
		const model = createToolCallModel<GithubToolRenderArgs, GhToolDetails>({
			id: "call-gh-2",
			toolName: "github",
			label: "github",
		});
		model.applyArgsChunk({ op: "run_watch", repo: "owner/repo", run: "12345" });
		model.markRunning();
		model.setUi({ expanded: false, allocation: 80, showImages: true });

		const root = mountForTest(() => githubToolView.view(model), { width: 100, theme: theme! });
		try {
			expect(root.text().join("\n")).toContain("waiting for workflow data...");

			model.applyResult(
				{
					content: [{ type: "text", text: "Watching workflow" }],
					details: {
						watch: {
							mode: "run",
							state: "watching",
							repo: "owner/repo",
							run: {
								id: 12345,
								workflowName: "CI Tests",
								branch: "main",
								jobs: [
									{ id: 1, name: "Lint", status: "completed", conclusion: "success", durationSeconds: 12 },
									{ id: 2, name: "Build", status: "in_progress", durationSeconds: 45 },
								],
							},
						},
					},
				},
				{ partial: true },
			);
			root.flush();
			let text = root.text().join("\n");
			expect(text).toContain("CI Tests");
			expect(text).toContain("Lint");
			expect(text).toContain("Build");

			model.applyResult({
				content: [{ type: "text", text: "Workflow failed" }],
				details: {
					watch: {
						mode: "run",
						state: "completed",
						repo: "owner/repo",
						run: {
							id: 12345,
							workflowName: "CI Tests",
							branch: "main",
							jobs: [{ id: 2, name: "Build", status: "completed", conclusion: "failure", durationSeconds: 45 }],
						},
						failedLogs: [
							{
								runId: 12345,
								workflowName: "CI Tests",
								jobName: "Build",
								tail: "line 1\nline 2\nline 3\nline 4\nline 5",
								available: true,
							},
						],
					},
				},
			});
			root.flush();
			text = root.text().join("\n");
			expect(text).toContain("failed logs");
			expect(text).toContain("line 3");
			expect(text).toContain("line 5");
			expect(text).not.toContain("line 1");
			expect(text).toContain("2 more log lines");

			model.setUi({ expanded: true });
			root.flush();
			text = root.text().join("\n");
			expect(text).toContain("line 1");
			expect(text).not.toContain("more log lines");
		} finally {
			root.dispose();
		}
	});

	it("uses the historical head preview budget before expansion", async () => {
		const theme = await getThemeByName("dark");
		const model = createToolCallModel<GithubToolRenderArgs, GhToolDetails>({
			id: "call-gh-3",
			toolName: "github",
			label: "github",
		});
		model.applyArgsChunk({ op: "search_code", query: "needle", repo: "owner/repo" });
		model.applyResult({
			content: [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `result ${index + 1}`).join("\n") }],
		});
		model.setUi({ expanded: false, allocation: 80, showImages: true });

		const root = mountForTest(() => githubToolView.view(model), { width: 100, theme: theme! });
		try {
			let text = root.text().join("\n");
			expect(text).toContain("result 10");
			expect(text).not.toContain("result 11");
			expect(text).toContain("2 more lines");

			model.setUi({ expanded: true });
			root.flush();
			text = root.text().join("\n");
			expect(text).toContain("result 12");
			expect(text).not.toContain("more lines");
		} finally {
			root.dispose();
		}
	});

	it("surfaces cancelled operations as aborted instead of successful", async () => {
		const theme = await getThemeByName("dark");
		const model = createToolCallModel<GithubToolRenderArgs, GhToolDetails>({
			id: "call-gh-4",
			toolName: "github",
			label: "github",
		});
		model.applyArgsChunk({ op: "pr_push", pr: "https://github.com/owner/repo/pull/42", repo: "owner/repo" });
		model.applyResult({ content: [], status: "cancelled" });

		const root = mountForTest(() => githubToolView.view(model), { width: 100, theme: theme! });
		try {
			expect(root.text().join("\n")).toContain("request aborted");
			expect(githubToolView.summary?.(model)?.status).toBe("aborted");
		} finally {
			root.dispose();
		}
	});

	it("preserves pull identifiers and bounded search metadata", () => {
		expect(formatPrIdentifier(["1", "https://github.com/o/r/pull/2", "3", "4"])).toBe("#1, #2, #3, +1 more");
		const query = "q".repeat(120);
		const meta = buildOpMeta({ op: "search_code", query, repo: "owner/repo" });
		expect(meta[0]).not.toBe(query);
		expect(meta[1]).toBe("owner/repo");
	});
});
