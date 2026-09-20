import { describe, expect, it } from "bun:test";
import { createSettingsSelectorController, type SettingsRuntimeContext } from "../src/overlays/settings-selector";
import type { PluginSettingsHost } from "../src/overlays/plugin-settings";

function context(): SettingsRuntimeContext {
	const values: Record<string, unknown> = { "ui.compact": false, "ui.name": "Pi" };
	const plugins: PluginSettingsHost = {
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
	return {
		settings: {
			entries: [
				{
					path: "ui.compact",
					type: "boolean",
					defaultValue: false,
					ui: { tab: "appearance", label: "Compact", description: "Use compact layout" },
				},
				{
					path: "ui.name",
					type: "string",
					defaultValue: "Pi",
					ui: { tab: "appearance", label: "Name", description: "Display name" },
				},
			],
			get(path) {
				return values[path];
			},
			set(path, value) {
				values[path] = value;
			},
			normalizeProviderLimits() {
				return {};
			},
			validateProviderLimits() {
				return {};
			},
		},
		plugins,
		availableThinkingLevels: [],
		thinkingLevel: undefined,
		availableThemes: [],
		providers: [],
	};
}

describe("settings selector controller", () => {
	it("cycles a boolean setting when Enter arrives as LF", () => {
		const changed: unknown[] = [];
		const controller = createSettingsSelectorController(context(), {
			onChange(_path, value) {
				changed.push(value);
			},
			onCancel() {},
		});
		controller.handleInput("\n");
		expect(changed).toEqual([true]);
		controller.dispose();
	});

	it("exits global search before closing the selector", () => {
		let cancellations = 0;
		const controller = createSettingsSelectorController(context(), {
			onChange() {},
			onCancel() {
				cancellations++;
			},
		});
		controller.handleInput("name");
		expect(controller.query()).toBe("name");

		controller.handleInput("\x1b");
		expect(controller.query()).toBe("");
		expect(cancellations).toBe(0);

		controller.handleInput("\x1b");
		expect(cancellations).toBe(1);
		controller.dispose();
	});
});
