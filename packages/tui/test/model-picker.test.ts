import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { dispatchHostInput } from "../src/host/overlay";
import {
	ModelPickerView,
	openModelPickerOverlay,
	type ModelPickerCallbacks,
	type ModelPickerRegistry,
	type ResolvedRoleModel,
} from "../src/overlays/model-picker";
import type { ModelBrowserPerf, ModelBrowserSource } from "../src/overlays/model-browser";
import { mountForTest } from "../src/testing";
import { render } from "../src/root";
import { VirtualTerminal } from "./virtual-terminal";
import { loadThemeSync } from "../src/theme/loader";
import { visibleWidth } from "../src/utils";
import { cellGrid } from "./cell-grid";

function createModel(id: string, contextWindow = 128_000): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider: "test",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1024,
	});
}

const testTheme = loadThemeSync("dark");

const source = {
	defaultThinkingLevel: "inherit",
	modelProviderOrder: [],
	knownRoleIds: [],
	mruOrder: [],
	modelPerf: new Map<string, ModelBrowserPerf>(),
	getModelRole() {
		return undefined;
	},
	getRoleInfo(role) {
		return {
			name: role,
			accepts() {
				return true;
			},
			section: "chat",
		};
	},
	defaultRoleChain() {
		return [];
	},
	resolveRoleValue() {
		return { model: undefined, explicitThinkingLevel: false };
	},
} satisfies ModelBrowserSource;

function createRegistry(models: Model[], refresh: () => Promise<void> = async () => {}): ModelPickerRegistry {
	return {
		refresh() {
			return refresh();
		},
		getError() {
			return undefined;
		},
		getAvailable() {
			return models;
		},
		getAll() {
			return models;
		},
	};
}

function callbacks(
	picked: Array<{ model: Model; selector: string; overContext: boolean }>,
	roles: ResolvedRoleModel[],
	tasks: Array<{ model: Model; selector: string }>,
): ModelPickerCallbacks {
	return {
		onPick(model, selector, meta) {
			picked.push({ model, selector, overContext: meta.overContext });
		},
		onPickRole(entry) {
			roles.push(entry);
		},
		onPickTask(model, selector) {
			tasks.push({ model, selector });
		},
		onCancel() {},
	};
}

