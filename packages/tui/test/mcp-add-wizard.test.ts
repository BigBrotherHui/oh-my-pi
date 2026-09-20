import { describe, expect, it } from "bun:test";
import {
	createMcpAddWizardController,
	type MCPAddWizardCallbacks,
	type MCPAddWizardDeps,
} from "../src/overlays/mcp-add-wizard";

const noAuthDeps: MCPAddWizardDeps = {
	validateServerName: () => undefined,
	analyzeAuthError: () => ({ requiresAuth: false }),
	async discoverOAuthEndpoints() {
		return null;
	},
	async fetchResourceMetadataScopes() {
		return undefined;
	},
};

function callbacks(overrides: Partial<MCPAddWizardCallbacks> = {}): MCPAddWizardCallbacks {
	return { onComplete() {}, onCancel() {}, ...overrides };
}

describe("MCP add wizard", () => {
	it("starts at transport with a trimmed supplied server name", () => {
		const controller = createMcpAddWizardController(noAuthDeps, callbacks(), " filesystem ");

		expect(controller.step()).toBe("transport");
		expect(controller.state().name).toBe("filesystem");
		controller.dispose();
	});

	it("saves manual stdio authentication after an authentication challenge", async () => {
		let completion: readonly [string, unknown, string] | undefined;
		const authenticationDetected = Promise.withResolvers<void>();
		const controller = createMcpAddWizardController(
			{
				...noAuthDeps,
				analyzeAuthError: () => {
					authenticationDetected.resolve();
					return { requiresAuth: true, authType: "apikey" };
				},
			},
			callbacks({
				async onTestConnection() {
					throw new Error("authentication required");
				},
				onComplete(name, config, scope) {
					completion = [name, config, scope];
				},
			}),
		);

		controller.updateInput("filesystem");
		controller.submit();
		controller.handleInput("\n");
		controller.updateInput("npx");
		controller.submit();
		controller.updateInput("-y @modelcontextprotocol/server-filesystem /tmp");
		controller.submit();
		await authenticationDetected.promise;
		expect(controller.step()).toBe("apikey");

		controller.updateInput("secret");
		controller.submit();
		controller.updateInput("MCP_TOKEN");
		controller.submit();
		controller.handleInput("\n");
		controller.handleInput("\n");

		expect(completion).toEqual([
			"filesystem",
			{
				type: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
				env: { MCP_TOKEN: "secret" },
			},
			"user",
		]);
		controller.dispose();
	});

	it("aborts an in-flight OAuth browser flow and offers a retry", async () => {
		let aborted = false;
		const oauthStarted = Promise.withResolvers<void>();
		const oauthResult = Promise.withResolvers<{ credentialId: string }>();
		const oauthCancelled = Promise.withResolvers<void>();
		const controller = createMcpAddWizardController(
			{
				...noAuthDeps,
				analyzeAuthError: () => ({
					requiresAuth: true,
					authType: "oauth",
					oauth: { authorizationUrl: "https://login.example/authorize", tokenUrl: "https://login.example/token" },
				}),
			},
			callbacks({
				async onTestConnection() {
					throw new Error("authentication required");
				},
				onOAuth(_authorizationUrl, _tokenUrl, _clientId, _clientSecret, _scopes, options) {
					oauthStarted.resolve();
					options?.abortSignal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							const cancellation = new Error("OAuth cancelled by user");
							cancellation.name = "MCPOAuthCancelledError";
							oauthResult.reject(cancellation);
							oauthCancelled.resolve();
						},
						{ once: true },
					);
					return oauthResult.promise;
				},
			}),
		);

		controller.updateInput("filesystem");
		controller.submit();
		controller.handleInput("\n");
		controller.updateInput("npx");
		controller.submit();
		controller.submit();
		await oauthStarted.promise;
		expect(controller.status()?.kind).toBe("oauth-authenticating");

		controller.handleInput("\x1b");
		await oauthCancelled.promise;
		expect(aborted).toBe(true);
		expect(controller.status()).toMatchObject({ kind: "oauth-error", heading: "○ OAuth cancelled" });
		controller.dispose();
	});
});
