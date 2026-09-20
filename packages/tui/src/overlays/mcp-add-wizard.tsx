import { createMemo, createSignal, For, useClock, type Accessor, type JSX } from "../reactive";
import { extractPrintableText, matchesKey } from "../keys";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent } from "../host/input";
import type { TUI } from "../tui";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import { shortenPath } from "../render/render-utils";
import { replaceTabs } from "../utils";
import { theme } from "../theme/theme";

type TransportType = "stdio" | "http" | "sse";
type AuthMethod = "none" | "oauth" | "manual";
type AuthLocation = "env" | "header";
type Scope = "user" | "project";
type Step =
	| "name"
	| "transport"
	| "command"
	| "args"
	| "url"
	| "auth-method"
	| "oauth-error"
	| "oauth-auth-url"
	| "oauth-token-url"
	| "oauth-client-id"
	| "oauth-client-secret"
	| "oauth-scopes"
	| "apikey"
	| "auth-location"
	| "env-var-name"
	| "header-name"
	| "scope"
	| "confirm";
type StatusTone = "accent" | "success" | "warning" | "error" | "muted";

interface MCPAddWizardAuth {
	type: "oauth";
	credentialId: string;
	tokenUrl?: string;
	clientId?: string;
	clientSecret?: string;
	resource?: string;
}

interface MCPAddWizardConfigBase {
	timeout?: number;
	auth?: MCPAddWizardAuth;
}

interface MCPAddWizardStdioConfig extends MCPAddWizardConfigBase {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

interface MCPAddWizardRemoteConfig extends MCPAddWizardConfigBase {
	type: "http" | "sse";
	url: string;
	headers?: Record<string, string>;
}

export type MCPAddWizardConfig = MCPAddWizardStdioConfig | MCPAddWizardRemoteConfig;

interface MCPAddWizardOAuthEndpoints {
	authorizationUrl: string;
	tokenUrl: string;
	issuerUrl?: string;
	clientId?: string;
	registrationUrl?: string;
	scopes?: string;
	resource?: string;
}

interface MCPAddWizardAuthDetection {
	requiresAuth: boolean;
	authType?: "oauth" | "apikey" | "unknown";
	oauth?: MCPAddWizardOAuthEndpoints;
	authServerUrl?: string;
	resourceMetadataUrl?: string;
	scopes?: string;
}

export interface MCPAddWizardDeps {
	validateServerName(name: string): string | undefined;
	analyzeAuthError(error: Error, serverUrl?: string): MCPAddWizardAuthDetection;
	discoverOAuthEndpoints(
		serverUrl: string,
		authServerUrl?: string,
		resourceMetadataUrl?: string,
		options?: { protectedScopes?: string },
	): Promise<MCPAddWizardOAuthEndpoints | null>;
	fetchResourceMetadataScopes(resourceMetadataUrl: string): Promise<string | undefined>;
}

export interface MCPAddWizardOAuthResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

export interface MCPAddWizardOAuthOptions {
	serverUrl?: string;
	resource?: string;
	stripSameOriginResource?: boolean;
	registrationUrl?: string;
	issuerUrl?: string;
	abortSignal?: AbortSignal;
}

interface WizardState {
	name: string;
	transport: TransportType | null;
	command: string;
	args: string;
	url: string;
	authMethod: AuthMethod;
	oauthAuthUrl: string;
	oauthTokenUrl: string;
	oauthRegistrationUrl: string;
	oauthIssuerUrl: string;
	oauthClientId: string;
	oauthClientSecret: string;
	oauthScopes: string;
	oauthResource: string;
	oauthResourceIsFallback: boolean;
	oauthCredentialId: string | null;
	apiKey: string;
	authLocation: AuthLocation | null;
	envVarName: string;
	headerName: string;
	scope: Scope | null;
}

interface WizardChoiceOption {
	readonly label: string;
	readonly description?: string;
}

interface InputStep {
	readonly heading: string;
	readonly prompt: string;
	readonly hint: string;
	readonly details?: readonly string[];
	readonly mask?: boolean;
}

interface ChoiceStep {
	readonly heading: string;
	readonly tone?: StatusTone;
	readonly choices: readonly WizardChoiceOption[];
	readonly hint: string;
}

interface OAuthErrorLine {
	readonly text: string;
	readonly muted: boolean;
}

export type MCPAddWizardAsyncStatus =
	| { readonly kind: "connection-success" }
	| { readonly kind: "connection-failure"; readonly error: string }
	| { readonly kind: "oauth-detected" }
	| { readonly kind: "oauth-unavailable" }
	| { readonly kind: "oauth-incomplete" }
	| { readonly kind: "oauth-authenticating" }
	| { readonly kind: "oauth-health"; readonly result: "checking" | "passed" | "failed"; readonly error?: string }
	| {
			readonly kind: "oauth-error";
			readonly heading: string;
			readonly tone: "error" | "muted";
			readonly lines: readonly OAuthErrorLine[];
	  };

export interface MCPAddWizardCallbacks {
	onComplete(name: string, config: MCPAddWizardConfig, scope: Scope): void;
	onCancel(): void;
	onOAuth?: (
		authUrl: string,
		tokenUrl: string,
		clientId: string,
		clientSecret: string,
		scopes: string,
		options?: MCPAddWizardOAuthOptions,
	) => Promise<MCPAddWizardOAuthResult>;
	onTestConnection?: (config: MCPAddWizardConfig) => Promise<void>;
}

export interface MCPAddWizardController {
	readonly step: Accessor<Step>;
	readonly state: Accessor<Readonly<WizardState>>;
	readonly error: Accessor<string | undefined>;
	readonly selectedIndex: Accessor<number>;
	readonly status: Accessor<MCPAddWizardAsyncStatus | undefined>;
	handleInput(data: string): void;
	updateInput(value: string): void;
	submit(): void;
	escapeInput(): void;
	cancel(): void;
	dispose(): void;
}

function sanitize(text: string): string {
	return replaceTabs(text);
}

function errorFrom(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason));
}

