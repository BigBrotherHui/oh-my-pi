import { describe, expect, it } from "bun:test";
import {
	createPluginSettingsController,
	type InstalledPlugin,
	type InstalledPluginSummary,
	type PluginSettingsHost,
} from "../src/overlays/plugin-settings";

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function npmPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
	return {
		name: "npm-plugin",
		version: "1.0.0",
		enabled: true,
		enabledFeatures: null,
		manifest: {},
		...overrides,
	};
}

function marketplacePlugin(overrides: Partial<InstalledPluginSummary> = {}): InstalledPluginSummary {
	return {
		id: "market-plugin",
		scope: "user",
		entries: [
			{
				installPath: "/tmp/market-plugin",
				version: "1.0.0",
				installedAt: "2026-01-01",
				lastUpdated: "2026-01-02",
				enabled: true,
			},
		],
		...overrides,
	};
}

describe("plugin settings", () => {
	it("merges both registries, opens a selected detail view, and returns to the list", async () => {
		const plugin = npmPlugin();
		const marketplace = marketplacePlugin();
		let closed = 0;
		const host: PluginSettingsHost = {
			manager: {
				async list() {
					return [plugin];
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
						return [marketplace];
					},
					async setPluginEnabled() {},
				};
			},
			parsePluginId() {
				return null;
			},
		};
		const controller = createPluginSettingsController(host, {
			onClose() {
				closed++;
			},
		});

		await controller.refresh();
		expect(controller.entries().map(entry => entry.kind)).toEqual(["npm", "marketplace"]);
		controller.handleInput("\n");
		expect(controller.screen()).toBe("npm-detail");
		expect(controller.currentDetail()?.kind).toBe("npm");

		controller.handleInput("\x1b");
		expect(controller.screen()).toBe("list");
		controller.handleInput("\x1b");
		expect(closed).toBe(1);
	});

	it("keeps the available registry visible when the other registry fails", async () => {
		const plugin = npmPlugin();
		const host: PluginSettingsHost = {
			manager: {
				async list() {
					return [plugin];
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
				throw new Error("registry unavailable");
			},
			parsePluginId() {
				return null;
			},
		};
		const controller = createPluginSettingsController(host, { onClose() {} });

		await controller.refresh();
		expect(controller.entries()).toEqual([{ kind: "npm", plugin }]);
		expect(controller.error()).toContain("Failed to list marketplace plugins: registry unavailable");
	});

	it("persists feature and manifest controls using defaults, input editing, and enum selection", async () => {
		const featureWrites: string[][] = [];
		const settingWrites: Array<readonly [string, string, unknown]> = [];
		const configChanges: Array<readonly [string, string, unknown]> = [];
		let changed = 0;
		const plugin = npmPlugin({
			manifest: {
				features: {
					"default-feature": { default: true },
					"extra-feature": { default: false, description: "An optional feature" },
				},
				settings: {
					enabled: { type: "boolean", default: true },
					label: { type: "string", default: "initial", description: "A label" },
					limit: { type: "number", default: 2, min: 1, max: 10 },
					mode: { type: "enum", default: "safe", values: ["safe", "fast"] },
				},
			},
		});
		const host: PluginSettingsHost = {
			manager: {
				async list() {
					return [plugin];
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
				async setEnabledFeatures(_name, features) {
					featureWrites.push(features ?? []);
				},
				async setPluginSetting(name, key, value) {
					settingWrites.push([name, key, value]);
				},
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
		const controller = createPluginSettingsController(host, {
			onClose() {},
			onPluginsChanged() {
				changed++;
			},
			onConfigChange(pluginName, key, value) {
				configChanges.push([pluginName, key, value]);
			},
		});

		await controller.refresh();
		controller.handleInput("\n");
		await settle();

		controller.handleInput("\x1b[B");
		controller.handleInput("\x1b[B");
		controller.handleInput("\n");
		await settle();
		expect(featureWrites).toEqual([["default-feature", "extra-feature"]]);

		controller.handleInput("\x1b[B");
		controller.handleInput("\n");
		await settle();
		expect(settingWrites).toContainEqual(["npm-plugin", "enabled", false]);

		controller.handleInput("\x1b[B");
		controller.handleInput("\n");
		controller.handleInput("!");
		controller.handleInput("\n");
		await settle();
		expect(settingWrites).toContainEqual(["npm-plugin", "label", "initial!"]);

		controller.handleInput("\x1b[B");
		controller.handleInput("\x1b[B");
		controller.handleInput("\n");
		expect(controller.screen()).toBe("config-enum");
		controller.handleInput("\x1b[B");
		controller.handleInput("\n");
		await settle();
		expect(settingWrites).toContainEqual(["npm-plugin", "mode", "fast"]);
		expect(configChanges).toContainEqual(["npm-plugin", "label", "initial!"]);
		expect(configChanges).toContainEqual(["npm-plugin", "mode", "fast"]);
		expect(changed).toBe(4);
	});

	it("loads marketplace runtime settings by installation path and keeps scope on updates", async () => {
		const plugin = marketplacePlugin({ shadowedBy: "project" });
		const runtime = npmPlugin({
			name: "runtime-plugin",
			manifest: { settings: { token: { type: "string", secret: true, description: "Token" } } },
		});
		const marketplaceWrites: Array<readonly [string, boolean, "user" | "project" | undefined]> = [];
		const settingWrites: Array<readonly [string, string, unknown]> = [];
		const host: PluginSettingsHost = {
			manager: {
				async list() {
					return [];
				},
				async getPlugin(name, options) {
					expect(name).toBe("runtime-plugin");
					expect(options?.path).toBe("/tmp/market-plugin");
					return runtime;
				},
				async getPluginSettings(name) {
					expect(name).toBe("runtime-plugin");
					return { token: "saved-token" };
				},
				async setEnabled() {},
				async getEnabledFeatures() {
					return null;
				},
				async setEnabledFeatures() {},
				async setPluginSetting(name, key, value) {
					settingWrites.push([name, key, value]);
				},
			},
			async createMarketplaceManager() {
				return {
					async listInstalledPlugins() {
						return [plugin];
					},
					async setPluginEnabled(id, enabled, scope) {
						marketplaceWrites.push([id, enabled, scope]);
					},
				};
			},
			parsePluginId() {
				return { name: "runtime-plugin" };
			},
		};
		const controller = createPluginSettingsController(host, { onClose() {} });

		await controller.refresh();
		controller.handleInput("\n");
		await settle();
		expect(controller.currentDetail()?.kind).toBe("marketplace");

		controller.handleInput("\n");
		await settle();
		expect(marketplaceWrites).toEqual([["market-plugin", false, "user"]]);

		controller.handleInput("\x1b[B");
		controller.handleInput("\n");
		expect(controller.screen()).toBe("config-input");
		controller.handleInput("replacement-token");
		controller.handleInput("\n");
		await settle();
		expect(settingWrites).toEqual([["runtime-plugin", "token", "replacement-token"]]);
	});

	it("ignores late registry results after disposal", async () => {
		let resolvePlugins: ((plugins: InstalledPlugin[]) => void) | undefined;
		const listing = new Promise<InstalledPlugin[]>(resolve => {
			resolvePlugins = resolve;
		});
		const host: PluginSettingsHost = {
			manager: {
				list() {
					return listing;
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
		const controller = createPluginSettingsController(host, { onClose() {} });

		controller.dispose();
		resolvePlugins?.([npmPlugin()]);
		await settle();
		expect(controller.entries()).toEqual([]);
	});
});
