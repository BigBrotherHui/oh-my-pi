import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { dispatchKey, HostKeyEvent } from "../src/host/input";
import { ModelSceneView, type ModelSceneContext } from "../src/setup/scenes/model";
import { mountForTest, type TestRoot } from "../src/testing";
import type { ModelBrowserPerf, ModelBrowserSource } from "../src/overlays/model-browser";

function model(id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider: "test",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

function modelSource(defaultSelector: string): ModelBrowserSource {
	return {
		defaultThinkingLevel: "inherit",
		modelProviderOrder: [],
		knownRoleIds: ["default"],
		mruOrder: [],
		modelPerf: new Map<string, ModelBrowserPerf>(),
		getModelRole(role) {
			return role === "default" ? defaultSelector : undefined;
		},
		getRoleInfo(role) {
			return {
				name: role,
				section: "chat",
				accepts() {
					return true;
				},
			};
		},
		defaultRoleChain() {
			return [];
		},
		resolveRoleValue(value, models) {
			return {
				model: models.find(candidate => `${candidate.provider}/${candidate.id}` === value),
				explicitThinkingLevel: false,
			};
		},
	};
}

function press(root: TestRoot, data: string): void {
	dispatchKey(root.root, new HostKeyEvent(data));
	root.flush();
}

function createContext(
	models: Model[],
	completed: Array<"done" | "skipped">,
	options: {
		readonly selected?: Array<{ readonly model: Model; readonly selector: string }>;
		readonly refresh?: () => Promise<void>;
	} = {},
): ModelSceneContext {
	const current = models[0];
	return {
		host: {
			modelSource: modelSource(`${current?.provider}/${current?.id}`),
			getModels() {
				return { available: models, all: models, current };
			},
			refreshModels: options.refresh ?? (() => new Promise<void>(() => {})),
			async selectModel(model, selector) {
				options.selected?.push({ model, selector });
			},
		},
		complete(result) {
			completed.push(result);
		},
		availableRows: () => 10,
	};
}

describe("ModelSceneView", () => {
	it("keeps the searchable browser's cancellation ladder and compact row budget", () => {
		const models = [
			model("default"),
			model("other"),
			model("third"),
			model("fourth"),
			model("fifth"),
			model("sixth"),
		];
		const completed: Array<"done" | "skipped"> = [];
		const root = mountForTest(() => ModelSceneView(createContext(models, completed)), { width: 40, height: 24 });
		try {
			const initial = root.text().join("\n");
			expect(initial).toContain("Discovering available models…");
			expect(initial).toContain("test/default");
			expect(initial).toContain("test/fifth");
			expect(initial).not.toContain("test/fourth");
			press(root, "o");
			press(root, "\x1b");
			expect(completed).toEqual([]);
			press(root, "\x1b");
			expect(completed).toEqual(["skipped"]);
		} finally {
			root.dispose();
		}
	});

	it("surfaces discovery failures without discarding the initial model scope", async () => {
		const models = [model("default")];
		const completed: Array<"done" | "skipped"> = [];
		const root = mountForTest(
			() =>
				ModelSceneView(
					createContext(models, completed, {
						refresh: async () => {
							throw new Error("catalog offline");
						},
					}),
				),
			{ width: 80, height: 24 },
		);
		try {
			root.flush();
			await Promise.resolve();
			root.flush();
			const content = root.text().join("\n");
			expect(content).toContain("catalog offline");
			expect(content).toContain("test/default");
			expect(completed).toEqual([]);
		} finally {
			root.dispose();
		}
	});

	it("persists the highlighted rich-browser selection with its canonical selector", async () => {
		const defaultModel = model("default");
		const otherModel = model("other");
		const models = [defaultModel, otherModel];
		const completed: Array<"done" | "skipped"> = [];
		const selected: Array<{ readonly model: Model; readonly selector: string }> = [];
		const root = mountForTest(() => ModelSceneView(createContext(models, completed, { selected })), {
			width: 80,
			height: 24,
		});
		try {
			root.flush();
			press(root, "\x1b[B");
			press(root, "\n");
			await Promise.resolve();
			root.flush();
			expect(selected).toEqual([{ model: otherModel, selector: "test/other" }]);
			expect(completed).toEqual(["done"]);
		} finally {
			root.dispose();
		}
	});
});
