import { describe, expect, it } from "bun:test";
import { isRecord } from "@oh-my-pi/pi-utils";
import { dispatchHostInput } from "../src/host/overlay";
import {
	createSettingsSelectorController,
	SettingsSelectorView,
	type SettingsRuntimeContext,
} from "../src/overlays/settings-selector";
import type { PluginSettingsHost } from "../src/overlays/plugin-settings";
import type { SettingsDisplayEntry } from "../src/overlays/settings-defs";
import { mountForTest } from "../src/testing";

function pluginHost(): PluginSettingsHost {
	return {
		manager: {
			async list() {
				return [];
			},
			async getPlugin() {
				return undefined;
			},
			async getPluginSettings() {
				return {};
			},
			async setEnabled() {},
			async getEnabledFeatures() {
				return null;
			},
			async setEnabledFeatures() {},
			async setPluginSetting() {},
		},
		async createMarketplaceManager() {
			return {
				async listInstalledPlugins() {
					return [];
				},
				async setPluginEnabled() {},
			};
		},
		parsePluginId() {
			return null;
		},
	};
}

function context(entries: readonly SettingsDisplayEntry[], values: Record<string, unknown>): SettingsRuntimeContext {
	return {
		settings: {
			entries,
			get(path) {
				return values[path];
			},
			set(path, value) {
				values[path] = value;
			},
			normalizeProviderLimits(value) {
				if (!isRecord(value)) return {};
				const limits: Record<string, number> = {};
				for (const key in value) {
					const limit = value[key];
					if (typeof limit === "number") limits[key] = limit;
				}
				return limits;
			},
			validateProviderLimits(value) {
				return this.normalizeProviderLimits(value);
			},
		},
		plugins: pluginHost(),
		availableThinkingLevels: [],
		thinkingLevel: undefined,
		availableThemes: ["dark", "light"],
		providers: ["anthropic", "openai"],
	};
}