function inputStepFor(step: Step): InputStep | undefined {
	switch (step) {
		case "name":
			return {
				heading: "Step 1: Server Name",
				prompt: "Enter a unique name for this server:",
				hint: "[Only letters, numbers, dash, underscore, dot, colon]\n[Enter to continue, Esc to cancel]",
			};
		case "command":
			return {
				heading: "Step 3: Command",
				prompt: "Enter the command to run:",
				hint: "[Enter to continue, Esc to go back]",
			};
		case "args":
			return {
				heading: "Step 4: Arguments (Optional)",
				prompt: "Enter command arguments (space-separated):",
				hint: "[Press Enter to skip or continue]",
			};
		case "url":
			return {
				heading: "Step 3: Server URL",
				prompt: "Enter the server URL:",
				hint: "[Must start with http:// or https://]\n[Enter to continue, Esc to go back]",
			};
		case "oauth-auth-url":
			return {
				heading: "OAuth: Authorization URL",
				prompt: "Enter the OAuth authorization endpoint:",
				details: ["e.g., https://auth.example.com/oauth/authorize"],
				hint: "[Enter to continue, Esc to go back]",
			};
		case "oauth-token-url":
			return {
				heading: "OAuth: Token URL",
				prompt: "Enter the OAuth token endpoint:",
				details: ["e.g., https://auth.example.com/oauth/token"],
				hint: "[Enter to continue, Esc to go back]",
			};
		case "oauth-client-id":
			return {
				heading: "OAuth: Client ID",
				prompt: "Enter your OAuth client ID:",
				hint: "[Enter to continue, Esc to go back]",
			};
		case "oauth-client-secret":
			return {
				heading: "OAuth: Client Secret (Optional)",
				prompt: "Enter your OAuth client secret:",
				details: ["(Leave empty for PKCE-only flows)"],
				hint: "[Enter to continue, Esc to go back]",
				mask: true,
			};
		case "oauth-scopes":
			return {
				heading: "OAuth: Scopes (Optional)",
				prompt: "Enter OAuth scopes (space-separated):",
				details: ["e.g., read write"],
				hint: "[Enter to continue, Esc to go back]",
			};
		case "apikey":
			return {
				heading: "API Key Required",
				prompt: "Enter your API key or token:",
				details: ["(Supports !command for password manager)"],
				hint: "[Enter to continue, Esc to go back]",
				mask: true,
			};
		case "env-var-name":
			return {
				heading: "Step: Environment Variable Name",
				prompt: "Enter the environment variable name:",
				hint: "[Enter to continue, Esc to go back]",
			};
		case "header-name":
			return {
				heading: "Step: HTTP Header Name",
				prompt: "Enter the HTTP header name:",
				hint: "[Enter to continue, Esc to go back]",
			};
		default:
			return undefined;
	}
}

function choiceStepFor(step: Step): ChoiceStep | undefined {
	switch (step) {
		case "transport":
			return {
				heading: "Step 2: Transport Type",
				choices: [
					{ label: "stdio (Local process)" },
					{ label: "http (HTTP server)" },
					{ label: "sse (Server-Sent Events)" },
				],
				hint: "[↑↓ to navigate, Enter to select, Esc to cancel]",
			};
		case "auth-method":
			return {
				heading: "Step: Authentication Method",
				choices: [
					{ label: "OAuth flow (web-based)", description: "(opens browser)" },
					{ label: "Manual API key/token", description: "(paste or use shell command)" },
				],
				hint: "[↑↓ to navigate, Enter to select, Esc to go back]",
			};
		case "auth-location":
			return {
				heading: "Step: How to provide the key?",
				choices: [{ label: "Environment variable" }, { label: "HTTP header" }],
				hint: "[↑↓ to navigate, Enter to select, Esc to go back]",
			};
		case "oauth-error":
			return {
				heading: "OAuth authentication failed",
				tone: "error",
				choices: [{ label: "Retry OAuth authentication" }, { label: "Edit OAuth settings" }],
				hint: "[↑↓ to navigate, Enter to select, Esc to go back]",
			};
		case "scope": {
			const cwd = getProjectDir();
			const userPath = shortenPath(getMCPConfigPath("user", cwd));
			const projectPath = shortenPath(getMCPConfigPath("project", cwd));
			return {
				heading: "Step: Configuration Scope",
				choices: [{ label: `User level (${userPath})` }, { label: `Project level (${projectPath})` }],
				hint: "[↑↓ to navigate, Enter to select, Esc to go back]",
			};
		}
		case "confirm":
			return {
				heading: "Review Configuration",
				choices: [{ label: "Yes" }, { label: "No" }],
				hint: "[↑↓ to navigate, Enter to select, Esc to go back]",
			};
		default:
			return undefined;
	}
}

