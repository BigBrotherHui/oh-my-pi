import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { dispatchKey, HostKeyEvent } from "../src/host/input";
import {
	ModelHubView,
	type ModelHubCallbacks,
	type ModelHubRegistry,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { mountForTest } from "../src/testing";

function model(provider: string, id: string) {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1_024,
	});
}

function harness(projectStorage = false, width = 100, height = 24) {
	const available = [model("test", "model-a"), model("test", "model-b")];
	const configured: Record<string, string | undefined> = {};
	let chains: Record<string, string[]> = {};
	const assigned: Array<{ role: string; scope: string | undefined }> = [];
	const fallbackWrites: Array<{ role: string; chain: string[] }> = [];
	const source: ModelHubSource = {
		defaultThinkingLevel: "inherit",
		modelProviderOrder: [],
		knownRoleIds: ["default", "smol"],
		mruOrder: [],
		modelPerf: new Map(),
		disabledProviders: [],
		get fallbackChains() {
			return chains;
		},
		modelRoleStorage: projectStorage ? "project" : "global",
		cycleOrder: ["smol", "default"],
		getModelRole: role => configured[role],
		getProjectModelRole: role => configured[`project:${role}`],
		getGlobalModelRole: role => configured[`global:${role}`] ?? configured[role],
		getModelRoleSource: role =>
			configured[`project:${role}`]
				? "project"
				: configured[`global:${role}`] || configured[role]
					? "global"
					: "default",
		getRoleInfo: role => ({ tag: role.toUpperCase(), name: role, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: (value, models, lookup) => {
			const selector = value?.startsWith("@") ? lookup?.getModelRole(value.slice(1)) : value;
			const [provider, id] = selector?.split("/") ?? [];
			return {
				model: models.find(candidate => candidate.provider === provider && candidate.id === id),
				explicitThinkingLevel: false,
			};
		},
	};
	const registry: ModelHubRegistry = {
		authStorage: { hasAuth: () => true },
		getError: () => undefined,
		getAvailable: () => available,
		getAll: () => available,
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		find: (provider, id) =>
			available.find(
				candidate =>
					candidate.provider.toLowerCase() === provider.toLowerCase() &&
					candidate.id.toLowerCase() === id.toLowerCase(),
			),
		refresh: async () => {},
		refreshProvider: async () => {},
	};
	const callbacks: ModelHubCallbacks = {
		onAssign: (selected, role, _thinking, selector, scope) => {
			configured[scope === "project" ? `project:${role}` : scope === "global" ? `global:${role}` : role] = selector;
			assigned.push({ role, scope });
			return true;
		},
		onUnassign: (role, scope) => {
			delete configured[scope === "project" ? `project:${role}` : scope === "global" ? `global:${role}` : role];
		},
		onFallbackChainChange: (role, chain) => {
			chains = { ...chains, [role]: chain };
			fallbackWrites.push({ role, chain });
		},
		onCancel: () => {},
	};
	const root = mountForTest(
		() => (
			<ModelHubView
				source={source}
				registry={registry}
				scopedModels={available.map(item => ({ model: item }))}
				callbacks={callbacks}
			/>
		),
		{ width, height },
	);
	const key = (data: string): void => {
		dispatchKey(root.root, new HostKeyEvent(data));
		root.flush();
	};
	return { root, key, assigned, fallbackWrites };
}

describe("ModelHubView", () => {
	test("fills wide, normal, and short viewports", () => {
		for (const [width, height] of [
			[120, 32],
			[80, 20],
			[42, 14],
		] as const) {
			const view = harness(false, width, height);
			try {
				expect(view.root.rows()).toHaveLength(height);
				expect(view.root.text().join("\n")).toContain("Models");
				expect(view.root.text().join("\n")).toContain("model-a");
			} finally {
				view.root.dispose();
			}
		}
	});

	test("keeps kind tabs, rich browser details, and narrow clipping", () => {
		const view = harness();
		try {
			const wide = view.root.text(100).join("\n");
			expect(wide).toContain("Kind:");
			expect(wide).toContain("model-a");
			expect(wide).toContain("128k");
			const narrow = view.root.text(42).join("\n");
			expect(narrow).toContain("Models");
			expect(narrow).toContain("Kind:");
		} finally {
			view.root.dispose();
		}
	});

	test("edits a fallback chain from the role view and returns to its row", () => {
		const view = harness();
		try {
			view.key("\x1b[A");
			view.key("\n");
			view.key("f");
			expect(view.root.text().join("\n")).toContain("Adding fallback for DEFAULT");
			view.key("\n");
			expect(view.fallbackWrites).toEqual([{ role: "default", chain: ["test/model-a"] }]);
			expect(view.root.text().join("\n")).toContain("↳ test/model-a");
		} finally {
			view.root.dispose();
		}
	});

	test("assigns the selected role to project and global destinations by keyboard", () => {
		const project = harness(true);
		try {
			project.key("\n");
			project.key("\n");
			project.key("\n");
			expect(project.assigned).toEqual([{ role: "default", scope: "project" }]);
		} finally {
			project.root.dispose();
		}

		const global = harness(true);
		try {
			global.key("\n");
			global.key("\n");
			global.key("\x1b[B");
			global.key("\n");
			expect(global.assigned).toEqual([{ role: "default", scope: "global" }]);
		} finally {
			global.root.dispose();
		}
	});
});
