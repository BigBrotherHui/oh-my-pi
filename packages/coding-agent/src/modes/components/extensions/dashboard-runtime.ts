import type { Extension, ExtensionProvider } from "@oh-my-pi/pi-tui/overlays/extensions/types";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { parseRuleAgents, parseRuleConditionAndScope, type Rule, type RuleFrontmatter } from "../../../capability/rule";
import type { Settings } from "../../../config/settings";
import { getAllProvidersInfo, isForeignUserProvider, isUserSourceEnabled } from "../../../discovery";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import { setMcpServerEnabled } from "../../../mcp/config-writer";
import type { MCPManager } from "../../../mcp/manager";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL } from "../../../mcp/startup-events";
import type { EventBus } from "../../../utils/event-bus";
import { toolFileHeaderDescription } from "./inspector-runtime";
import { applyMcpToggleRuntime } from "./mcp-runtime";
import { loadAllExtensions, toggleProvider, toggleUserSource } from "./state-manager";

interface ExtensionDashboardRuntime {
	getDisabledExtensions(): string[];
	setDisabledExtensions(ids: string[]): void;
	getProviders(): ExtensionProvider[];
	loadExtensions(disabledIds: string[]): Promise<Extension[]>;
	toggleProvider(provider: string, enabled: boolean): void;
	toggleUserSource(provider: string, enabled: boolean): void;
	persistMcpToggle(name: string, enabled: boolean, sourcePath: string): Promise<void>;
	applyMcpToggle(name: string, enabled: boolean): Promise<void>;
	subscribeMcpChanges(onChange: (event: unknown) => void): Array<() => void>;
	mcpSource?: MCPManager;
	inspectorSource: {
		readToolHeader(path: string | undefined): string | undefined;
		parseRule(
			raw: RuleFrontmatter,
		): Pick<Rule, "condition" | "astCondition" | "scope"> & { agents: string[] | undefined };
	};
}

/** Bind the dashboard's display-only contract to the live application. */
export function createExtensionDashboardRuntime(options: {
	cwd: string;
	settings: Settings;
	mcpManager?: MCPManager;
	eventBus?: EventBus;
	onMcpToolsChanged?: (tools: CustomTool[]) => Promise<void> | void;
	browserMcpFilterEnabled?: () => boolean;
}): ExtensionDashboardRuntime {
	const { cwd, settings, mcpManager, eventBus, onMcpToolsChanged, browserMcpFilterEnabled } = options;
	return {
		getDisabledExtensions: () => settings.get("disabledExtensions") ?? [],
		setDisabledExtensions: (ids: string[]) => settings.set("disabledExtensions", ids),
		getProviders: () =>
			getAllProvidersInfo().map(provider => ({
				...provider,
				userSourceEnabled: isUserSourceEnabled(provider.id),
				foreignUserSource: isForeignUserProvider(provider.id),
			})),
		loadExtensions: (disabledIds: string[]) => loadAllExtensions(cwd, disabledIds),
		toggleProvider,
		toggleUserSource,
		async persistMcpToggle(name: string, enabled: boolean, sourcePath: string) {
			await setMcpServerEnabled({
				userPath: getMCPConfigPath("user", cwd),
				projectPath: getMCPConfigPath("project", cwd),
				sourcePath,
				name,
				enabled,
			});
		},
		applyMcpToggle: (name: string, enabled: boolean) =>
			applyMcpToggleRuntime({
				name,
				enabled,
				cwd,
				manager: mcpManager,
				session: onMcpToolsChanged ? { refreshMCPTools: onMcpToolsChanged } : undefined,
				discovery: {
					enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
					filterExa: true,
					filterBrowser: browserMcpFilterEnabled?.() ?? false,
				},
				onStatus: event => eventBus?.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event),
			}),
		subscribeMcpChanges(onChange: (event: unknown) => void) {
			const subscriptions: Array<() => void> = [];
			if (eventBus) subscriptions.push(eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, onChange));
			if (mcpManager)
				subscriptions.push(
					mcpManager.addNotificationListener(onChange),
					mcpManager.addConnectionStatusListener(onChange),
					mcpManager.addCatalogChangeListener(onChange),
				);
			return subscriptions;
		},
		mcpSource: mcpManager,
		inspectorSource: {
			readToolHeader: toolFileHeaderDescription,
			parseRule: (raw: RuleFrontmatter) => {
				const rule = parseRuleConditionAndScope(raw);
				return { ...rule, agents: parseRuleAgents(raw.agents) };
			},
		},
	};
}