function inputValueFor(step: Step, state: Readonly<WizardState>): string {
	switch (step) {
		case "name":
			return state.name;
		case "command":
			return state.command;
		case "args":
			return state.args;
		case "url":
			return state.url;
		case "oauth-auth-url":
			return state.oauthAuthUrl;
		case "oauth-token-url":
			return state.oauthTokenUrl;
		case "oauth-client-id":
			return state.oauthClientId;
		case "oauth-client-secret":
			return state.oauthClientSecret;
		case "oauth-scopes":
			return state.oauthScopes;
		case "apikey":
			return state.apiKey;
		case "env-var-name":
			return state.envVarName;
		case "header-name":
			return state.headerName;
		default:
			return "";
	}
}

export function createMcpAddWizardController(
	deps: MCPAddWizardDeps,
	callbacks: MCPAddWizardCallbacks,
	initialName?: string,
): MCPAddWizardController {
	const suppliedName = initialName?.trim() ?? "";
	const [step, setStep] = createSignal<Step>(suppliedName ? "transport" : "name");
	const [state, setState] = createSignal<WizardState>({
		name: suppliedName,
		transport: null,
		command: "",
		args: "",
		url: "",
		authMethod: "none",
		oauthAuthUrl: "",
		oauthTokenUrl: "",
		oauthRegistrationUrl: "",
		oauthIssuerUrl: "",
		oauthClientId: "",
		oauthClientSecret: "",
		oauthScopes: "",
		oauthResource: "",
		oauthResourceIsFallback: false,
		oauthCredentialId: null,
		apiKey: "",
		authLocation: null,
		envVarName: "API_KEY",
		headerName: "Authorization",
		scope: null,
	});
	const [error, setError] = createSignal<string>();
	const [selectedIndex, setSelectedIndex] = createSignal(0);
	const [status, setStatus] = createSignal<MCPAddWizardAsyncStatus>();
	let disposed = false;
	let operation = 0;
	let pendingTransition: NodeJS.Timeout | undefined;
	let cancelHealthDeadline: (() => void) | undefined;
	let oauthAbort: AbortController | undefined;

	const isCurrent = (candidate: number): boolean => !disposed && candidate === operation;
	const clearTransition = (): void => {
		if (!pendingTransition) return;
		clearTimeout(pendingTransition);
		pendingTransition = undefined;
	};
	const invalidateAsync = (abortOAuth: boolean): void => {
		operation++;
		clearTransition();
		cancelHealthDeadline?.();
		cancelHealthDeadline = undefined;
		if (abortOAuth && oauthAbort && !oauthAbort.signal.aborted) oauthAbort.abort("MCP wizard closed");
	};
	const beginAsync = (): number => {
		invalidateAsync(false);
		return operation;
	};
	const schedule = (candidate: number, delay: number, callback: () => void): void => {
		clearTransition();
		pendingTransition = setTimeout(() => {
			pendingTransition = undefined;
			if (isCurrent(candidate)) callback();
		}, delay);
	};
	const moveTo = (next: Step, index?: number): void => {
		setError(undefined);
		setStatus(undefined);
		setStep(next);
		if (index !== undefined) setSelectedIndex(index);
	};
	const moveToScope = (candidate: number): void => {
		if (!isCurrent(candidate)) return;
		moveTo("scope", 0);
	};

	const updateInput = (value: string): void => {
		if (disposed) return;
		const current = step();
		setState(previous => {
			switch (current) {
				case "name":
					return { ...previous, name: value };
				case "command":
					return { ...previous, command: value };
				case "args":
					return { ...previous, args: value };
				case "url":
					return { ...previous, url: value };
				case "oauth-auth-url":
					return { ...previous, oauthAuthUrl: value };
				case "oauth-token-url":
					return { ...previous, oauthTokenUrl: value };
				case "oauth-client-id":
					return { ...previous, oauthClientId: value };
				case "oauth-client-secret":
					return { ...previous, oauthClientSecret: value };
				case "oauth-scopes":
					return { ...previous, oauthScopes: value };
				case "apikey":
					return { ...previous, apiKey: value };
				case "env-var-name":
					return { ...previous, envVarName: value };
				case "header-name":
					return { ...previous, headerName: value };
				default:
					return previous;
			}
		});
	};

	const buildConfig = (includeAuth: boolean, includeTimeout: boolean): MCPAddWizardConfig => {
		const current = state();
		const transport: TransportType = current.transport ?? "stdio";
		if (transport === "stdio") {
			const config: MCPAddWizardStdioConfig = { type: "stdio", command: current.command };
			if (includeTimeout) config.timeout = 5000;
			if (current.args) config.args = current.args.split(/\s+/).filter(Boolean);
			if (includeAuth && current.authMethod === "oauth" && current.oauthCredentialId) {
				config.auth = {
					type: "oauth",
					credentialId: current.oauthCredentialId,
					tokenUrl: current.oauthTokenUrl || undefined,
					resource: current.oauthResource || undefined,
					clientId: current.oauthClientId || undefined,
					clientSecret: current.oauthClientSecret || undefined,
				};
			}
			if (includeAuth && current.authMethod === "manual" && current.apiKey) {
				config.env = { [current.envVarName || "API_KEY"]: current.apiKey };
			}
			return config;
		}
		const config: MCPAddWizardRemoteConfig = { type: transport, url: current.url };
		if (includeTimeout) config.timeout = 5000;
		if (includeAuth && current.authMethod === "oauth" && current.oauthCredentialId) {
			config.auth = {
				type: "oauth",
				credentialId: current.oauthCredentialId,
				tokenUrl: current.oauthTokenUrl || undefined,
				resource: current.oauthResource || undefined,
				clientId: current.oauthClientId || undefined,
				clientSecret: current.oauthClientSecret || undefined,
			};
		}
		if (includeAuth && current.authMethod === "manual" && current.apiKey) {
			config.headers = { [current.headerName || "Authorization"]: current.apiKey };
		}
		return config;
	};

	const launchOAuthFlow = async (): Promise<void> => {
		const candidate = beginAsync();
		const current = state();
		if (!callbacks.onOAuth) {
			if (isCurrent(candidate)) setStatus({ kind: "oauth-unavailable" });
			return;
		}
		if (!current.oauthAuthUrl || !current.oauthTokenUrl) {
			if (isCurrent(candidate)) setStatus({ kind: "oauth-incomplete" });
			return;
		}
		setStatus({ kind: "oauth-authenticating" });
		const abort = new AbortController();
		oauthAbort = abort;
		try {
			const oauthResourceIsFallback =
				current.oauthResourceIsFallback || (!current.oauthResource && current.transport !== "stdio");
			const oauthResource = current.oauthResource || (current.transport === "stdio" ? "" : current.url);
			const result = await callbacks.onOAuth(
				current.oauthAuthUrl,
				current.oauthTokenUrl,
				current.oauthClientId,
				current.oauthClientSecret,
				current.oauthScopes,
				{
					serverUrl: current.url || undefined,
					registrationUrl: current.oauthRegistrationUrl || undefined,
					issuerUrl: current.oauthIssuerUrl || undefined,
					resource: oauthResource || undefined,
					stripSameOriginResource: oauthResourceIsFallback,
					abortSignal: abort.signal,
				},
			);
			if (!isCurrent(candidate)) return;
			setState(previous => ({
				...previous,
				oauthCredentialId: result.credentialId,
				oauthClientId: result.clientId || previous.oauthClientId,
				oauthResource: result.resource ?? oauthResource,
				oauthResourceIsFallback,
			}));
			setStatus({ kind: "oauth-health", result: "checking" });
			let healthPassed = true;
			let healthError: string | undefined;
			if (callbacks.onTestConnection) {
				const deadline = Promise.withResolvers<never>();
				const timer = setTimeout(
					() => deadline.reject(new Error("Health check timed out after 10 seconds")),
					10_000,
				);
				cancelHealthDeadline = (): void => {
					clearTimeout(timer);
					deadline.reject(new Error("Health check cancelled"));
				};
				try {
					await Promise.race([callbacks.onTestConnection(buildConfig(true, true)), deadline.promise]);
				} catch (reason) {
					healthPassed = false;
					healthError = sanitize(errorFrom(reason).message);
				} finally {
					clearTimeout(timer);
					cancelHealthDeadline = undefined;
				}
			}
			if (!isCurrent(candidate)) return;
			setStatus(
				healthPassed
					? { kind: "oauth-health", result: "passed" }
					: { kind: "oauth-health", result: "failed", error: healthError },
			);
			schedule(candidate, healthPassed ? 1000 : 2000, () => moveToScope(candidate));
		} catch (reason) {
			if (!isCurrent(candidate)) return;
			const failure = errorFrom(reason);
			const errorMessage = sanitize(failure.message);
			const cancelled = failure.name === "MCPOAuthCancelledError";
			const lines: OAuthErrorLine[] = [{ text: errorMessage, muted: false }];
			if (cancelled) lines.push({ text: "Tip: Choose Retry to launch the browser again.", muted: true });
			else if (errorMessage.includes("timeout") || errorMessage.includes("timed out"))
				lines.push({ text: "Tip: Complete authorization faster next time", muted: true });
			else if (errorMessage.includes("Invalid OAuth URLs"))
				lines.push({ text: "Tip: Check that the OAuth URLs are correct", muted: true });
			else if (errorMessage.includes("ECONNREFUSED"))
				lines.push({ text: "Tip: Verify the OAuth server is accessible", muted: true });
			setSelectedIndex(0);
			setStep("oauth-error");
			setStatus({
				kind: "oauth-error",
				heading: cancelled ? "○ OAuth cancelled" : "✗ OAuth authentication failed",
				tone: cancelled ? "muted" : "error",
				lines,
			});
		} finally {
			if (oauthAbort === abort) oauthAbort = undefined;
		}
	};

	const testConnectionAndDetectAuth = async (): Promise<void> => {
		const candidate = beginAsync();
		if (!callbacks.onTestConnection) {
			moveToScope(candidate);
			return;
		}
		try {
			await callbacks.onTestConnection(buildConfig(false, true));
			if (!isCurrent(candidate)) return;
			setStatus({ kind: "connection-success" });
			schedule(candidate, 1000, () => {
				setState(previous => ({ ...previous, authMethod: "none" }));
				moveToScope(candidate);
			});
		} catch (reason) {
			if (!isCurrent(candidate)) return;
			const failure = errorFrom(reason);
			const auth = deps.analyzeAuthError(failure, state().url);
			if (!auth.requiresAuth) {
				setStatus({ kind: "connection-failure", error: sanitize(failure.message) });
				schedule(candidate, 2000, () => {
					setState(previous => ({ ...previous, authMethod: "none" }));
					moveToScope(candidate);
				});
				return;
			}
			let oauth = auth.authType === "oauth" ? (auth.oauth ?? null) : null;
			if (!oauth && state().transport !== "stdio" && state().url) {
				try {
					oauth = await deps.discoverOAuthEndpoints(state().url, auth.authServerUrl, auth.resourceMetadataUrl, {
						protectedScopes: auth.scopes,
					});
				} catch {
					oauth = null;
				}
			}
			if (!isCurrent(candidate)) return;
			if (oauth && !oauth.scopes && auth.resourceMetadataUrl) {
				try {
					const scopes = await deps.fetchResourceMetadataScopes(auth.resourceMetadataUrl);
					if (scopes) oauth = { ...oauth, scopes };
				} catch {
					// Discovery metadata is optional; the detected endpoints remain usable.
				}
			}
			if (!isCurrent(candidate)) return;
			if (oauth) {
				const current = state();
				setState(previous => ({
					...previous,
					authMethod: "oauth",
					oauthAuthUrl: oauth.authorizationUrl,
					oauthTokenUrl: oauth.tokenUrl,
					oauthRegistrationUrl: oauth.registrationUrl || "",
					oauthIssuerUrl: oauth.issuerUrl || "",
					oauthClientId: oauth.clientId || "",
					oauthScopes: oauth.scopes || "",
					oauthResource: oauth.resource || (current.transport === "stdio" ? "" : current.url),
					oauthResourceIsFallback: !oauth.resource && current.transport !== "stdio",
				}));
				setStatus({ kind: "oauth-detected" });
				void launchOAuthFlow();
				return;
			}
			setState(previous => ({ ...previous, authMethod: "manual" }));
			moveTo("apikey");
		}
	};

	const submit = (): void => {
		if (disposed) return;
		const currentStep = step();
		const value = inputValueFor(currentStep, state()).trim();
		setError(undefined);
		switch (currentStep) {
			case "name": {
				const validation = deps.validateServerName(value);
				if (validation) {
					setError(validation);
					return;
				}
				setState(previous => ({ ...previous, name: value }));
				moveTo("transport", 0);
				return;
			}
			case "command":
				if (!value) {
					setError("Enter a command");
					return;
				}
				setState(previous => ({ ...previous, command: value }));
				moveTo("args");
				return;
			case "args":
				setState(previous => ({ ...previous, args: value }));
				void testConnectionAndDetectAuth();
				return;
			case "url": {
				if (!value) {
					setError("URL is required");
					return;
				}
				let url: URL;
				try {
					url = new URL(value);
				} catch {
					setError("Invalid URL format (must start with http:// or https://)");
					return;
				}
				if (url.protocol !== "http:" && url.protocol !== "https:") {
					setError("URL must use http:// or https:// scheme");
					return;
				}
				setState(previous => ({ ...previous, url: value }));
				void testConnectionAndDetectAuth();
				return;
			}
			case "oauth-auth-url":
				if (!value) {
					setError("Enter an authorization URL");
					return;
				}
				setState(previous => ({ ...previous, oauthAuthUrl: value }));
				moveTo("oauth-token-url");
				return;
			case "oauth-token-url":
				if (!value) {
					setError("Enter a token URL");
					return;
				}
				setState(previous => ({ ...previous, oauthTokenUrl: value }));
				moveTo("oauth-client-id");
				return;
			case "oauth-client-id":
				if (!value) {
					setError("Enter a client ID");
					return;
				}
				setState(previous => ({ ...previous, oauthClientId: value }));
				moveTo("oauth-client-secret");
				return;
			case "oauth-client-secret":
				setState(previous => ({ ...previous, oauthClientSecret: value }));
				moveTo("oauth-scopes");
				return;
			case "oauth-scopes":
				setState(previous => ({ ...previous, oauthScopes: value }));
				void launchOAuthFlow();
				return;
			case "apikey":
				if (!value) {
					setError("Enter an API key");
					return;
				}
				setState(previous => ({ ...previous, authMethod: "manual", apiKey: value }));
				if (state().transport === "stdio") moveTo("env-var-name");
				else moveTo("auth-location", 0);
				return;
			case "env-var-name":
				if (!value) {
					setError("Enter a variable name");
					return;
				}
				setState(previous => ({ ...previous, envVarName: value, authLocation: "env" }));
				moveTo("scope", 0);
				return;
			case "header-name":
				if (!value) {
					setError("Enter a header name");
					return;
				}
				setState(previous => ({ ...previous, headerName: value, authLocation: "header" }));
				moveTo("scope", 0);
				return;
			default:
				return;
		}
	};

	const complete = (): void => {
		const current = state();
		if (!current.scope || disposed) return;
		callbacks.onComplete(current.name, buildConfig(true, false), current.scope);
	};

	const chooseCurrent = (): void => {
		if (disposed) return;
		switch (step()) {
			case "transport": {
				const transport: TransportType = selectedIndex() === 0 ? "stdio" : selectedIndex() === 1 ? "http" : "sse";
				setState(previous => ({ ...previous, transport }));
				moveTo(transport === "stdio" ? "command" : "url");
				return;
			}
			case "auth-method":
				if (selectedIndex() === 0) {
					setState(previous => ({ ...previous, authMethod: "oauth" }));
					moveTo("oauth-auth-url");
				} else {
					setState(previous => ({ ...previous, authMethod: "manual" }));
					moveTo("apikey");
				}
				return;
			case "oauth-error":
				if (selectedIndex() === 0) void launchOAuthFlow();
				else moveTo("oauth-auth-url");
				return;
			case "auth-location":
				if (selectedIndex() === 0) {
					setState(previous => ({ ...previous, authLocation: "env" }));
					moveTo("env-var-name");
				} else {
					setState(previous => ({ ...previous, authLocation: "header" }));
					moveTo("header-name");
				}
				return;
			case "scope":
				setState(previous => ({ ...previous, scope: selectedIndex() === 0 ? "user" : "project" }));
				moveTo("confirm", 0);
				return;
			case "confirm":
				if (selectedIndex() === 0) complete();
				else moveTo("scope", state().scope === "user" ? 0 : 1);
				return;
			default:
				return;
		}
	};

	const goBack = (): void => {
		if (disposed) return;
		invalidateAsync(false);
		const current = state();
		switch (step()) {
			case "transport":
				moveTo("name");
				return;
			case "command":
			case "url":
				moveTo("transport", current.transport === "stdio" ? 0 : current.transport === "http" ? 1 : 2);
				return;
			case "args":
				moveTo("command");
				return;
			case "auth-method":
				moveTo(current.transport === "stdio" ? "args" : "url");
				return;
			case "oauth-auth-url":
			case "apikey":
				moveTo(current.transport === "stdio" ? "args" : "url");
				return;
			case "auth-location":
				moveTo("apikey");
				return;
			case "env-var-name":
			case "header-name":
				if (current.transport === "stdio") moveTo("apikey");
				else moveTo("auth-location", current.authLocation === "env" ? 0 : 1);
				return;
			case "oauth-token-url":
				moveTo("oauth-auth-url");
				return;
			case "oauth-client-id":
				moveTo("oauth-token-url");
				return;
			case "oauth-client-secret":
				moveTo("oauth-client-id");
				return;
			case "oauth-scopes":
				moveTo("oauth-client-secret");
				return;
			case "oauth-error":
				moveTo("oauth-auth-url");
				return;
			case "scope":
				if (current.authMethod === "oauth") moveTo("oauth-scopes");
				else if (current.authMethod === "manual")
					moveTo(current.authLocation === "env" ? "env-var-name" : "header-name");
				else moveTo(current.transport === "stdio" ? "args" : "url");
				return;
			case "confirm":
				moveTo("scope", current.scope === "user" ? 0 : 1);
				return;
			default:
				return;
		}
	};

	const escapeInput = (): void => {
		if (step() === "name") {
			invalidateAsync(true);
			callbacks.onCancel();
			return;
		}
		goBack();
	};

	return {
		step,
		state,
		error,
		selectedIndex,
		status,
		updateInput,
		submit,
		escapeInput,
		handleInput(data): void {
			if (disposed) return;
			if (oauthAbort && (data === "\x03" || matchesAppInterrupt(data))) {
				oauthAbort.abort("MCP OAuth flow cancelled by user");
				return;
			}
			if (data === "\x03") {
				invalidateAsync(true);
				callbacks.onCancel();
				return;
			}
			if (matchesAppInterrupt(data)) {
				escapeInput();
				return;
			}
			if (inputStepFor(step())) {
				if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
					submit();
					return;
				}
				if (matchesKey(data, "backspace")) {
					updateInput(Array.from(inputValueFor(step(), state())).slice(0, -1).join(""));
					return;
				}
				const printable = extractPrintableText(data);
				if (printable) updateInput(inputValueFor(step(), state()) + printable);
				return;
			}
			if (status() && status()!.kind !== "oauth-error") return;
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				chooseCurrent();
				return;
			}
			if (matchesSelectUp(data)) {
				const choices = choiceStepFor(step())?.choices.length ?? 0;
				if (choices) setSelectedIndex(index => (index - 1 + choices) % choices);
				return;
			}
			if (matchesSelectDown(data)) {
				const choices = choiceStepFor(step())?.choices.length ?? 0;
				if (choices) setSelectedIndex(index => (index + 1) % choices);
			}
		},
		cancel(): void {
			if (disposed) return;
			invalidateAsync(true);
			callbacks.onCancel();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			invalidateAsync(true);
		},
	};
}

