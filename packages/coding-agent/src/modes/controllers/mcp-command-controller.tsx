/**
 * MCP Command Controller
 *
 * Handles /mcp subcommands for managing MCP servers.
 */
import * as path from "node:path";
import { createSignal } from "@oh-my-pi/pi-tui/reactive";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import { clearCache as clearFsCache } from "../../capability/fs";
import type { SourceMeta } from "../../capability/types";
import { expandEnvVarsDeep } from "../../discovery/helpers";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	loadAllMCPConfigs,
	MCPManager,
	type OAuthEndpoints,
} from "../../mcp";
import { connectToServer, disconnectServer, listTools } from "../../mcp/client";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	updateMCPServer,
	validateServerName,
} from "../../mcp/config-writer";
import {
	lookupMcpOAuthCredentialForServer,
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredential,
	removeManagedMcpOAuthCredentials,
} from "../../mcp/oauth-credentials";
import { MCPOAuthFlow, type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "../../mcp/oauth-flow";
import {
	clearSmitheryApiKey,
	createSmitheryCliAuthSession,
	getSmitheryApiKey,
	getSmitheryLoginUrl,
	pollSmitheryCliAuthSession,
	type SmitheryCliPollResponse,
	saveSmitheryApiKey,
} from "../../mcp/smithery-auth";
import { SmitheryConnectError } from "../../mcp/smithery-connect";
import {
	SmitheryRegistryError,
	type SmitherySearchResult,
	searchSmitheryRegistry,
	toConfigName,
} from "../../mcp/smithery-registry";
import type {
	MCPAuthChallenge,
	MCPAuthConfig,
	MCPConfigFile,
	MCPServerConfig,
	MCPServerConnection,
} from "../../mcp/types";
import { copyToClipboard } from "../../utils/clipboard";
import { isTimeoutError } from "../../utils/fetch-timeout";
import { openPath } from "../../utils/open";
import { openMCPAddWizardOverlay } from "@oh-my-pi/pi-tui/overlays/mcp-add-wizard";
import { parseCommandArgs } from "../../utils/command-args";
import type { InteractiveModeContext } from "../types";
import {
	McpAddedView,
	McpHelpView,
	McpNoticeView,
	McpNotificationsView,
	McpPromptsView,
	McpResourcesView,
	McpServerListView,
	McpTestResultView,
	SmitheryBrowserLoginView,
} from "../components/mcp-command-views";
import { CommandNoticeView, McpAuthorizationView, McpConnectingView } from "../components/reactive-controller-views";
import { groupBySource, parseRemoveArgs, readScopeFlag } from "./command-controller-shared";

const MCP_MANUAL_INPUT_PROVIDER_ID = "mcp";
const MCP_MANUAL_LOGIN_TIP = "Headless? Paste the redirect URL or code with /login <value>.";
const MCP_TEST_ESCAPE_GRACE_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, onTimeout?: () => void): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => {
		onTimeout?.();
		reject(new Error(message));
	}, timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}
function raceAbortSignal<T>(promise: Promise<T>, signal: AbortSignal, createError: () => Error): Promise<T> {
	if (signal.aborted) return Promise.reject(createError());

	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => aborted.reject(createError());
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

type ActiveMCPOAuthFlow = {
	cancel: (reason: string) => void;
	completion: Promise<void>;
	complete: () => void;
};

type MCPOAuthFlowCoordinator = {
	active?: ActiveMCPOAuthFlow;
	transition: Promise<void>;
};

const mcpOAuthFlowCoordinators = new WeakMap<object, MCPOAuthFlowCoordinator>();
const MCP_OAUTH_SUPERSEDED_REASON = "MCP OAuth flow superseded by a new login";

/**
 * Serialize MCP OAuth ownership across slash-command controller instances.
 * Interactive mode creates a new controller for every command, while the
 * manual-input manager remains stable for the session and is therefore the
 * lifecycle key.
 */
async function claimMCPOAuthFlow(owner: object, cancel: (reason: string) => void): Promise<{ release: () => void }> {
	let coordinator = mcpOAuthFlowCoordinators.get(owner);
	if (!coordinator) {
		coordinator = { transition: Promise.resolve() };
		mcpOAuthFlowCoordinators.set(owner, coordinator);
	}

	const precedingTransition = coordinator.transition;
	const transition = Promise.withResolvers<void>();
	coordinator.transition = transition.promise;
	await precedingTransition;

	try {
		const active = coordinator.active;
		if (active) {
			active.cancel(MCP_OAUTH_SUPERSEDED_REASON);
			await active.completion;
		}

		const completion = Promise.withResolvers<void>();
		const flow: ActiveMCPOAuthFlow = {
			cancel,
			completion: completion.promise,
			complete: () => completion.resolve(),
		};
		coordinator.active = flow;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				if (coordinator.active === flow) coordinator.active = undefined;
				flow.complete();
			},
		};
	} finally {
		transition.resolve();
	}
}

/**
 * Outcome of {@link MCPCommandController}'s OAuth handler.
 *
 * `credentialId` is deterministic per server URL when the URL was supplied, so
 * every profile resolves its own credential row under the same id. Refresh
 * material (token URL, client id/secret) is embedded in the stored credential;
 * the returned `clientId` may be folded into `mcp.json` for pre-auth reuse.
 * DCR-issued client secrets stay embedded in the stored credential and are
 * deliberately not surfaced here, so they cannot leak into config files.
 */
interface OAuthFlowResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

/**
 * Thrown by {@link MCPCommandController}'s OAuth handler when the user (or a
 * caller-supplied {@link AbortSignal}) cancels the in-flight flow. Distinct
 * from network/timeout failures so callers can surface a neutral
 * "cancelled" status instead of an error banner.
 */
export class MCPOAuthCancelledError extends Error {
	constructor(message = "OAuth flow cancelled") {
		super(message);
		this.name = "MCPOAuthCancelledError";
	}
}

/** Reason recorded on the OAuth flow's AbortController when the user hits Esc. */
const MCP_OAUTH_USER_CANCEL_REASON = "MCP OAuth flow cancelled by user";

type MCPAddScope = "user" | "project";
type MCPAddTransport = "http" | "sse";

type MCPAddParsed = {
	initialName?: string;
	scope: MCPAddScope;
	quickConfig?: MCPServerConfig;
	isCommandQuickAdd?: boolean;
	hasAuthToken?: boolean;
	error?: string;
};

type MCPSearchParsed = {
	keyword: string;
	scope: MCPAddScope;
	limit: number;
	semantic: boolean;
	error?: string;
};

/**
 * Collect the de-duplicated union of every MCP server name we know about:
 * user config, project config, and any runtime-discovered servers not
 * already present in either config (`ctx.mcpManager.getAllServerNames()`
 * covers connections, pending connections, and discovered-but-not-yet-
 * connected sources).
 *
 * `includeDisabledOnly` controls names found only in
 * `userConfig.disabledServers`, while `includeDisabledConfigured` controls
 * config entries whose `enabled` flag is false. Both default to true because
 * callers such as `/mcp list` need the complete union. Autocomplete callers
 * must disable the categories their target operation cannot accept.
 *
 * This is the single source of truth for "every known server name": both
 * `MCPCommandController#handleList()` and the `/mcp` slash-command argument
 * completer (server-name autocomplete for `enable`/`disable`/`test`/etc.)
 * call this instead of re-deriving the union themselves.
 *
 * `preloaded` lets a caller that already read both config files (e.g.
 * `#handleList()`) pass them in and skip the redundant re-read.
 */