describe("settings selector", () => {
	it("keeps global search navigation in the matched setting tab", () => {
		const entries: SettingsDisplayEntry[] = [
			{
				path: "ui.compact",
				type: "boolean",
				defaultValue: false,
				ui: { tab: "appearance", label: "Compact", description: "Use compact layout", group: "Display" },
			},
			{
				path: "model.temperature",
				type: "number",
				defaultValue: 1,
				ui: {
					tab: "model",
					label: "Temperature",
					description: "Control model variation",
					group: "Sampling",
					options: [{ value: "1", label: "Balanced" }],
				},
			},
		];
		let cancelled = 0;
		const controller = createSettingsSelectorController(
			context(entries, { "ui.compact": false, "model.temperature": 1 }),
			{
				onChange() {},
				onCancel() {
					cancelled++;
				},
			},
		);

		controller.handleInput("temperature");
		expect(controller.query()).toBe("temperature");
		expect(controller.searchResults()[0]?.tab).toBe("model");
		controller.handleInput("\x1b");

		expect(controller.query()).toBe("");
		expect(controller.tab()).toBe("model");
		expect(cancelled).toBe(0);
		controller.handleInput("\x1b");
		expect(cancelled).toBe(1);
		controller.dispose();
	});

	it("keeps searched editors, selection and saved values visible in the same mounted settings view", () => {
		const entries: SettingsDisplayEntry[] = [
			{
				path: "interaction.steeringMode",
				type: "string",
				defaultValue: "default",
				ui: {
					tab: "interaction",
					label: "Steering Mode",
					description: "Configure steering",
					group: "Input",
					options: [{ value: "default", label: "Default" }],
				},
			},
			{
				path: "interaction.autocompleteMaxVisible",
				type: "number",
				defaultValue: 10,
				ui: {
					tab: "interaction",
					label: "Autocomplete Items",
					description: "Max visible items in autocomplete dropdown (3-20)",
					group: "Input",
					options: [3, 5, 7, 10, 15, 20].map(value => ({ value: String(value), label: `${value} items` })),
				},
			},
			{
				path: "interaction.toggle",
				type: "boolean",
				defaultValue: false,
				ui: { tab: "interaction", label: "Editable Toggle", description: "Toggle helper", group: "Input" },
			},
		];
		const viewContext = context(entries, {
			"interaction.steeringMode": "default",
			"interaction.autocompleteMaxVisible": 10,
			"interaction.toggle": false,
		});
		const controller = createSettingsSelectorController(viewContext, { onChange() {}, onCancel() {} });
		const root = mountForTest(() => SettingsSelectorView({ context: viewContext, controller }), {
			width: 80,
			height: 20,
		});
		try {
			root.flush();
			dispatchHostInput(root.root, "autocomplete");
			dispatchHostInput(root.root, "\n");
			expect(root.text().join("\n")).toContain(`${root.root.theme.nav.cursor} 10 items`);
			dispatchHostInput(root.root, "\x1b[B");
			expect(root.text().join("\n")).toContain(`${root.root.theme.nav.cursor} 15 items`);
			dispatchHostInput(root.root, "\n");
			expect(viewContext.settings.get("interaction.autocompleteMaxVisible")).toBe(15);
			expect(root.text().find(row => row.includes("Autocomplete Items"))).toMatch(/Autocomplete Items\s+15/);

			dispatchHostInput(root.root, "\x1b");
			const returned = root.text().join("\n");
			expect(returned).toContain("› Autocomplete Items");
			expect(returned).not.toContain("› Steering Mode");
			expect(returned).toContain("Max visible items in autocomplete dropdown (3-20)");

			dispatchHostInput(root.root, "\x1b[B");
			expect(root.text().join("\n")).toContain("› Editable Toggle");
			dispatchHostInput(root.root, " ");
			expect(viewContext.settings.get("interaction.toggle")).toBe(true);
			expect(root.text().find(row => row.includes("Editable Toggle"))).toMatch(/Editable Toggle\s+true/);
		} finally {
			root.dispose();
			controller.dispose();
		}
	});

	it("previews and commits runtime theme choices without treating them as a boolean cycle", () => {
		const entries: SettingsDisplayEntry[] = [
			{
				path: "theme.dark",
				type: "string",
				defaultValue: "dark",
				ui: {
					tab: "appearance",
					label: "Dark Theme",
					description: "Theme for dark terminals",
					group: "Theme",
					options: "runtime",
				},
			},
		];
		const values = { "theme.dark": "dark" };
		const previews: string[] = [];
		const changes: Array<[string, unknown]> = [];
		const controller = createSettingsSelectorController(context(entries, values), {
			onChange(path, value) {
				changes.push([path, value]);
			},
			onThemePreview(value) {
				previews.push(value);
			},
			onCancel() {},
		});

		controller.handleInput("\n");
		expect(controller.editorMode()).toBe("choice");
		controller.handleInput("\x1b[B");
		expect(previews).toEqual(["light"]);
		controller.handleInput("\n");

		expect(values["theme.dark"]).toBe("light");
		expect(changes).toEqual([["theme.dark", "light"]]);
		expect(controller.editorMode()).toBe("closed");
		controller.dispose();
	});

	it("keeps group and setting labels visible through native sidebar reflow", () => {
		const entries: SettingsDisplayEntry[] = [
			{
				path: "ui.compact",
				type: "boolean",
				defaultValue: false,
				ui: { tab: "appearance", label: "Compact Layout", description: "Use compact layout", group: "Theme" },
			},
			{
				path: "ui.density",
				type: "string",
				defaultValue: "comfortable",
				ui: {
					tab: "appearance",
					label: "Density",
					description: "Set display density",
					group: "Display",
					options: [{ value: "comfortable", label: "Comfortable" }],
				},
			},
		];
		const viewContext = context(entries, { "ui.compact": false, "ui.density": "comfortable" });
		const controller = createSettingsSelectorController(viewContext, { onChange() {}, onCancel() {} });
		const root = mountForTest(() => SettingsSelectorView({ context: viewContext, controller }), {
			width: 80,
			height: 16,
		});
		try {
			const wide = root.text().join("\n");
			expect(wide).toContain("Theme");
			expect(wide).toContain("Display");
			const narrow = root.text(35).join("\n");
			expect(narrow).toContain("Compact Layout");
		} finally {
			root.dispose();
			controller.dispose();
		}
	});

	it("retains multiselect ordering and drops excluded web-search providers", () => {
		const entries: SettingsDisplayEntry[] = [
			{
				path: "providers.webSearchOrder",
				type: "array",
				defaultValue: [],
				ui: {
					tab: "providers",
					label: "Web Search Provider Order",
					description: "Provider priority",
					group: "Services",
					ordered: true,
					options: [
						{ value: "alpha", label: "Alpha" },
						{ value: "beta", label: "Beta" },
					],
				},
			},
			{
				path: "providers.webSearchExclude",
				type: "array",
				defaultValue: [],
				ui: {
					tab: "providers",
					label: "Excluded Providers",
					description: "Excluded sources",
					group: "Services",
					options: [
						{ value: "alpha", label: "Alpha" },
						{ value: "beta", label: "Beta" },
					],
				},
			},
		];
		const values: Record<string, unknown> = {
			"providers.webSearchOrder": [],
			"providers.webSearchExclude": ["beta"],
		};
		const controller = createSettingsSelectorController(context(entries, values), { onChange() {}, onCancel() {} });

		controller.selectPanel("providers");
		controller.handleInput("\n");
		expect(controller.editorMode()).toBe("multiselect");
		controller.handleInput(" ");
		expect(values["providers.webSearchOrder"]).toEqual(["alpha"]);
		controller.handleInput("2");
		expect(values["providers.webSearchOrder"]).toEqual(["alpha"]);
		controller.dispose();
	});

	it("validates and persists individual provider request limits", () => {
		const entries: SettingsDisplayEntry[] = [
			{
				path: "providers.maxInFlightRequests",
				type: "record",
				defaultValue: {},
				ui: {
					tab: "providers",
					label: "Max In-Flight Requests",
					description: "Concurrent request caps",
					group: "Services",
				},
			},
		];
		const values: Record<string, unknown> = { "providers.maxInFlightRequests": {} };
		const controller = createSettingsSelectorController(context(entries, values), { onChange() {}, onCancel() {} });

		controller.selectPanel("providers");
		controller.handleInput("\n");
		expect(controller.editorMode()).toBe("provider-list");
		controller.handleInput("\n");
		expect(controller.editorMode()).toBe("provider-editor");

		controller.setDraft("0");
		controller.handleInput("\n");
		expect(controller.error()).toBe("Limit must be a positive number.");
		expect(values["providers.maxInFlightRequests"]).toEqual({});

		controller.setDraft("3.8");
		controller.handleInput("\n");
		expect(values["providers.maxInFlightRequests"]).toEqual({ anthropic: 3 });
		expect(controller.editorMode()).toBe("provider-list");
		controller.dispose();
	});
});