interface InputStepViewProps {
	readonly controller: MCPAddWizardController;
	readonly details: InputStep;
}

function InputStepView(props: InputStepViewProps): JSX.Element {
	const value = (): string => inputValueFor(props.controller.step(), props.controller.state());
	return (
		<stack gap={1}>
			<text color="accent" wrap="word">
				{props.details.heading}
			</text>
			<stack>
				<text wrap="word">{props.details.prompt}</text>
				<For each={props.details.details ?? []}>
					{detail => (
						<text color="muted" wrap="word">
							{detail}
						</text>
					)}
				</For>
				<br />
				<input
					value={value()}
					prompt="> "
					mask={props.details.mask}
					onChange={props.controller.updateInput}
					onSubmit={props.controller.submit}
					onEscape={props.controller.escapeInput}
				/>
				<br />
				{props.controller.error() ? (
					<stack>
						<text color="error" wrap="word">
							✗ {sanitize(props.controller.error() ?? "")}
						</text>
						<br />
					</stack>
				) : null}
				<text color="muted" wrap="word">
					{props.details.hint}
				</text>
			</stack>
		</stack>
	);
}

interface ChoiceListViewProps {
	readonly choices: readonly WizardChoiceOption[];
	readonly selectedIndex: number;
}

function ChoiceListView(props: ChoiceListViewProps): JSX.Element {
	return (
		<stack>
			<For each={props.choices}>
				{(choice, index) => {
					const selected = (): boolean => index() === props.selectedIndex;
					return (
						<stack>
							<text wrap="word">
								{selected() ? (
									<span color="accent">
										{theme.nav.cursor} {choice.label}
									</span>
								) : (
									<>
										{"  "}
										{choice.label}
									</>
								)}
							</text>
							{choice.description && !selected() ? (
								<rail prefix="    " rest="    ">
									<text color="dim" wrap="word">
										{choice.description}
									</text>
								</rail>
							) : null}
						</stack>
					);
				}}
			</For>
		</stack>
	);
}