export async function collectMcpServerNames(
	ctx: InteractiveModeContext,
	preloaded?: { userConfig: MCPConfigFile; projectConfig: MCPConfigFile },
	includeDisabledOnly = true,
	includeDisabledConfigured = true,
): Promise<string[]> {
	let userConfig: MCPConfigFile;
	let projectConfig: MCPConfigFile;
	if (preloaded) {
		({ userConfig, projectConfig } = preloaded);
	} else {
		const cwd = getProjectDir();
		[userConfig, projectConfig] = await Promise.all([
			readMCPConfigFile(getMCPConfigPath("user", cwd)),
			readMCPConfigFile(getMCPConfigPath("project", cwd)),
		]);
	}

	const names = new Set<string>(includeDisabledOnly ? (userConfig.disabledServers ?? []) : []);
	const addConfiguredNames = (config: MCPConfigFile): void => {
		const servers = config.mcpServers;
		if (!servers) return;
		for (const name in servers) {
			const server = servers[name];
			if (server && (includeDisabledConfigured || server.enabled !== false)) names.add(name);
		}
	};
	addConfiguredNames(userConfig);
	addConfiguredNames(projectConfig);
	if (ctx.mcpManager) {
		for (const name of ctx.mcpManager.getAllServerNames()) {
			names.add(name);
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export class MCPCommandController {
	constructor(private ctx: InteractiveModeContext) {}

	/**
	 * Handle /mcp command and route to subcommands
	 */
	async handle(text: string): Promise<void> {
		const parts = parseCommandArgs(text.trim());
		const subcommand = parts[1]?.toLowerCase();
		const serverName = parts.slice(2).join(" ") || undefined;

		if (!subcommand || subcommand === "help") {
			this.#showHelp();
			return;
		}

		switch (subcommand) {
			case "add":
				await this.#handleAdd(text);
				break;
			case "list":
				await this.#handleList();
				break;
			case "remove":
			case "rm":
				await this.#handleRemove(text);
				break;
			case "test":
				await this.#handleTest(serverName);
				break;
			case "reauth":
				await this.#handleReauth(serverName);
				break;
			case "unauth":
				await this.#handleUnauth(serverName);
				break;
			case "enable":
				await this.#handleSetEnabled(serverName, true);
				break;
			case "disable":
				await this.#handleSetEnabled(serverName, false);
				break;
			case "resources":
				await this.#handleResources();
				break;
			case "prompts":
				await this.#handlePrompts();
				break;
			case "notifications":
				await this.#handleNotifications();
				break;
			case "smithery-search":
				await this.#handleSearch(text);
				break;
			case "smithery-login":
				await this.#handleSmitheryLogin();
				break;
			case "smithery-logout":
				await this.#handleSmitheryLogout();
				break;
			case "reconnect":
				await this.#handleReconnect(serverName);
				break;
			case "reload":
				await this.#handleReload();
				break;
			default:
				this.ctx.showError(`Unknown subcommand: ${subcommand}. Type /mcp help for usage.`);
		}
	}

	/**
	 * Show help text
	 */
	#showHelp(): void {
		this.ctx.presentCommandOutput(McpHelpView());
	}

	#parseAddCommand(text: string): MCPAddParsed {
		const prefixMatch = text.match(/^\/mcp\s+add\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		if (!rest) {
			return { scope: "project" };
		}

		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			return { scope: "project" };
		}

		let name: string | undefined;
		let scope: MCPAddScope = "project";
		let url: string | undefined;
		let transport: MCPAddTransport = "http";
		let authToken: string | undefined;
		let commandTokens: string[] | undefined;

		let i = 0;
		if (!tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}

		while (i < tokens.length) {
			const argToken = tokens[i];
			if (argToken === "--") {
				commandTokens = tokens.slice(i + 1);
				break;
			}
			if (argToken === "--scope") {
				const r = readScopeFlag(tokens[i + 1]);
				if (!r.ok) {
					return { scope, error: r.error };
				}
				scope = r.scope;
				i += 2;
				continue;
			}
			if (argToken === "--url") {
				const value = tokens[i + 1];
				if (!value) {
					return { scope, error: "Missing value for --url." };
				}
				url = value;
				i += 2;
				continue;
			}
			if (argToken === "--transport") {
				const value = tokens[i + 1];
				if (!value || (value !== "http" && value !== "sse")) {
					return { scope, error: "Invalid --transport value. Use http or sse." };
				}
				transport = value;
				i += 2;
				continue;
			}
			if (argToken === "--token") {
				const value = tokens[i + 1];
				if (!value) {
					return { scope, error: "Missing value for --token." };
				}
				authToken = value;
				i += 2;
				continue;
			}
			return { scope, error: `Unknown option: ${argToken}` };
		}

		const hasQuick = Boolean(url) || Boolean(commandTokens && commandTokens.length > 0);
		if (!hasQuick) {
			return { scope, initialName: name };
		}
		if (!name) {
			return { scope, error: "Server name required for quick add. Usage: /mcp add <name> ..." };
		}
		if (url && commandTokens && commandTokens.length > 0) {
			return { scope, error: "Use either --url or -- <command...>, not both." };
		}
		if (authToken && !url) {
			return { scope, error: "--token requires --url (HTTP/SSE transport)." };
		}

		if (commandTokens && commandTokens.length > 0) {
			const [command, ...args] = commandTokens;
			const config: MCPServerConfig = {
				type: "stdio",
				command,
				args: args.length > 0 ? args : undefined,
			};
			return { scope, initialName: name, quickConfig: config, isCommandQuickAdd: true };
		}

		const useHttpTransport = transport === "http";
		let normalizedUrl = url!;
		if (!/^https?:\/\//i.test(normalizedUrl)) {
			normalizedUrl = `https://${normalizedUrl}`;
		}
		const config: MCPServerConfig = {
			type: useHttpTransport ? "http" : "sse",
			url: normalizedUrl,
			headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
		};
		return {
			scope,
			initialName: name,
			quickConfig: config,
			isCommandQuickAdd: false,
			hasAuthToken: Boolean(authToken),
		};
	}

	#parseSearchCommand(text: string): MCPSearchParsed {
		const prefixMatch = text.match(/^\/mcp\s+smithery-search\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			return {
				keyword: "",
				scope: "project",
				limit: 20,
				semantic: false,
				error: "Keyword required. Usage: /mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			};
		}

		const keywordParts: string[] = [];
		let scope: MCPAddScope = "project";
		let limit = 20;
		let semantic = false;

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token === "--scope") {
				const value = tokens[i + 1];
				if (!value || (value !== "project" && value !== "user")) {
					return { keyword: "", scope, limit, semantic, error: "Invalid --scope value. Use project or user." };
				}
				scope = value;
				i++;
				continue;
			}
			if (token === "--limit") {
				const value = tokens[i + 1];
				if (!value) {
					return { keyword: "", scope, limit, semantic, error: "Missing value for --limit." };
				}
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
					return {
						keyword: "",
						scope,
						limit,
						semantic,
						error: "Invalid --limit value. Use an integer between 1 and 100.",
					};
				}
				limit = parsed;
				i++;
				continue;
			}
			if (token === "--semantic") {
				semantic = true;
				continue;
			}
			if (token.startsWith("--")) {
				return { keyword: "", scope, limit, semantic, error: `Unknown option: ${token}` };
			}
			keywordParts.push(token);
		}

		const keyword = keywordParts.join(" ").trim();
		if (!keyword) {
			return {
				keyword: "",
				scope,
				limit,
				semantic,
				error: "Keyword required. Usage: /mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			};
		}

		return { keyword, scope, limit, semantic };
	}

	/**
	 * Handle /mcp add - Launch interactive wizard or quick-add from args
	 */
	async #handleAdd(text: string): Promise<void> {
		const parsed = this.#parseAddCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}
		if (parsed.quickConfig && parsed.initialName) {
			let finalConfig = parsed.quickConfig;

			// Quick-add with URL should still perform auth detection and OAuth flow,
			// matching wizard behavior. Command quick-add intentionally skips this.
			if (!parsed.isCommandQuickAdd && (finalConfig.type === "http" || finalConfig.type === "sse")) {
				try {
					await this.#handleTestConnection(finalConfig);
				} catch (error) {
					if (parsed.hasAuthToken) {
						this.ctx.showError(
							`Authentication failed for "${parsed.initialName}": ${error instanceof Error ? error.message : String(error)}`,
						);
						return;
					}
					const authResult = analyzeAuthError(error as Error, finalConfig.url);
					if (authResult.requiresAuth) {
						let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
						if (!oauth && finalConfig.url) {
							try {
								oauth = await discoverOAuthEndpoints(
									finalConfig.url,
									authResult.authServerUrl,
									authResult.resourceMetadataUrl,
									{ protectedScopes: authResult.scopes },
								);
							} catch {
								// Ignore discovery error and handle below.
							}
						}
						if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
							// JSON-error-body path skips `discoverOAuthEndpoints`; fetch the
							// advertised protected-resource metadata for the required scopes.
							const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
							if (scopes) oauth = { ...oauth, scopes };
						}

						if (!oauth) {
							this.ctx.showError(
								`Authentication required for "${parsed.initialName}", but OAuth endpoints could not be discovered. ` +
									`Use /mcp add ${parsed.initialName} (wizard) or configure auth manually.`,
							);
							return;
						}

						try {
							const oauthResource = oauth.resource ?? finalConfig.url;
							const oauthResourceIsFallback = !oauth.resource;
							const oauthResult = await this.#handleOAuthFlow(
								oauth.authorizationUrl,
								oauth.tokenUrl,
								oauth.clientId ?? finalConfig.oauth?.clientId ?? "",
								finalConfig.oauth?.clientSecret ?? "",
								oauth.scopes ?? "",
								{
									callbackPort: finalConfig.oauth?.callbackPort,
									callbackPath: finalConfig.oauth?.callbackPath,
									redirectUri: finalConfig.oauth?.redirectUri,
									prompt: finalConfig.oauth?.prompt,
									registrationUrl: oauth.registrationUrl,
									issuerUrl: oauth.issuerUrl,
									serverUrl: finalConfig.url,
									resource: oauthResource,
									stripSameOriginResource: oauthResourceIsFallback,
								},
							);
							finalConfig = this.#persistOAuthResult(finalConfig, oauthResult, {
								tokenUrl: oauth.tokenUrl,
								resource: oauthResource,
								stripSameOriginResource: oauthResourceIsFallback,
								clientId: oauth.clientId,
								userClientSecret: finalConfig.oauth?.clientSecret,
							});
						} catch (oauthError) {
							if (oauthError instanceof MCPOAuthCancelledError) {
								this.ctx.showStatus(`Add cancelled for "${parsed.initialName}"`);
								return;
							}
							this.ctx.showError(
								`OAuth flow failed for "${parsed.initialName}": ${oauthError instanceof Error ? oauthError.message : String(oauthError)}`,
							);
							return;
						}
					}
				}
			}

			await this.#handleWizardComplete(parsed.initialName, finalConfig, parsed.scope);
			return;
		}

		const closeWizard = (): void => {
			wizard.dispose();
		};
		const wizard = openMCPAddWizardOverlay(this.ctx.ui, {
			deps: { validateServerName, analyzeAuthError, discoverOAuthEndpoints, fetchResourceMetadataScopes },
			callbacks: {
				onComplete: (name, config, scope) => {
					closeWizard();
					void this.#handleWizardComplete(name, config, scope);
				},
				onCancel: () => {
					closeWizard();
					this.#handleWizardCancel();
				},
				onOAuth: (authUrl, tokenUrl, clientId, clientSecret, scopes, options) =>
					this.#handleOAuthFlow(authUrl, tokenUrl, clientId, clientSecret, scopes, options),
				onTestConnection: config => this.#handleTestConnection(config),
			},
			initialName: parsed.initialName,
		});
	}

	/**
	 * Handle OAuth authentication flow for MCP server
	 */
	async #handleOAuthFlow(
		authUrl: string,
		tokenUrl: string,
		clientId: string,
		clientSecret: string,
		scopes: string,
		opts?: {
			callbackPort?: number;
			callbackPath?: string;
			redirectUri?: string;
			prompt?: string;
			serverUrl?: string;
			registrationUrl?: string;
			issuerUrl?: string;
			resource?: string;
			stripSameOriginResource?: boolean;
			/**
			 * External cancellation source: when this signal aborts, the in-flight
			 * OAuth flow is torn down and {@link MCPOAuthCancelledError} is thrown.
			 * Wizards (which own focus and absorb Esc themselves) pass their own
			 * controller here; editor-focused callers rely on the Esc hook
			 * installed below instead.
			 */
			abortSignal?: AbortSignal;
		},
	): Promise<OAuthFlowResult> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		let parsedAuthUrl: URL;

		// Validate OAuth URLs
		try {
			parsedAuthUrl = new URL(authUrl);
			new URL(tokenUrl);
		} catch {
			throw new Error(
				`Invalid OAuth URLs. Please check:\n  Authorization URL: ${authUrl}\n  Token URL: ${tokenUrl}`,
			);
		}

		const resolvedClientId = clientId.trim() || parsedAuthUrl.searchParams.get("client_id")?.trim() || undefined;
		const resolvedClientSecret = clientSecret.trim() || undefined;

		const manualInput = this.ctx.oauthManualInput;
		let manualInputClaim: { promise: Promise<string>; clear: (reason?: string) => void } | undefined;
		const oauthTimeout = new AbortController();
		// Esc, external aborts, and a replacement MCP flow route through here;
		// the timeout path sets its own reason and leaves this flag false so the
		// catch can distinguish cancellation (status) from deadline failure.
		let cancellationRequested = false;
		const requestCancellation = (reason: string): void => {
			cancellationRequested = true;
			if (!oauthTimeout.signal.aborted) oauthTimeout.abort(reason);
		};
		const flowClaim = await claimMCPOAuthFlow(manualInput, requestCancellation);
		const originalOnEscape = this.ctx.editor.onEscape;
		this.ctx.editor.onEscape = () => requestCancellation(MCP_OAUTH_USER_CANCEL_REASON);
		const externalSignal = opts?.abortSignal;
		const onExternalAbort = (): void => {
			const reason = externalSignal?.reason;
			requestCancellation(typeof reason === "string" ? reason : MCP_OAUTH_USER_CANCEL_REASON);
		};
		if (externalSignal?.aborted) {
			onExternalAbort();
		} else {
			externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
		}
		try {
			if (manualInput.hasPending()) {
				const pendingProvider = manualInput.pendingProviderId ?? "another provider";
				throw new Error(
					`OAuth login already in progress for ${pendingProvider}. Complete or cancel it before starting MCP OAuth.`,
				);
			}
			// Create OAuth flow
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: authUrl,
					tokenUrl: tokenUrl,
					registrationUrl: opts?.registrationUrl,
					issuerUrl: opts?.issuerUrl,
					clientId: resolvedClientId,
					clientSecret: resolvedClientSecret,
					scopes: scopes || undefined,
					prompt: opts?.prompt,
					redirectUri: opts?.redirectUri,
					callbackPort: opts?.callbackPort,
					callbackPath: opts?.callbackPath,
					resource: opts?.resource,
					stripSameOriginResource: opts?.stripSameOriginResource,
				},
				{
					onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
						openPath(info.url);
						void copyToClipboard(info.url).catch(() => {});
						this.ctx.present(
							McpAuthorizationView({
								url: info.url,
								launchUrl: info.launchUrl,
								manualLoginTip: MCP_MANUAL_LOGIN_TIP,
							}),
						);
					},
					onProgress: (message: string) => {
						this.ctx.present(CommandNoticeView({ text: message, color: "muted" }));
					},
					onManualCodeInput: signal => {
						if (manualInputClaim) return manualInputClaim.promise;
						const pendingInput = manualInput.tryClaimInput(MCP_MANUAL_INPUT_PROVIDER_ID);
						if (!pendingInput) {
							const pendingProvider = manualInput.pendingProviderId ?? "another provider";
							throw new Error(
								`OAuth login already in progress for ${pendingProvider}. Complete or cancel it before starting MCP OAuth.`,
							);
						}
						const onAbort = () => pendingInput.clear("Manual MCP OAuth input cancelled");
						if (signal?.aborted) onAbort();
						else signal?.addEventListener("abort", onAbort, { once: true });
						const claim = {
							clear: pendingInput.clear,
							promise: pendingInput.promise.finally(() => {
								signal?.removeEventListener("abort", onAbort);
								if (manualInputClaim === claim) manualInputClaim = undefined;
							}),
						};
						manualInputClaim = claim;
						return claim.promise;
					},
					signal: oauthTimeout.signal,
				},
			);

			const createAbortError = (): Error => {
				const reason = String(oauthTimeout.signal.reason ?? "MCP OAuth flow aborted");
				return cancellationRequested ? new MCPOAuthCancelledError() : new Error(reason);
			};
			if (oauthTimeout.signal.aborted) throw createAbortError();

			// Execute OAuth flow with 5 minute timeout. Race the login itself
			// against the abort signal because Esc/external abort may fire before
			// MCPOAuthFlow reaches OAuthCallbackFlow.#waitForCallback, where the
			// underlying callback server normally observes the signal.
			const credentials = await withTimeout(
				raceAbortSignal(flow.login(), oauthTimeout.signal, createAbortError),
				5 * 60 * 1000,
				"OAuth flow timed out after 5 minutes",
				() => oauthTimeout.abort("MCP OAuth flow timed out"),
			);

			this.ctx.present(CommandNoticeView({ text: "✓ Authorization completed in browser.", color: "success" }));

			// Deterministic per-URL id: every profile resolves its own credential row
			// under the same key, so shared project configs stay profile-isolated.
			// Random fallback only for flows that never knew the server URL.
			const credentialId = opts?.serverUrl
				? mcpOAuthCredentialId(opts.serverUrl)
				: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

			// Embed refresh material so the credential is self-contained: token
			// refresh must work for configs that carry no auth block at all.
			const oauthCredential: MCPStoredOAuthCredential = {
				type: "oauth",
				...credentials,
				tokenUrl,
				clientId: flow.resolvedClientId?.trim() || resolvedClientId,
				clientSecret: flow.registeredClientSecret ?? resolvedClientSecret,
				resource: flow.resource,
				authorizationUrl: flow.authorizationUrl,
			};

			await authStorage.set(credentialId, oauthCredential);

			return {
				credentialId,
				clientId: flow.resolvedClientId,
				resource: flow.resource,
			};
		} catch (error) {
			// Esc, an external abort, or a newer MCP flow are neutral
			// cancellations. The timeout path also aborts the controller but does
			// not set this flag, so it remains a surfaced error.
			if (cancellationRequested) {
				throw new MCPOAuthCancelledError();
			}

			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages based on failure type
			if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
				throw new Error("OAuth flow timed out. Please try again.");
			} else if (errorMsg.includes("403") || errorMsg.includes("unauthorized")) {
				throw new Error("OAuth authorization failed. Please check your client credentials.");
			} else if (errorMsg.includes("invalid_grant")) {
				throw new Error("OAuth authorization code is invalid or expired. Please try again.");
			} else if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("fetch failed")) {
				throw new Error("Could not connect to OAuth server. Please check the URLs and your network connection.");
			} else {
				throw new Error(`OAuth authentication failed: ${errorMsg}`);
			}
		} finally {
			this.ctx.editor.onEscape = originalOnEscape;
			externalSignal?.removeEventListener("abort", onExternalAbort);
			manualInputClaim?.clear("Manual MCP OAuth input cleared");
			flowClaim.release();
		}
	}

	/**
	 * Fold a completed OAuth flow back into a server config. Owns the
	 * persistence policy in one place: the auth block records the credential
	 * pointer plus refresh material, the oauth block echoes the client id for
	 * pre-auth reuse, and only a user-supplied client secret is ever written —
	 * DCR-issued secrets stay embedded in the stored credential so they cannot
	 * leak into (possibly shared/committed) config files.
	 */
	#persistOAuthResult(
		config: MCPServerConfig,
		result: OAuthFlowResult,
		opts: {
			tokenUrl: string;
			resource?: string;
			stripSameOriginResource?: boolean;
			clientId?: string;
			persistOAuthClientId?: boolean;
			userClientSecret?: string;
		},
	): MCPServerConfig {
		const clientId = result.clientId?.trim() || opts.clientId?.trim() || config.oauth?.clientId?.trim();
		const oauthClientId = opts.persistOAuthClientId === false ? undefined : clientId;
		const resource =
			result.resource ?? (opts.stripSameOriginResource ? undefined : opts.resource) ?? config.auth?.resource;
		return {
			...config,
			auth: {
				type: "oauth",
				credentialId: result.credentialId,
				tokenUrl: opts.tokenUrl,
				clientId,
				clientSecret: opts.userClientSecret,
				resource,
			},
			oauth: {
				...config.oauth,
				clientId: oauthClientId,
			},
		};
	}

	/**
	 * Test connection to an MCP server.
	 * Throws an error if connection fails (used for auto-detection).
	 */
	async #handleTestConnection(config: MCPServerConfig, options?: { oauth?: boolean }): Promise<void> {
		// Create temporary connection using a test name
		const testName = `test_${Date.now()}`;
		let resolvedConfig: MCPServerConfig;
		if (this.ctx.mcpManager) {
			resolvedConfig = await this.ctx.mcpManager.prepareConfig(config, options);
		} else {
			const tempManager = new MCPManager(getProjectDir());
			tempManager.setAuthStorage(this.ctx.session.modelRegistry.authStorage);
			resolvedConfig = await tempManager.prepareConfig(config, options);
		}

		const connection = await connectToServer(testName, resolvedConfig);
		await disconnectServer(connection);
	}

	async #findConfiguredServer(
		name: string,
	): Promise<{ filePath: string; scope: "user" | "project"; config: MCPServerConfig } | null> {
		const cwd = getProjectDir();
		const userPath = getMCPConfigPath("user", cwd);
		const projectPath = getMCPConfigPath("project", cwd);

		const [userConfig, projectConfig] = await Promise.all([
			readMCPConfigFile(userPath),
			readMCPConfigFile(projectPath),
		]);

		if (userConfig.mcpServers?.[name]) {
			return { filePath: userPath, scope: "user", config: userConfig.mcpServers[name] };
		}
		if (projectConfig.mcpServers?.[name]) {
			return { filePath: projectPath, scope: "project", config: projectConfig.mcpServers[name] };
		}

		// Check standalone fallback files (mcp.json, .mcp.json) in the project root —
		// these match the discovery paths used by the mcp-json provider. Reads run in
		// parallel (mirroring user/project above) but precedence is preserved by the
		// for-loop's iteration order: mcp.json wins over .mcp.json on a same-name hit.
		const standalonePaths = [path.join(cwd, "mcp.json"), path.join(cwd, ".mcp.json")];
		const fallbackConfigs = await Promise.all(
			standalonePaths.map(async fallbackPath => {
				try {
					return await readMCPConfigFile(fallbackPath);
				} catch {
					// Malformed JSON in a standalone file — skip and continue lookup.
					return null;
				}
			}),
		);
		for (const [index, fallbackConfig] of fallbackConfigs.entries()) {
			const config = fallbackConfig?.mcpServers?.[name];
			if (config) {
				return { filePath: standalonePaths[index]!, scope: "project", config };
			}
		}
		return null;
	}

	/**
	 * Resolve a server for an auth/test operation.
	 *
	 * Unlike {@link #findConfiguredServer} (which only reads writable OMP config
	 * files), this also recognizes runtime-discovered servers that `/mcp list`
	 * surfaces but that live in no writable config — e.g. servers from a Claude
	 * Code marketplace plugin (`cloudflare:cloudflare-api`), `.cursor/mcp.json`,
	 * etc. Without this, `/mcp reauth|test|unauth` reports "not found" for a
	 * server the list just showed.
	 *
	 * For a discovered server, any persisted change is written into the *user*
	 * config under the same (namespaced) name; the native provider (priority 100)
	 * shadows the discovered entry on the next reload, so an OAuth `auth` block
	 * persisted by `/mcp reauth` takes effect. `discovered` lets callers tailor
	 * messaging and skip pointless writes when there is nothing to persist.
	 */
	async #resolveServerForAuth(name: string): Promise<{
		filePath: string;
		scope: "user" | "project";
		config: MCPServerConfig;
		discovered: boolean;
	} | null> {
		const found = await this.#findConfiguredServer(name);
		if (found) return { ...found, discovered: false };

		const config = this.ctx.mcpManager?.getServerConfig(name);
		const source = this.ctx.mcpManager?.getSource(name);
		if (!config || !source) return null;

		return {
			filePath: getMCPConfigPath("user", getProjectDir()),
			scope: "user",
			config,
			discovered: true,
		};
	}

	#stripOAuthAuth(config: MCPServerConfig): MCPServerConfig {
		const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
		delete next.auth;
		return next;
	}

	async #resolveOAuthEndpointsFromServer(
		config: MCPServerConfig,
		authChallenge?: MCPAuthChallenge,
	): Promise<OAuthEndpoints> {
		// Stdio servers manage credentials inside the child process; OMP's OAuth
		// flow only applies to http/sse transports. Without this guard the
		// unauthenticated preflight below spawns the child, which happily reuses
		// its own cached tokens (e.g. mcp-remote's machine-wide ~/.mcp-auth) and
		// produces the misleading "reauthorization is not required".
		if (config.type !== "http" && config.type !== "sse") {
			const remoteUrl = config.args?.find(arg => /^https?:\/\//.test(arg));
			const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
			const usesMcpRemote = [config.command, ...(config.args ?? [])].some(part => part?.includes("mcp-remote"));
			throw new Error(
				usesMcpRemote
					? `this server proxies OAuth through mcp-remote, which caches tokens machine-wide in ~/.mcp-auth (shared across every OMP profile). Clear ~/.mcp-auth to force a fresh login, or replace the proxy with ${httpHint} so OMP manages OAuth per profile.`
					: `stdio servers manage their own credentials, so OMP has no OAuth to reauthorize. If the service supports OAuth over HTTP, configure it as ${httpHint} instead.`,
			);
		}
		// First test if server actually needs auth by connecting without OAuth
		let connectionSucceeded = false;
		let connectionError: Error | undefined;
		try {
			await this.#handleTestConnection(this.#stripOAuthAuth(config), { oauth: false });
			connectionSucceeded = true;
		} catch (error) {
			connectionError = error as Error;
		}

		// Server connected fine without auth. A tool-level challenge overrides
		// this: servers may allow the anonymous handshake yet protect individual
		// tool calls with `_meta["mcp/www_authenticate"]`. Even without such a
		// challenge, a clean `initialize` is only weak evidence — per the MCP
		// spec a server MAY permit unauthenticated `initialize` while requiring a
		// bearer token for `tools/call`. The user explicitly asked to reauth, so
		// honor it when the server advertises OAuth discovery metadata; only
		// refuse when there is genuinely no OAuth endpoint to acquire.
		if (connectionSucceeded && !authChallenge) {
			const discovered = "url" in config && config.url ? await discoverOAuthEndpoints(config.url) : null;
			if (!discovered) {
				throw new Error("Server connection succeeded without OAuth; reauthorization is not required.");
			}
			return discovered;
		}

		// Tool calls can carry richer RFC 6750/RFC 9728 hints than the original
		// connection error. Feed those hints through the same analyzer so
		// resource_metadata and scope reach protected-resource discovery.
		const authError = authChallenge
			? new Error(`${connectionError?.message ?? "HTTP 401"}\n${authChallenge.wwwAuthenticate.join("\n")}`)
			: connectionError!;
		const authResult = analyzeAuthError(authError, "url" in config ? config.url : undefined);
		let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;

		if (!oauth && (config.type === "http" || config.type === "sse") && config.url) {
			oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl, authResult.resourceMetadataUrl, {
				protectedScopes: authResult.scopes,
			});
		}
		if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
			// JSON-error-body path skips `discoverOAuthEndpoints`; fetch the
			// advertised protected-resource metadata for the required scopes.
			const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
			if (scopes) oauth = { ...oauth, scopes };
		}

		if (!oauth) {
			throw new Error("Could not discover OAuth endpoints from server response.");
		}

		return oauth;
	}

	async #waitForServerConnectionWithAnimation(
		name: string,
		options?: { suppressDisconnectedWarning?: boolean },
	): Promise<"connected" | "connecting" | "disconnected"> {
		if (!this.ctx.mcpManager) return "disconnected";

		const [status, setStatus] = createSignal<string | undefined>();
		const entryId = `mcp:connecting:${name}:${Date.now()}`;
		this.ctx.chatContainer.append({
			id: entryId,
			state: "active",
			view: () => McpConnectingView({ serverName: name, status: status() }),
		});

		try {
			try {
				await withTimeout(this.ctx.mcpManager.waitForConnection(name), 10_000, "Connection still pending");
			} catch {
				// Ignore timeout/errors here and use status check below.
			}
			const state = this.ctx.mcpManager.getConnectionStatus(name);
			if (state === "connected") {
				// Connection may complete after initial reload; rebind runtime MCP tools now.
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			}
			if (state === "connected") {
				setStatus(`Connected to "${name}"`);
			} else if (state === "connecting") {
				setStatus(`"${name}" is still connecting…`);
			} else {
				setStatus(
					options?.suppressDisconnectedWarning
						? `Connection check complete for "${name}"`
						: `Could not connect to "${name}" yet`,
				);
			}
			return state;
		} finally {
			this.ctx.chatContainer.replace(entryId, { state: "settled" });
		}
	}

	async #syncManagerConnection(name: string, config: MCPServerConfig): Promise<void> {
		if (!this.ctx.mcpManager) return;
		if (this.ctx.mcpManager.getConnectionStatus(name) !== "disconnected") return;
		await this.ctx.mcpManager.connectServers({ [name]: config }, {});
		if (this.ctx.mcpManager.getConnectionStatus(name) === "connected") {
			await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
		}
	}

	async #handleWizardComplete(name: string, config: MCPServerConfig, scope: "user" | "project"): Promise<void> {
		try {
			// Determine file path
			const cwd = getProjectDir();
			const filePath = getMCPConfigPath(scope, cwd);

			// Add server to config
			await addMCPServer(filePath, name, config);

			// Reload MCP manager
			await this.reloadServers();
			const state =
				config.enabled === false
					? "disconnected"
					: await this.#waitForServerConnectionWithAnimation(name, { suppressDisconnectedWarning: true });
			let isConnected = state === "connected";
			const isConnecting = state === "connecting";

			// Fallback: if manager state is still disconnected but direct test works,
			// report as connected to avoid false-negative messaging.
			if (!isConnected && !isConnecting && config.enabled !== false) {
				try {
					await this.#handleTestConnection(config);
					isConnected = true;
					await this.#syncManagerConnection(name, config);
				} catch {
					// Keep disconnected status
				}
			}

			// refreshMCPTools preserves the prior MCP tool selection, so tools from
			// brand-new servers are registered in the registry but never activated.
			// Explicitly activate the newly added server's tools now.
			if (isConnected && this.ctx.mcpManager) {
				const serverTools = this.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
				if (serverTools.length > 0) {
					const currentActive = this.ctx.session.getEnabledToolNames();
					const toActivate = serverTools.map(t => t.name).filter(n => this.ctx.session.getToolByName(n));
					if (toActivate.length > 0) {
						await this.ctx.session.setActiveToolsByName([...new Set([...currentActive, ...toActivate])]);
					}
				}
			}

			this.ctx.presentCommandOutput(
				McpAddedView({
					name,
					scope,
					state: isConnected ? "connected" : isConnecting ? "connecting" : "disconnected",
				}),
			);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages
			let helpText = "";
			if (errorMsg.includes("EACCES") || errorMsg.includes("permission denied")) {
				helpText = "\n\nTip: Check file permissions for the config directory.";
			} else if (errorMsg.includes("ENOSPC")) {
				helpText = "\n\nTip: Insufficient disk space.";
			} else if (errorMsg.includes("already exists")) {
				helpText = "\n\nTip: Use /mcp list to see existing servers.";
			}

			this.ctx.showError(`Failed to add server: ${errorMsg}${helpText}`);
		}
	}

	#handleWizardCancel(): void {
		this.ctx.presentCommandOutput(
			McpNoticeView({
				text: "Server creation cancelled.",
				detail: "Tip: Press Ctrl+C or Esc anytime to cancel.",
			}),
		);
	}

	/**
	 * Handle /mcp list - Show all configured servers
	 */
	async #handleList(): Promise<void> {
		try {
			const cwd = getProjectDir();

			// Load from both user and project configs
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);

			const [userConfig, projectConfig] = await Promise.all([
				readMCPConfigFile(userPath),
				readMCPConfigFile(projectPath),
			]);

			const userServers = Object.keys(userConfig.mcpServers ?? {});
			const projectServers = Object.keys(projectConfig.mcpServers ?? {});

			// Collect runtime-discovered servers not in config files
			const configServerNames = new Set([...userServers, ...projectServers]);
			const disabledServerNames = new Set(userConfig.disabledServers ?? []);
			const discoveredServers: { name: string; source: SourceMeta }[] = [];
			if (this.ctx.mcpManager) {
				const allServerNames = await collectMcpServerNames(this.ctx, { userConfig, projectConfig });
				for (const name of allServerNames) {
					if (configServerNames.has(name)) continue;
					if (disabledServerNames.has(name)) continue;
					const source = this.ctx.mcpManager.getSource(name);
					if (source) {
						discoveredServers.push({ name, source });
					}
				}
			}

			const groups = [
				...(userServers.length > 0
					? [
							{
								label: "User level",
								path: userPath,
								servers: userServers.map(name => {
									const config = userConfig.mcpServers![name];
									return {
										name,
										type: config.type ?? "stdio",
										state:
											config.enabled === false
												? "inactive"
												: (this.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected"),
									};
								}),
							},
						]
					: []),
				...(projectServers.length > 0
					? [
							{
								label: "Project level",
								path: projectPath,
								servers: projectServers.map(name => {
									const config = projectConfig.mcpServers![name];
									return {
										name,
										type: config.type ?? "stdio",
										state:
											config.enabled === false
												? "inactive"
												: (this.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected"),
									};
								}),
							},
						]
					: []),
				...Array.from(
					groupBySource(discoveredServers, entry => entry.source),
					({ providerName, shortPath, items: entries }) => ({
						label: providerName,
						path: shortPath,
						servers: entries.map(({ name }) => ({
							name,
							state: this.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected",
						})),
					}),
				),
				...([...disabledServerNames].filter(name => !configServerNames.has(name)).length > 0
					? [
							{
								label: "Disabled",
								servers: [...disabledServerNames]
									.filter(name => !configServerNames.has(name))
									.map(name => ({ name, state: "disabled" })),
							},
						]
					: []),
			];
			if (groups.length === 0) {
				this.ctx.presentCommandOutput(McpNoticeView({ text: "No MCP servers configured.", command: "/mcp add" }));
				return;
			}
			this.ctx.presentCommandOutput(McpServerListView({ groups }));
		} catch (error) {
			this.ctx.showError(`Failed to list servers: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp remove <name> - Remove a server
	 */
	async #handleRemove(text: string): Promise<void> {
		const match = text.match(/^\/mcp\s+(?:remove|rm)\b\s*(.*)$/i);
		const rest = match?.[1]?.trim() ?? "";
		const parsed = parseRemoveArgs(rest);
		if (!parsed.ok) {
			this.ctx.showError(parsed.error);
			return;
		}
		const { name, scope } = parsed.value;

		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp remove <name> [--scope project|user]");
			return;
		}

		try {
			const cwd = getProjectDir();
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);
			const filePath = scope === "user" ? userPath : projectPath;
			const config = await readMCPConfigFile(filePath);
			if (!config.mcpServers?.[name]) {
				this.ctx.showError(`Server "${name}" not found in ${scope} config.`);
				return;
			}

			// Disconnect if connected
			if (this.ctx.mcpManager?.getConnection(name)) {
				await this.ctx.mcpManager.disconnectServer(name);
			}

			// Remove from config
			await removeMCPServer(filePath, name);

			// Reload MCP manager
			await this.reloadServers();

			this.ctx.presentCommandOutput(
				McpNoticeView({ text: `Removed server “${name}” from ${scope} config`, color: "success" }),
			);
		} catch (error) {
			this.ctx.showError(`Failed to remove server: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp test <name> - Test connection to a server
	 */
	async #handleTest(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp test <name>");
			return;
		}

		const abortController = new AbortController();
		let settled = false;
		const handleEscape = (): void => {
			if (settled) {
				this.ctx.showStatus(`MCP test for "${name}" already finished`);
				return;
			}
			abortController.abort();
		};

		// Claim Esc before the first await: a slow `#resolveServerForAuth()` (e.g.
		// config on a network filesystem) must not let Esc fall through to the
		// agent-turn abort while the command is already running.
		this.ctx.mcpTestEscapeHandlers.add(handleEscape);

		let connection: MCPServerConnection | undefined;
		// The grace window only applies once the "(esc to cancel)" hint is on
		// screen; a pre-hint failure must release Esc immediately so it is not
		// swallowed for a prompt the user never saw.
		let hintShown = false;
		const [hintText, setHintText] = createSignal(`Testing connection to "${name}"…`);
		let hintEntryId: string | undefined;
		// Outcome-branched settled text: a cancelled or failed test must not
		// read as if it completed.
		let settleNote = `Tested connection to "${name}".`;
		// Cancellation can land while later awaits (auth prepareConfig, connect)
		// are still unwinding. Drop the esc affordance the moment it happens —
		// the dispatcher already consumed the ownership — but claim no outcome:
		// whether this abort actually stops the test is only known once the
		// signal-observing awaits settle (e.g. an abort landing during
		// #syncManagerConnection does not stop it).
		abortController.signal.addEventListener("abort", () => {
			if (settled || !hintShown) return;
			setHintText(`Testing connection to "${name}"…`);
		});
		try {
			// Race the config read against Esc: a slow/stuck `#resolveServerForAuth()`
			// (e.g. config on a network FS) must surface cancellation immediately
			// via the catch branch below, not stay suspended until the read settles.
			const found = await raceAbortSignal(
				this.#resolveServerForAuth(name),
				abortController.signal,
				() => new DOMException("Aborted", "AbortError"),
			);

			if (!found) {
				this.ctx.mcpTestEscapeHandlers.delete(handleEscape);
				this.ctx.showError(`Server "${name}" not found. Tip: Run /mcp list to see available servers.`);
				return;
			}

			const { config } = found;
			if (config.enabled === false) {
				this.ctx.mcpTestEscapeHandlers.delete(handleEscape);
				this.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
				return;
			}

			// Esc may have been consumed during the awaited lookup, before any
			// hint existed. Bail out instead of advertising a cancellation that
			// is already gone.
			if (abortController.signal.aborted) {
				this.ctx.mcpTestEscapeHandlers.delete(handleEscape);
				this.ctx.showStatus(`Cancelled MCP test for "${name}"`);
				return;
			}

			setHintText(`Testing connection to "${name}"… esc to cancel`);
			hintEntryId = `mcp:test:${name}:${Date.now()}`;
			this.ctx.chatContainer.append({
				id: hintEntryId,
				state: "active",
				view: () => CommandNoticeView({ text: hintText(), color: "muted" }),
			});
			hintShown = true;

			// Resolve auth config if needed
			let resolvedConfig: MCPServerConfig;
			if (this.ctx.mcpManager) {
				resolvedConfig = await this.ctx.mcpManager.prepareConfig(config);
			} else {
				const tempManager = new MCPManager(getProjectDir());
				tempManager.setAuthStorage(this.ctx.session.modelRegistry.authStorage);
				resolvedConfig = await tempManager.prepareConfig(config);
			}

			// Create temporary connection
			connection = await connectToServer(name, resolvedConfig, { signal: abortController.signal });

			// List tools to verify connection
			const tools = await listTools(connection, { signal: abortController.signal });

			await this.#syncManagerConnection(name, config);
			this.ctx.presentCommandOutput(
				McpTestResultView({
					name,
					serverName: connection.serverInfo.name,
					version: connection.serverInfo.version,
					tools: tools.map(tool => tool.name),
				}),
			);
		} catch (error) {
			if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
				settleNote = `Cancelled connection test for "${name}".`;
				this.ctx.showStatus(`Cancelled MCP test for "${name}"`);
				return;
			}

			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages
			let helpText = "";
			if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
				helpText = "\n\nTip: Check that the command or URL is correct.";
			} else if (errorMsg.includes("EACCES")) {
				helpText = "\n\nTip: Check file/command permissions.";
			} else if (errorMsg.includes("ECONNREFUSED")) {
				helpText = "\n\nTip: Check that the server is running and the URL/port is correct.";
			} else if (errorMsg.includes("timeout")) {
				helpText = "\n\nTip: The server may be slow or unresponsive. Try increasing the timeout.";
			} else if (errorMsg.includes("401") || errorMsg.includes("403")) {
				helpText = "\n\nTip: Check your authentication credentials.";
			}

			settleNote = `Connection test for "${name}" failed.`;
			this.ctx.showError(`Failed to connect to "${name}": ${errorMsg}${helpText}`);
		} finally {
			settled = true;
			if (hintShown) {
				// The test can no longer be cancelled: stop advertising Esc so a
				// later press cannot be mistaken for test cancellation and abort
				// the running agent turn after the grace expires. Sealing the
				// block after the final text lets TranscriptContainer treat it
				// as immutable history from here on.
				setHintText(settleNote);
				if (hintEntryId) this.ctx.chatContainer.replace(hintEntryId, { state: "settled" });
			}
			if (this.ctx.mcpTestEscapeHandlers.has(handleEscape)) {
				if (hintShown) {
					const timer = setTimeout(() => {
						this.ctx.mcpTestEscapeHandlers.delete(handleEscape);
					}, MCP_TEST_ESCAPE_GRACE_MS);
					timer.unref();
				} else {
					this.ctx.mcpTestEscapeHandlers.delete(handleEscape);
				}
			}
			if (connection) {
				// Best-effort: don't block UI on cleanup.
				void disconnectServer(connection);
			}
		}
	}

	async #handleSetEnabled(name: string | undefined, enabled: boolean): Promise<void> {
		if (!name) {
			this.ctx.showError(`Server name required. Usage: /mcp ${enabled ? "enable" : "disable"} <name>`);
			return;
		}

		try {
			const found = await this.#findConfiguredServer(name);
			if (!found) {
				// Check if this is a discovered server from a third-party config
				const userConfigPath = getMCPConfigPath("user", getProjectDir());
				const disabledServers = new Set(await readDisabledServers(userConfigPath));
				const isDiscovered = this.ctx.mcpManager?.getSource(name);
				const isCurrentlyDisabled = disabledServers.has(name);
				if (!isDiscovered && !isCurrentlyDisabled) {
					this.ctx.showError(`Server "${name}" not found.`);
					return;
				}
				if (isCurrentlyDisabled === !enabled) {
					this.ctx.presentCommandOutput(
						McpNoticeView({ text: `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.` }),
					);
					return;
				}
				await setServerDisabled(userConfigPath, name, !enabled);
				if (enabled) {
					await this.#connectEnabledMCPServer(name);
					const state = await this.#waitForServerConnectionWithAnimation(name);
					const status =
						state === "connected" ? "Connected" : state === "connecting" ? "Connecting" : "Not connected yet";
					this.ctx.presentCommandOutput(
						McpNoticeView({ text: `Enabled "${name}"`, color: "success", detail: `Status: ${status}` }),
					);
				} else {
					await this.ctx.mcpManager?.disconnectServer(name);
					await this.ctx.session.refreshMCPTools(this.ctx.mcpManager?.getTools() ?? []);
					this.ctx.presentCommandOutput(McpNoticeView({ text: `Disabled "${name}"` }));
				}
				return;
			}

			if ((found.config.enabled ?? true) === enabled) {
				this.ctx.presentCommandOutput(
					McpNoticeView({ text: `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.` }),
				);
				return;
			}

			const updated: MCPServerConfig = { ...found.config, enabled };
			await updateMCPServer(found.filePath, name, updated);
			if (enabled) {
				await this.#connectEnabledMCPServer(name);
			} else {
				await this.ctx.mcpManager?.disconnectServer(name);
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager?.getTools() ?? []);
			}

			let status: string | undefined;
			if (enabled) {
				const state = await this.#waitForServerConnectionWithAnimation(name);
				status = state === "connected" ? "Connected" : state === "connecting" ? "Connecting" : "Not connected yet";
			}
			this.ctx.presentCommandOutput(
				McpNoticeView({
					text: `${enabled ? "Enabled" : "Disabled"} "${name}" (${found.scope} config)`,
					color: enabled ? "success" : "muted",
					detail: status ? `Status: ${status}` : undefined,
				}),
			);
		} catch (error) {
			this.ctx.showError(
				`Failed to ${enabled ? "enable" : "disable"} server: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #handleUnauth(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp unauth <name>");
			return;
		}

		try {
			const found = await this.#resolveServerForAuth(name);
			if (!found) {
				this.ctx.showError(`Server "${name}" not found.`);
				return;
			}

			const currentAuth = (found.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			if (currentAuth?.type === "oauth") {
				await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
			}
			// Also drop this profile's url-keyed binding so the server is truly
			// signed out even when the config carries no auth block. Runtime
			// discovery expands `${...}` URL values before MCPManager looks up the
			// deterministic credential row, so unauth must clear that same key.
			let removedUrlKeyedCredential = false;
			if ((found.config.type === "http" || found.config.type === "sse") && found.config.url) {
				removedUrlKeyedCredential = await removeManagedMcpOAuthCredentials(
					authStorage,
					mcpOAuthCredentialIdsForServerUrl(found.config.url),
				);
			}

			if (found.discovered && currentAuth?.type !== "oauth") {
				if (!removedUrlKeyedCredential) {
					this.ctx.presentCommandOutput(McpNoticeView({ text: `No stored OAuth auth to remove for "${name}".` }));
					return;
				}
				await this.reloadServers();
				this.ctx.presentCommandOutput(
					McpNoticeView({ text: `Cleared auth for "${name}" (${found.scope} config)`, color: "success" }),
				);
				return;
			}

			const updated = this.#stripOAuthAuth(found.config);
			await updateMCPServer(found.filePath, name, updated);
			await this.reloadServers();

			this.ctx.presentCommandOutput(
				McpNoticeView({ text: `Cleared auth for "${name}" (${found.scope} config)`, color: "success" }),
			);
		} catch (error) {
			this.ctx.showError(`Failed to clear auth: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Reauthorize a server after a tool-level OAuth challenge. */
	async handleMCPAuthChallenge(name: string, challenge: MCPAuthChallenge): Promise<MCPServerConfig | undefined> {
		return this.#handleReauth(name, { silent: true, reload: false, authChallenge: challenge });
	}

	async #handleReauth(
		name: string | undefined,
		options: { silent?: boolean; reload?: boolean; authChallenge?: MCPAuthChallenge } = {},
	): Promise<MCPServerConfig | undefined> {
		if (!name) {
			if (!options.silent) this.ctx.showError("Server name required. Usage: /mcp reauth <name>");
			return;
		}

		try {
			const found = await this.#resolveServerForAuth(name);
			if (!found) {
				if (!options.silent) this.ctx.showError(`Server "${name}" not found.`);
				return;
			}

			if (found.config.enabled === false) {
				if (!options.silent) this.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
				return;
			}

			const currentAuth = (found.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			const baseConfig = this.#stripOAuthAuth(found.config);
			const runtimeBaseConfig = expandEnvVarsDeep(baseConfig);
			// Resolve endpoints first: this fails fast for stdio transports and
			// probes http/sse with { oauth: false }, so nothing destructive has
			// happened yet if the server turns out not to need (or support) OAuth.
			// Use the same env-expanded config shape runtime discovery passes to
			// MCPManager; the raw file value may contain `${...}` placeholders.
			const oauth = await this.#resolveOAuthEndpointsFromServer(runtimeBaseConfig, options.authChallenge);
			const serverUrl =
				runtimeBaseConfig.type === "http" || runtimeBaseConfig.type === "sse" ? runtimeBaseConfig.url : undefined;
			// Client credentials drive the token exchange, so they must come from the
			// env-expanded runtime config; `found.config`/`currentAuth` may still hold
			// `${...}` placeholders (the wizard writes the secret to auth.clientSecret).
			// DCR secrets are embedded in the stored credential and never echoed back
			// into config files.
			const runtimeAuth = currentAuth ? expandEnvVarsDeep(currentAuth) : undefined;
			const configuredClientId = runtimeBaseConfig.oauth?.clientId?.trim() || undefined;
			const configuredClientSecret = runtimeBaseConfig.oauth?.clientSecret;
			const existingCredential = lookupMcpOAuthCredentialForServer(authStorage, currentAuth, serverUrl)?.credential;
			const persistedClientId = runtimeAuth?.clientId?.trim() || undefined;
			const storedClientId = existingCredential?.clientId?.trim() || undefined;
			const discoveredClientId = oauth.clientId?.trim() || undefined;
			// A metadata-advertised client is only a fallback. Prefer DCR when the
			// authorization server explicitly offers it, while retaining configured
			// and previously registered client credentials above.
			const flowClientId =
				configuredClientId ??
				persistedClientId ??
				storedClientId ??
				(oauth.registrationUrl ? undefined : discoveredClientId) ??
				"";
			const storedClientSecret = storedClientId === flowClientId ? existingCredential?.clientSecret : undefined;
			const flowClientSecret =
				(configuredClientId === flowClientId ? configuredClientSecret : undefined) ??
				(persistedClientId === flowClientId ? runtimeAuth?.clientSecret : undefined) ??
				storedClientSecret ??
				"";
			// Persisted separately below: keep the raw `${...}` placeholder in the file
			// rather than writing the resolved secret back to (possibly shared) config.
			const userClientSecret =
				(configuredClientId === flowClientId ? found.config.oauth?.clientSecret : undefined) ??
				(persistedClientId === flowClientId ? currentAuth?.clientSecret : undefined);
			const hasConfiguredOnlySecret = configuredClientId === undefined && configuredClientSecret !== undefined;

			if (!options.silent) {
				this.ctx.presentCommandOutput(McpNoticeView({ text: `Reauthorizing "${name}"…` }));
			}

			const currentAuthResource = currentAuth?.resource ? expandEnvVarsDeep(currentAuth.resource) : undefined;
			const oauthResource =
				oauth.resource ?? currentAuthResource ?? ("url" in runtimeBaseConfig ? runtimeBaseConfig.url : undefined);
			const oauthResourceIsFallback = !oauth.resource && !currentAuthResource;

			const oauthResult = await this.#handleOAuthFlow(
				oauth.authorizationUrl,
				oauth.tokenUrl,
				flowClientId,
				flowClientSecret,
				oauth.scopes || runtimeBaseConfig.oauth?.scope || "",
				{
					callbackPort: found.config.oauth?.callbackPort,
					callbackPath: found.config.oauth?.callbackPath,
					redirectUri: found.config.oauth?.redirectUri,
					prompt: found.config.oauth?.prompt,
					registrationUrl: oauth.registrationUrl,
					issuerUrl: oauth.issuerUrl,
					serverUrl,
					resource: oauthResource,
					stripSameOriginResource: oauthResourceIsFallback,
				},
			);

			// The flow overwrote (or minted) this profile's row; a superseded
			// pointer row from the legacy random-id era is now orphaned. GC only
			// after success so cancelling the browser step leaves the previous
			// session signed in.
			if (currentAuth?.type === "oauth" && currentAuth.credentialId !== oauthResult.credentialId) {
				await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
			}

			// Definition-only entries resolve through the url-keyed binding alone;
			// skip the write-back so a committed project mcp.json stays clean.
			const urlKeyedId = serverUrl ? mcpOAuthCredentialId(serverUrl) : undefined;
			const shouldPersist = currentAuth || oauthResult.credentialId !== urlKeyedId;
			const updatedConfig = shouldPersist
				? this.#persistOAuthResult(baseConfig, oauthResult, {
						tokenUrl: oauth.tokenUrl,
						// Do not turn a configured-only secret into a persisted oauth
						// client pair by echoing the discovered client id.
						clientId: oauth.clientId,
						persistOAuthClientId: !hasConfiguredOnlySecret,
						userClientSecret,
						resource: oauthResource,
						stripSameOriginResource: oauthResourceIsFallback,
					})
				: baseConfig;
			if (shouldPersist) {
				await updateMCPServer(found.filePath, name, updatedConfig);
			}
			if (options.reload !== false) {
				await this.reloadServers();
				const state = await this.#waitForServerConnectionWithAnimation(name);

				const status =
					state === "connected" ? "connected" : state === "connecting" ? "connecting" : "not connected";
				this.ctx.presentCommandOutput(
					McpNoticeView({
						text: `Reauthorized "${name}" (${found.scope} config)`,
						color: "success",
						detail: `Status: ${status}`,
					}),
				);
			}
			return updatedConfig;
		} catch (error) {
			if (error instanceof MCPOAuthCancelledError) {
				if (!options.silent) this.ctx.showStatus(`Reauthorization cancelled for "${name}"`);
				return;
			}
			if (!options.silent) {
				this.ctx.showError(
					`Failed to reauthorize server: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	async #handleReload(): Promise<void> {
		try {
			this.ctx.presentCommandOutput(McpNoticeView({ text: "Reloading MCP servers and runtime tools…" }));
			await this.reloadServers();
			const manager = this.ctx.mcpManager;
			const connectedCount = manager?.getConnectedServers().length ?? 0;
			const connectingCount =
				manager?.getAllServerNames().filter(name => manager.getConnectionStatus(name) === "connecting").length ?? 0;
			this.ctx.presentCommandOutput(
				McpNoticeView({
					text: "MCP reload complete",
					color: "success",
					detail: `Connected servers: ${connectedCount}\nConnecting servers: ${connectingCount}`,
				}),
			);
		} catch (error) {
			this.ctx.showError(`Failed to reload MCP: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp reconnect <name> - Reconnect to a specific server.
	 */
	async #handleReconnect(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp reconnect <name>");
			return;
		}
		if (!this.ctx.mcpManager) {
			this.ctx.showError("MCP manager not available.");
			return;
		}

		this.ctx.presentCommandOutput(McpNoticeView({ text: `Reconnecting to "${name}"…` }));

		try {
			const connection = await this.ctx.mcpManager.reconnectServer(name, { manual: true });
			if (connection) {
				// refreshMCPTools re-registers tools and preserves the user's prior
				// MCP tool selection. No need to call activateDiscoveredMCPTools —
				// that would broaden the selection to all server tools.
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
				const serverTools = this.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
				this.ctx.presentCommandOutput(
					McpNoticeView({
						text: `Reconnected to "${name}"`,
						color: "success",
						detail: `Tools: ${serverTools.length}`,
					}),
				);
			} else {
				this.ctx.showError(`Failed to reconnect to "${name}". Check server status and logs.`);
			}
		} catch (error) {
			this.ctx.showError(
				`Failed to reconnect to "${name}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #connectEnabledMCPServer(name: string): Promise<void> {
		if (!this.ctx.mcpManager) {
			return;
		}

		const { configs, sources } = await loadAllMCPConfigs(getProjectDir(), {
			extensionRoots: this.ctx.session.effectiveExtensionRoots,
		});
		const config = configs[name];
		if (!config) {
			await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			return;
		}

		const source = sources[name];
		const result = await this.ctx.mcpManager.connectServers({ [name]: config }, source ? { [name]: source } : {});
		await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
		this.#showMCPConnectionErrors(result.errors);
	}

	#showMCPConnectionErrors(errors: Map<string, string>): void {
		if (errors.size === 0) {
			return;
		}

		this.ctx.presentCommandOutput(
			McpNoticeView({
				text: "Some servers failed to connect.",
				color: "warning",
				detail: [...errors.entries()].map(([serverName, error]) => `${serverName}: ${error}`).join("\n"),
			}),
		);
	}

	/**
	 * Reconnect every configured MCP server and rebind the session's MCP tools.
	 *
	 * Disconnects all live connections, rediscovers `.mcp.json` configs, and
	 * calls `session.refreshMCPTools(...)` so config edits take effect without a
	 * restart. Public because `/reload-plugins` reuses it alongside `/mcp reload`
	 * and the config-mutation flows in this controller.
	 *
	 * Discovery options are derived from settings so the reload honors the same
	 * opt-outs as startup — notably `mcp.enableProjectConfig: false`, which must
	 * keep project `.mcp.json` servers from being started on reload.
	 */
	async reloadServers(): Promise<void> {
		if (!this.ctx.mcpManager) {
			return;
		}

		// Disconnect all existing servers
		await this.ctx.mcpManager.disconnectAll();
		// Prompt enrichment is asynchronous. Clear commands before rediscovery so
		// removed/disabled servers cannot leave stale `/server:prompt` entries;
		// newly loaded prompts repopulate them through the manager callback.
		this.ctx.session.setMCPPromptCommands([]);
		// External edits to mcp.json (not via writeMCPConfigFile) otherwise
		// keep stale env/command after reload.
		clearFsCache();

		// Rediscover and connect, mirroring startup's discovery filters.
		const result = await this.ctx.mcpManager.discoverAndConnect({
			enableProjectConfig: this.ctx.settings.get("mcp.enableProjectConfig") ?? true,
			filterExa: true,
			filterBrowser: this.ctx.session.getEvalPreludes().some(definition => definition.name === "browser"),
			extensionRoots: this.ctx.session.effectiveExtensionRoots,
		});
		await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());

		this.#showMCPConnectionErrors(result.errors);
	}

	/**
	 * Handle /mcp resources - Show available resources from connected servers
	 */
	async #handleResources(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const groups = this.ctx.mcpManager.getConnectedServers().flatMap(name => {
			const data = this.ctx.mcpManager!.getServerResources(name);
			return data && (data.resources.length > 0 || data.templates.length > 0)
				? [{ name, resources: data.resources, templates: data.templates }]
				: [];
		});
		this.ctx.presentCommandOutput(McpResourcesView({ groups }));
	}

	/**
	 * Handle /mcp prompts - Show available prompts from connected servers
	 */
	async #handlePrompts(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const groups = this.ctx.mcpManager.getConnectedServers().flatMap(name => {
			const prompts = this.ctx.mcpManager!.getServerPrompts(name);
			return prompts?.length ? [{ name, prompts }] : [];
		});
		this.ctx.presentCommandOutput(McpPromptsView({ groups }));
	}

	/**
	 * Handle /mcp notifications - Show notification and subscription state
	 */
	async #handleNotifications(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const { enabled, subscriptions } = this.ctx.mcpManager.getNotificationState();
		const groups = this.ctx.mcpManager.getConnectedServers().flatMap(name => {
			const connection = this.ctx.mcpManager!.getConnection(name);
			if (!connection) return [];
			const caps = connection.capabilities;
			const supportsResources = caps.resources !== undefined;
			const supportsSubscribe = caps.resources?.subscribe === true;
			const toolsChanged = caps.tools?.listChanged === true;
			const promptsChanged = caps.prompts?.listChanged === true;
			const resourcesChanged = caps.resources?.listChanged === true;
			if (!toolsChanged && !promptsChanged && !resourcesChanged && !supportsSubscribe) return [];
			return [
				{
					name,
					toolsChanged,
					resourcesChanged,
					promptsChanged,
					supportsSubscribe,
					supportsResources,
					subscriptions: [...(subscriptions.get(name) ?? [])],
				},
			];
		});
		this.ctx.presentCommandOutput(McpNotificationsView({ enabled, groups }));
	}

	async #validateSmitheryApiKey(apiKey: string): Promise<void> {
		await searchSmitheryRegistry("mcp", { limit: 1, apiKey });
	}

	async #promptSmitheryApiKey(promptLabel: string): Promise<string | null> {
		for (;;) {
			const input = await this.ctx.showHookInput(promptLabel);
			if (input === undefined) return null;
			const apiKey = input.trim();
			if (!apiKey) {
				this.ctx.showError("Smithery API key cannot be empty.");
				continue;
			}
			try {
				await this.#validateSmitheryApiKey(apiKey);
				return apiKey;
			} catch (error) {
				this.ctx.showError(
					`Smithery API key validation failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	async #handleSmitheryLoginWithApiKey(): Promise<boolean> {
		const apiKey = await this.#promptSmitheryApiKey("Smithery API key (Esc to cancel)");
		if (!apiKey) return false;
		await saveSmitheryApiKey(apiKey);
		this.ctx.showStatus("Smithery API key saved.");
		return true;
	}

	async #waitForSmitheryCliApiKey(sessionId: string, signal: AbortSignal): Promise<string> {
		const pollIntervalMs = 2_000;
		const timeoutMs = 300_000;
		const startedAt = Date.now();

		while (!signal.aborted) {
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error("Smithery authorization timed out after 5 minutes.");
			}
			let response: SmitheryCliPollResponse;
			try {
				response = await pollSmitheryCliAuthSession(sessionId, signal);
			} catch (error) {
				// A single hung/slow poll aborts with TimeoutError; retry until the deadline.
				if (isTimeoutError(error)) continue;
				throw error;
			}
			if (response.status === "success" && response.apiKey) {
				return response.apiKey;
			}
			if (response.status === "error") {
				throw new Error(response.message ?? "Smithery authorization failed.");
			}
			await Bun.sleep(pollIntervalMs);
		}

		throw new Error("Smithery authorization cancelled.");
	}

	async #handleSmitheryBrowserLogin(): Promise<boolean> {
		const session = await createSmitheryCliAuthSession();
		const fallbackLoginUrl = getSmitheryLoginUrl();
		this.ctx.presentCommandOutput(
			SmitheryBrowserLoginView({ authorizationUrl: session.authUrl, fallbackUrl: fallbackLoginUrl }),
		);
		try {
			openPath(session.authUrl);
		} catch {
			// URL is already shown above.
		}

		const apiKey = await this.#waitForSmitheryCliApiKey(session.sessionId, new AbortController().signal);
		await this.#validateSmitheryApiKey(apiKey);
		await saveSmitheryApiKey(apiKey);
		this.ctx.showStatus("Smithery API key saved.");
		return true;
	}

	async #promptSmitheryLogin(reason: string): Promise<boolean> {
		this.ctx.presentCommandOutput(
			McpNoticeView({
				text: `Smithery authentication required (${reason}).`,
				detail: "If browser auth fails, you can paste an API key.",
			}),
		);
		try {
			return await this.#handleSmitheryBrowserLogin();
		} catch (error) {
			this.ctx.showWarning(
				`Browser authorization failed: ${error instanceof Error ? error.message : String(error)}. Falling back to API key.`,
			);
			return await this.#handleSmitheryLoginWithApiKey();
		}
	}

	#getSmitheryErrorStatus(error: unknown): number | undefined {
		if (error instanceof SmitheryRegistryError || error instanceof SmitheryConnectError) {
			return error.status;
		}
		return undefined;
	}

	#toSmitheryAuthReason(status: number): string {
		return status === 429 ? "rate limited by Smithery" : "forbidden/unauthorized with Smithery";
	}

	async #requireSmitheryApiKey(reason: string): Promise<string> {
		let apiKey = await getSmitheryApiKey();
		if (apiKey) return apiKey;

		const loggedIn = await this.#promptSmitheryLogin(reason);
		if (!loggedIn) {
			throw new Error("Smithery login cancelled. Run /mcp smithery-login, then retry /mcp smithery-search.");
		}

		apiKey = await getSmitheryApiKey();
		if (!apiKey) {
			throw new Error("Smithery API key not found after login.");
		}
		return apiKey;
	}

	async #runSmitheryOperationWithAuthRetry<T>(operation: (apiKey: string) => Promise<T>, reason: string): Promise<T> {
		const apiKey = await this.#requireSmitheryApiKey(reason);
		try {
			return await operation(apiKey);
		} catch (error) {
			const status = this.#getSmitheryErrorStatus(error);
			if (status === undefined || ![401, 403, 429].includes(status)) {
				throw error;
			}
			const loggedIn = await this.#promptSmitheryLogin(this.#toSmitheryAuthReason(status));
			if (!loggedIn) {
				throw error;
			}
			const retryApiKey = await this.#requireSmitheryApiKey(reason);
			return await operation(retryApiKey);
		}
	}

	async #handleSmitheryLogin(): Promise<void> {
		const ok = await this.#promptSmitheryLogin("login");
		if (!ok) {
			this.ctx.showStatus("Smithery login cancelled.");
		}
	}

	async #handleSmitheryLogout(): Promise<void> {
		const removed = await clearSmitheryApiKey();
		this.ctx.showStatus(removed ? "Smithery API key removed." : "No cached Smithery API key found.");
	}

	async #nextAvailableServerName(scope: MCPAddScope, baseName: string): Promise<string> {
		const filePath = getMCPConfigPath(scope, getProjectDir());
		const config = await readMCPConfigFile(filePath);
		const existingNames = new Set(Object.keys(config.mcpServers ?? {}));
		if (!existingNames.has(baseName)) return baseName;
		for (let i = 2; i <= 999; i++) {
			const candidate = `${baseName}-${i}`;
			if (!existingNames.has(candidate)) return candidate;
		}
		return `${baseName}-${Date.now()}`;
	}

	async #promptDeploymentServerName(scope: MCPAddScope, defaultName: string): Promise<string | null> {
		for (;;) {
			const input = await this.ctx.showHookInput(`Server name for deploy (default: ${defaultName})`, defaultName);
			if (input === undefined) return null;
			const proposed = input.trim() || defaultName;
			if (!proposed) {
				this.ctx.showError("Server name cannot be empty.");
				continue;
			}
			const filePath = getMCPConfigPath(scope, getProjectDir());
			const config = await readMCPConfigFile(filePath);
			if (config.mcpServers?.[proposed]) {
				this.ctx.showError(`Server "${proposed}" already exists in ${scope} config.`);
				continue;
			}
			return proposed;
		}
	}

	async #promptRequiredRegistryInputs(result: SmitherySearchResult): Promise<Record<string, string> | null> {
		const values: Record<string, string> = {};
		for (const input of result.requiredInputs) {
			const label = input.required ? `${input.key} (required)` : `${input.key} (optional)`;
			const prompt = `${label}${input.description ? ` - ${input.description}` : ""}`;
			const userInput = await this.ctx.showHookInput(prompt, input.defaultValue);
			if (userInput === undefined) {
				if (input.required) return null;
				continue;
			}
			const value = userInput.trim();
			if (!value) {
				if (input.required) {
					this.ctx.showError(`Missing required value for "${input.key}".`);
					return null;
				}
				continue;
			}
			values[input.key] = value;
		}
		return values;
	}

	#applyRegistryInputOverrides(config: MCPServerConfig, values: Record<string, string>): MCPServerConfig {
		if (Object.keys(values).length === 0) return config;
		if (config.type !== "stdio") {
			return config;
		}
		const args = [...(config.args ?? [])];
		const configJson = JSON.stringify(values);
		const index = args.indexOf("--config");
		if (index >= 0) {
			if (index + 1 < args.length) {
				args[index + 1] = configJson;
			} else {
				args.push(configJson);
			}
		} else {
			args.push("--config", configJson);
		}
		return { ...config, args };
	}

	async #pickRegistryResult(results: SmitherySearchResult[], keyword: string): Promise<SmitherySearchResult | null> {
		const options = results.map((result, index) => {
			const label = `${index + 1}. ${result.display.displayName} (${result.display.transport}, uses ${result.display.useCount})`;
			return label.length > 120 ? `${label.slice(0, 117)}...` : label;
		});
		const selected = await this.ctx.showHookSelector(`Registry results for "${keyword}"`, options);
		if (!selected) return null;
		const prefix = selected.split(".", 1)[0];
		const index = Number(prefix) - 1;
		if (!Number.isInteger(index) || index < 0 || index >= results.length) return null;
		return results[index] ?? null;
	}

	async #deployRegistryResult(result: SmitherySearchResult, scope: MCPAddScope): Promise<void> {
		const baseName = toConfigName(result.name);
		const defaultName = await this.#nextAvailableServerName(scope, baseName);
		const serverName = await this.#promptDeploymentServerName(scope, defaultName);
		if (!serverName) {
			this.ctx.showStatus("MCP deploy cancelled.");
			return;
		}
		const inputValues = await this.#promptRequiredRegistryInputs(result);
		if (inputValues === null) {
			this.ctx.showStatus("MCP deploy cancelled.");
			return;
		}
		const config = this.#applyRegistryInputOverrides(result.config, inputValues);
		await this.#handleWizardComplete(serverName, config, scope);
	}

	async #handleSearch(text: string): Promise<void> {
		const parsed = this.#parseSearchCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}

		try {
			this.ctx.presentCommandOutput(McpNoticeView({ text: `Searching Smithery registry for "${parsed.keyword}"…` }));
			const results = await this.#runSmitheryOperationWithAuthRetry(
				apiKey =>
					searchSmitheryRegistry(parsed.keyword, {
						limit: parsed.limit,
						apiKey,
						includeSemantic: parsed.semantic,
					}),
				"required for smithery-search",
			);
			if (results.length === 0) {
				this.ctx.presentCommandOutput(
					McpNoticeView({ text: `No Smithery results found for "${parsed.keyword}".`, color: "warning" }),
				);
				return;
			}

			const selected = await this.#pickRegistryResult(results, parsed.keyword);
			if (!selected) {
				this.ctx.showStatus("MCP Smithery selection cancelled.");
				return;
			}

			await this.#deployRegistryResult(selected, parsed.scope);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/authentication was cancelled|login cancelled/i.test(message)) {
				this.ctx.showError(`${message} Run /mcp smithery-login to authenticate first.`);
				return;
			}
			this.ctx.showError(`Smithery search failed: ${message}`);
		}
	}
}
