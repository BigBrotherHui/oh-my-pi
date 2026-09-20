import { describe, expect, it } from "bun:test";
import type { JSX } from "@oh-my-pi/pi-tui/reactive";
import { mountForTest } from "@oh-my-pi/pi-tui/testing";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import {
	McpNotificationsView,
	McpPromptsView,
	McpResourcesView,
	McpServerListView,
} from "@oh-my-pi/pi-coding-agent/modes/components/mcp-command-views";
import { SshHostListView } from "@oh-my-pi/pi-coding-agent/modes/components/ssh-command-views";

function render(view: () => JSX.Element): string {
	const root = mountForTest(view, { width: 160, theme: loadThemeSync("dark") });
	const text = root.text().join("\n");
	root.dispose();
	return text;
}

describe("MCP and SSH command views", () => {
	it("keeps MCP source, transport, and connection distinctions in the retained list", () => {
		const text = render(() =>
			McpServerListView({
				groups: [
					{
						label: "User level",
						path: "/Users/test/.omp/agent/mcp.json",
						servers: [
							{ name: "ready", type: "http", state: "connected" },
							{ name: "paused", type: "stdio", state: "inactive" },
							{ name: "booting", type: "sse", state: "connecting" },
						],
					},
					{ label: "Disabled", servers: [{ name: "third-party", state: "disabled" }] },
				],
			}),
		);

		expect(text).toContain("User level");
		expect(text).toContain("ready");
		expect(text).toContain("[http]");
		expect(text).toContain("connected");
		expect(text).toContain("inactive");
		expect(text).toContain("connecting");
		expect(text).toContain("disabled");
	});

	it("renders resource, prompt, and notification metadata without an ANSI serialization step", () => {
		const resources = render(() =>
			McpResourcesView({
				groups: [
					{
						name: "catalog",
						resources: [
							{ uri: "https://example.test/resource", mimeType: "application/json", description: "A resource" },
						],
						templates: [{ uriTemplate: "https://example.test/{id}", description: "A template" }],
					},
				],
			}),
		);
		const prompts = render(() =>
			McpPromptsView({
				groups: [
					{
						name: "catalog",
						prompts: [
							{
								name: "search",
								description: "Search items",
								arguments: [{ name: "query", required: true, description: "Terms" }],
							},
						],
					},
				],
			}),
		);
		const notifications = render(() =>
			McpNotificationsView({
				enabled: true,
				groups: [
					{
						name: "catalog",
						toolsChanged: true,
						resourcesChanged: true,
						promptsChanged: false,
						supportsSubscribe: true,
						supportsResources: true,
						subscriptions: ["https://example.test/resource"],
					},
				],
			}),
		);

		expect(resources).toContain("application/json");
		expect(resources).toContain("https://example.test/{id}");
		expect(prompts).toContain("/catalog:search");
		expect(prompts).toContain("required");
		expect(notifications).toContain("subscribed (1 URI)");
		expect(notifications).toContain("resources/list_changed");
	});

	it("keeps SSH profiles grouped by their writable and discovered sources", () => {
		const text = render(() =>
			SshHostListView({
				groups: [
					{
						label: "Project level",
						path: "/work/project/.omp/ssh.json",
						hosts: [{ name: "build", host: "build.example.test", username: "ci", port: 2222 }],
					},
					{
						label: "Discovered · VS Code",
						path: "/work/project/.vscode/ssh.json",
						readOnly: true,
						hosts: [{ name: "docs", host: "docs.example.test" }],
					},
				],
			}),
		);

		expect(text).toContain("Project level");
		expect(text).toContain("build.example.test");
		expect(text).toContain("user=ci");
		expect(text).toContain("port=2222");
		expect(text).toContain("read-only");
	});
});