interface ChoiceStepViewProps {
	readonly controller: MCPAddWizardController;
	readonly details: ChoiceStep;
	readonly intro?: JSX.Element;
}

function ChoiceStepView(props: ChoiceStepViewProps): JSX.Element {
	return (
		<stack gap={1}>
			<text color={props.details.tone ?? "accent"} wrap="word">
				{props.details.heading}
			</text>
			{props.intro}
			<ChoiceListView choices={props.details.choices} selectedIndex={props.controller.selectedIndex()} />
			<text color="muted" wrap="word">
				{props.details.hint}
			</text>
		</stack>
	);
}

function ConfirmationSummary(props: { readonly state: Readonly<WizardState> }): JSX.Element {
	const state = props.state;
	const scope = state.scope === "user" ? "User level" : "Project level";
	return (
		<stack>
			<text wrap="word">
				Name: <span color="accent">{state.name}</span>
			</text>
			<text wrap="word">Type: {state.transport}</text>
			{state.transport === "stdio" ? (
				<>
					<text wrap="word">Command: {state.command}</text>
					{state.args ? <text wrap="word">Args: {state.args}</text> : null}
				</>
			) : (
				<text wrap="word">URL: {sanitize(state.url)}</text>
			)}
			{state.authMethod === "none" ? (
				<text wrap="word">Auth: None</text>
			) : state.authMethod === "oauth" ? (
				<text wrap="word">Auth: OAuth (authenticated)</text>
			) : state.authLocation === "env" ? (
				<text wrap="word">Auth: API key via env ({state.envVarName})</text>
			) : (
				<text wrap="word">Auth: API key via header ({state.headerName})</text>
			)}
			<text wrap="word">Scope: {scope}</text>
			<br />
			<text wrap="word">Save this configuration?</text>
		</stack>
	);
}

