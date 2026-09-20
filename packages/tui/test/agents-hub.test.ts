import { describe, expect, test } from "bun:test";
import { dispatchHostInput } from "../src/host/overlay";
import { AgentsHubView, type AgentsHubDeps, type HubAgent } from "../src/overlays/agents-hub";
import type { ModelBrowserPerf } from "../src/overlays/model-browser";
import { mountForTest, type TestRoot } from "../src/testing";

function agent(name: string, source: HubAgent["source"], description: string): HubAgent {
	return { name, source, description, systemPrompt: "", disabled: false };
}

function createDeps(overrides: Partial<Record<"model" | "prewalk" | "advisor", Record<string, string>>> = {}): {
	readonly deps: AgentsHubDeps;
	readonly disabled: () => readonly string[];
	readonly savedOverride: (property: "model" | "prewalk" | "advisor") => Readonly<Record<string, string>>;
} {
	let disabled: readonly string[] = [];
	const persisted: Record<"model" | "prewalk" | "advisor", Record<string, string>> = {
		model: { ...overrides.model },
		prewalk: { ...overrides.prewalk },
		advisor: { ...overrides.advisor },
	};
	const loadAgents = async (): Promise<HubAgent[]> => {
		const rows = [
			agent("dev", "project", "Development agent"),
			agent("scout", "bundled", "Read-only research"),
			agent("task", "bundled", "Generic task agent"),
		];
		return rows.map(row => ({
			...row,
			disabled: disabled.includes(row.name),
			overrideModel: persisted.model[row.name],
			prewalkOverride: persisted.prewalk[row.name],
			advisorOverride: persisted.advisor[row.name],
		}));
	};
	return {
		deps: {
			browserSource: {
				defaultThinkingLevel: "high",
				modelProviderOrder: [],
				knownRoleIds: [],
				mruOrder: [],
				modelPerf: new Map<string, ModelBrowserPerf>(),
				getModelRole: () => undefined,
				getRoleInfo: role => ({ name: role, accepts: () => true, section: "chat" }),
				defaultRoleChain: () => [],
				resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
			},
			loadAgents,
			getAvailableModels: () => [],
			effectiveModelPatterns: row => (row.overrideModel ? [row.overrideModel] : []),
			resolvePatterns: () => undefined,
			effectivePrewalkPattern: row => (row.prewalkOverride === "on" ? "@task" : undefined),
			effectiveAdvisorPattern: row => (row.advisorOverride === "on" ? "@advisor" : undefined),
			setDisabledAgents: names => {
				disabled = names;
			},
			setOverrides: (property, values) => {
				persisted[property] = values;
			},
			generateAgent: async () => "",
			saveAgent: async () => "agents/generated.md",
		},
		disabled: () => disabled,
		savedOverride: property => persisted[property],
	};
}

async function mountedHub(deps: AgentsHubDeps, onCancel = () => {}): Promise<TestRoot> {
	const root = mountForTest(() => AgentsHubView({ deps, callbacks: { onCancel } }), { width: 120 });
	await Promise.resolve();
	root.flush();
	await Promise.resolve();
	root.flush();
	return root;
}

describe("agents hub", () => {
	test("renders sorted source scopes, the roster, and the new-agent action", async () => {
		const { deps } = createDeps();
		const root = await mountedHub(deps);
		try {
			const text = root.text(120).join("\n");
			expect(text).toContain("Agents");
			expect(text).toContain("All agents");
			expect(text).toContain("Project");
			expect(text).toContain("Bundled");
			expect(text).toContain("dev");
			expect(text).toContain("scout");
			expect(text).toContain("+ New agent…");
		} finally {
			root.dispose();
		}
	});

	test("filters before dismissal, then dismisses on a second escape", async () => {
		const { deps } = createDeps();
		let cancelled = false;
		const root = await mountedHub(deps, () => {
			cancelled = true;
		});
		try {
			for (const key of "sco") dispatchHostInput(root.root, key);
			expect(root.text(120).join("\n")).toContain("scout");
			expect(root.text(120).join("\n")).not.toContain("dev");
			dispatchHostInput(root.root, "\x1b");
			expect(cancelled).toBe(false);
			expect(root.text(120).join("\n")).toContain("dev");
			dispatchHostInput(root.root, "\x1b");
			expect(cancelled).toBe(true);
		} finally {
			root.dispose();
		}
	});

	test("persists space toggles and advisor strip overrides", async () => {
		const { deps, disabled, savedOverride } = createDeps();
		const root = await mountedHub(deps);
		try {
			dispatchHostInput(root.root, " ");
			expect(disabled()).toEqual(["dev"]);
			dispatchHostInput(root.root, "\r");
			dispatchHostInput(root.root, "\x1b[C");
			dispatchHostInput(root.root, "\x1b[C");
			dispatchHostInput(root.root, "\r");
			dispatchHostInput(root.root, "\x1b[C");
			dispatchHostInput(root.root, "\r");
			expect(savedOverride("advisor")).toEqual({ dev: "on" });
			expect(root.text(120).join("\n")).toContain("dev advisor: on (@advisor)");
		} finally {
			root.dispose();
		}
	});

	test("opens the architect creation flow from the trailing roster row", async () => {
		const { deps } = createDeps();
		const root = await mountedHub(deps);
		try {
			for (let index = 0; index < 3; index++) dispatchHostInput(root.root, "\x1b[B");
			dispatchHostInput(root.root, "\r");
			expect(root.text(120).join("\n")).toContain("Create new agent");
			expect(root.text(120).join("\n")).toContain("Ctrl+Q/Ctrl+Enter generate");
		} finally {
			root.dispose();
		}
	});
});