describe("ModelPickerView", () => {
	it("warns before an over-context session switch and passes the compaction metadata", () => {
		const model = createModel("small", 4_096);
		const picked: Array<{ model: Model; selector: string; overContext: boolean }> = [];
		const roles: ResolvedRoleModel[] = [];
		const tasks: Array<{ model: Model; selector: string }> = [];
		const root = mountForTest(() =>
			ModelPickerView({
				settings: source,
				registry: createRegistry([model]),
				scopedModels: [{ model }],
				callbacks: callbacks(picked, roles, tasks),
				options: { currentContextTokens: 6_000 },
			}),
		);
		try {
			expect(root.text().join("\n")).toContain("compacts with current model");
			dispatchHostInput(root.root, "\n");
			expect(picked).toEqual([{ model, selector: "test/small", overContext: true }]);
		} finally {
			root.dispose();
		}
	});

	it("uses the configured @ role order and applies the preselected quick role", () => {
		const smol = createModel("smol");
		const slow = createModel("slow");
		const quickRoles: ResolvedRoleModel[] = [
			{ role: "smol", model: smol, explicitThinkingLevel: false },
			{ role: "slow", model: slow, explicitThinkingLevel: false },
		];
		const picked: Array<{ model: Model; selector: string; overContext: boolean }> = [];
		const appliedRoles: ResolvedRoleModel[] = [];
		const tasks: Array<{ model: Model; selector: string }> = [];
		const root = mountForTest(
			() =>
				ModelPickerView({
					settings: source,
					registry: createRegistry([smol, slow]),
					scopedModels: [{ model: smol }, { model: slow }],
					callbacks: callbacks(picked, appliedRoles, tasks),
					options: { quickRoles, quickRoleOrder: ["smol", "slow"], currentQuickRole: "slow" },
				}),
			{ theme: testTheme },
		);
		try {
			root.flush();
			dispatchHostInput(root.root, "@");
			const text = root.text().join("\n");
			const cells = cellGrid(root.rows(), 80).flat();
			const slowColor = cellGrid([`${testTheme.getFgAnsi("success")}x`], 1)[0]?.[0]?.fg;
			const slowLabel = cells.some(cell => cell.ch === "@" && JSON.stringify(cell.fg) === JSON.stringify(slowColor));
			expect(text).toContain("@smol");
			expect(text).toContain("@slow");
			expect(slowLabel).toBe(true);
			dispatchHostInput(root.root, "\n");
			expect(appliedRoles).toEqual([quickRoles[1]]);
			expect(picked).toEqual([]);
		} finally {
			root.dispose();
		}
	});

	it("switches to the Task target with its historical error chrome and return hint", () => {
		const sessionModel = createModel("session");
		const taskModel = createModel("task");
		const picked: Array<{ model: Model; selector: string; overContext: boolean }> = [];
		const roles: ResolvedRoleModel[] = [];
		const tasks: Array<{ model: Model; selector: string }> = [];
		const root = mountForTest(() =>
			ModelPickerView({
				settings: source,
				registry: createRegistry([sessionModel, taskModel]),
				scopedModels: [{ model: sessionModel }, { model: taskModel }],
				callbacks: callbacks(picked, roles, tasks),
				options: {
					currentSelector: "test/session",
					taskSelector: "test/task",
					taskModeKeys: ["alt+p"],
					taskModeKeyLabel: "alt+p",
				},
			}),
		);
		try {
			root.flush();
			dispatchHostInput(root.root, "\u001bp");
			const text = root.text(160).join("\n");
			expect(text).toContain("Switch Task Model");
			expect(text).toContain("Task subagent switch");
			expect(text).toContain("alt+p session model");
			dispatchHostInput(root.root, "\n");
			expect(tasks).toEqual([{ model: taskModel, selector: "test/task" }]);
			expect(picked).toEqual([]);
		} finally {
			root.dispose();
		}
	});

	it("mounts the real picker at full terminal width with its bottom anchor on wide and narrow screens", () => {
		const model = createModel("wide-terminal");
		for (const { width, height } of [
			{ width: 110, height: 36 },
			{ width: 60, height: 24 },
		]) {
			const terminal = new VirtualTerminal(width, height);
			const root = render(() => undefined, { terminal, theme: testTheme });
			const overlay = openModelPickerOverlay(root.tui, source, createRegistry([model]), [{ model }], {
				onPick() {},
				onCancel() {},
			});
			try {
				root.tui.renderNow();
				const viewport = terminal.getViewport();
				const heading = viewport.find(row => row.includes("Switch Model"));
				expect(heading?.startsWith(testTheme.boxRound.topLeft)).toBe(true);
				expect(visibleWidth(heading ?? "")).toBe(width);
				expect(viewport.at(-1)?.startsWith(testTheme.boxRound.bottomLeft)).toBe(true);
			} finally {
				overlay.dispose();
				root.dispose();
			}
		}
	});

	it("uses live viewport rows and compact-width boundaries", () => {
		const models = Array.from({ length: 10 }, (_value, index) => createModel(`model-${index}`));
		const picked: Array<{ model: Model; selector: string; overContext: boolean }> = [];
		const roles: ResolvedRoleModel[] = [];
		const tasks: Array<{ model: Model; selector: string }> = [];
		const root = mountForTest(
			() =>
				ModelPickerView({
					settings: source,
					registry: createRegistry(models),
					scopedModels: models.map(model => ({ model })),
					callbacks: callbacks(picked, roles, tasks),
				}),
			{ width: 80, height: 40 },
		);
		try {
			expect(root.text()).toHaveLength(16);
			expect(root.text(3).every(line => visibleWidth(line) <= 3)).toBe(true);
		} finally {
			root.dispose();
		}
	});

	it("clears an active query before dismissing the picker", () => {
		const model = createModel("query");
		const picked: Array<{ model: Model; selector: string; overContext: boolean }> = [];
		const roles: ResolvedRoleModel[] = [];
		const tasks: Array<{ model: Model; selector: string }> = [];
		let cancelled = 0;
		const root = mountForTest(() =>
			ModelPickerView({
				settings: source,
				registry: createRegistry([model]),
				scopedModels: [{ model }],
				callbacks: {
					...callbacks(picked, roles, tasks),
					onCancel() {
						cancelled++;
					},
				},
			}),
		);
		try {
			root.flush();
			dispatchHostInput(root.root, "q");
			dispatchHostInput(root.root, "\u001b");
			expect(cancelled).toBe(0);
			dispatchHostInput(root.root, "\u001b");
			expect(cancelled).toBe(1);
		} finally {
			root.dispose();
		}
	});

	it("uses cached catalog models before the offline refresh settles", () => {
		const model = createModel("cached");
		const refresh = Promise.withResolvers<void>();
		const picked: Array<{ model: Model; selector: string; overContext: boolean }> = [];
		const roles: ResolvedRoleModel[] = [];
		const tasks: Array<{ model: Model; selector: string }> = [];
		const root = mountForTest(() =>
			ModelPickerView({
				settings: source,
				registry: createRegistry([model], () => refresh.promise),
				scopedModels: [],
				callbacks: callbacks(picked, roles, tasks),
			}),
		);
		try {
			root.flush();
			dispatchHostInput(root.root, "\n");
			expect(picked).toEqual([{ model, selector: "test/cached", overContext: false }]);
		} finally {
			root.dispose();
			refresh.resolve();
		}
	});
});