function OAuthErrorSummary(props: {
	readonly status: Extract<MCPAddWizardAsyncStatus, { readonly kind: "oauth-error" }>;
}): JSX.Element {
	return (
		<stack>
			<For each={props.status.lines}>
				{line => (
					<>
						<text color={line.muted ? "muted" : undefined} wrap="word">
							{line.text}
						</text>
						<br />
					</>
				)}
			</For>
			<text wrap="word">Choose next action:</text>
		</stack>
	);
}

function AsyncStatusView(props: { readonly status: MCPAddWizardAsyncStatus }): JSX.Element {
	const now = useClock("spinner");
	const spinner = createMemo(() => {
		const frames = theme.spinnerFrames;
		return frames.length > 0 ? (frames[Math.floor(now() / 80) % frames.length] ?? "|") : theme.status.pending;
	});
	const body = (): JSX.Element => {
		switch (props.status.kind) {
			case "connection-success":
				return <text wrap="word">No authentication required</text>;
			case "connection-failure":
				return (
					<stack>
						<text wrap="word">{props.status.error}</text>
						<br />
						<text color="muted" wrap="word">
							Adding server anyway...
						</text>
					</stack>
				);
			case "oauth-detected":
				return <text wrap="word">Launching browser for authorization...</text>;
			case "oauth-unavailable":
				return <text wrap="word">OAuth login cannot start without a host OAuth handler.</text>;
			case "oauth-incomplete":
				return <text wrap="word">Authorization and Token URLs are required.</text>;
			case "oauth-authenticating":
				return (
					<stack>
						<text wrap="word">Launching OAuth flow...</text>
						<text color="muted" wrap="word">
							Browser will open automatically.
						</text>
						<br />
						<text color="warning" wrap="word">
							If browser doesn't open, copy the URL from chat.
						</text>
					</stack>
				);
			case "oauth-health":
				return (
					<stack>
						<text color="muted" wrap="word">
							Running connection health check...
						</text>
						<text
							color={
								props.status.result === "passed"
									? "success"
									: props.status.result === "failed"
										? "warning"
										: "muted"
							}
							wrap="word"
						>
							{props.status.result === "checking"
								? `${spinner()} Checking server connection...`
								: props.status.result === "passed"
									? "✓ Health check passed"
									: "⚠ Health check failed (will still save config)"}
						</text>
						{props.status.error ? (
							<>
								<br />
								<text color="muted" wrap="word">
									{props.status.error}
								</text>
							</>
						) : null}
					</stack>
				);
			case "oauth-error":
				return <OAuthErrorSummary status={props.status} />;
		}
	};
	const heading = (): { text: string; tone: StatusTone } => {
		switch (props.status.kind) {
			case "connection-success":
				return { text: "✓ Connection successful!", tone: "success" };
			case "connection-failure":
				return { text: "✗ Connection failed", tone: "error" };
			case "oauth-detected":
				return { text: "✓ OAuth detected", tone: "success" };
			case "oauth-unavailable":
				return { text: "OAuth flow not available", tone: "error" };
			case "oauth-incomplete":
				return { text: "OAuth configuration incomplete", tone: "error" };
			case "oauth-authenticating":
				return { text: "OAuth Authentication", tone: "accent" };
			case "oauth-health":
				return { text: "✓ Authentication successful!", tone: "success" };
			case "oauth-error":
				return { text: props.status.heading, tone: props.status.tone };
		}
	};
	const footer = (): JSX.Element | undefined =>
		props.status.kind === "oauth-authenticating" ? (
			<text color="muted" wrap="word">
				(Press Esc to cancel)
			</text>
		) : props.status.kind === "oauth-incomplete" ? (
			<text color="muted" wrap="word">
				[Press Esc to go back]
			</text>
		) : undefined;
	return (
		<stack gap={1}>
			<text color={heading().tone} wrap="word">
				{heading().text}
			</text>
			{body()}
			{footer()}
		</stack>
	);
}

export interface MCPAddWizardViewProps {
	readonly controller: MCPAddWizardController;
}

export function MCPAddWizardView(props: MCPAddWizardViewProps): JSX.Element {
	const input = createMemo(() => inputStepFor(props.controller.step()));
	const choice = createMemo(() => choiceStepFor(props.controller.step()));
	const handleKey = (event: HostKeyEvent): void => {
		if (event.defaultPrevented) return;
		props.controller.handleInput(event.data);
		event.preventDefault();
		event.stopPropagation();
	};
	const content = (): JSX.Element => {
		const currentInput = input();
		if (currentInput) return <InputStepView controller={props.controller} details={currentInput} />;
		const currentChoice = choice();
		if (currentChoice) {
			const currentStep = props.controller.step();
			const currentState = props.controller.state();
			const currentStatus = props.controller.status();
			const intro =
				currentStep === "transport" ? (
					<text wrap="word">Select the transport type:</text>
				) : currentStep === "confirm" ? (
					<ConfirmationSummary state={currentState} />
				) : currentStep === "oauth-error" && currentStatus?.kind === "oauth-error" ? (
					<OAuthErrorSummary status={currentStatus} />
				) : undefined;
			const details =
				currentStep === "oauth-error" && currentStatus?.kind === "oauth-error"
					? {
							...currentChoice,
							heading: currentStatus.heading,
							tone: currentStatus.tone,
							choices: [{ label: "Retry OAuth authentication" }, { label: "Edit OAuth settings" }],
						}
					: currentChoice;
			return <ChoiceStepView controller={props.controller} details={details} intro={intro} />;
		}
		const currentStatus = props.controller.status();
		return currentStatus ? <AsyncStatusView status={currentStatus} /> : <stack />;
	};
	return (
		<frame title="Add MCP Server" paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<br />
			<box tabIndex={0} onKey={handleKey}>
				{content()}
			</box>
			<br />
		</frame>
	);
}

export interface MCPAddWizardOverlayProps {
	readonly deps: MCPAddWizardDeps;
	readonly callbacks: MCPAddWizardCallbacks;
	readonly initialName?: string;
}

export interface MCPAddWizardHandle extends OverlayDisposer, MCPAddWizardController {}

export function openMCPAddWizardOverlay(tui: TUI, props: MCPAddWizardOverlayProps): MCPAddWizardHandle {
	const controller = createMcpAddWizardController(props.deps, props.callbacks, props.initialName);
	const overlay = mountOverlay(tui, () => (
		<Portal to="overlay" anchor="bottom-center" width="100%">
			<MCPAddWizardView controller={controller} />
		</Portal>
	));
	return Object.assign(overlay, controller, {
		dispose(): void {
			controller.dispose();
			overlay.dispose();
		},
	});
}
