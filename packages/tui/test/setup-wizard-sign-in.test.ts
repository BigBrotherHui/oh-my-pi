import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { dispatchKey, HostKeyEvent } from "../src/host/input";
import { mountForTest, type TestRoot } from "../src/testing";
import { SignInSceneView, type SignInSceneContext } from "@oh-my-pi/pi-tui/setup/scenes/sign-in";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

function createStorage(): { readonly storage: AuthStorage; close(): void } {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	return {
		storage: new AuthStorage(store),
		close(): void {
			store.close();
		},
	};
}

function createContext(
	authStorage: AuthStorage,
	options: {
		readonly rows?: () => number;
		readonly copied?: string[];
		readonly opened?: string[];
		readonly completed?: SetupComplete[];
		readonly refreshProvider?: (provider: string) => Promise<void>;
	} = {},
): SignInSceneContext {
	return {
		host: {
			authStorage,
			disabledProviders: [],
			captureBrowserSession: async () => "",
			copyToClipboard: async text => {
				options.copied?.push(text);
			},
			openInBrowser(url): void {
				options.opened?.push(url);
			},
			refreshProvider: options.refreshProvider ?? (async () => {}),
		},
		complete(result): void {
			options.completed?.push(result);
		},
		availableRows: options.rows,
	};
}

type SetupComplete = "done" | "skipped";

function press(root: TestRoot, data: string): void {
	dispatchKey(root.root, new HostKeyEvent(data));
	root.flush();
}

async function waitForRenderedText(root: TestRoot, expected: string): Promise<string> {
	for (let attempt = 0; attempt < 16; attempt++) {
		const text = root.text().join("\n");
		if (text.includes(expected)) return text;
		await Promise.resolve();
	}
	throw new Error(`Expected rendered sign-in state to contain ${expected}`);
}

function selectFirstAvailableProvider(root: TestRoot): void {
	const index = getOAuthProviders().findIndex(provider => provider.available);
	if (index < 0) throw new Error("Expected an available OAuth provider");
	for (let step = 0; step < index; step++) press(root, "\x1b[B");
	press(root, "\n");
}

describe("SignInSceneView", () => {
	it("keeps the original compact selector budget and expanded sign-in introduction", () => {
		const fixture = createStorage();
		const expanded = mountForTest(() => SignInSceneView(createContext(fixture.storage, { rows: () => 19 })), {
			width: 72,
			height: 24,
		});
		const compact = mountForTest(() => SignInSceneView(createContext(fixture.storage, { rows: () => 18 })), {
			width: 72,
			height: 24,
		});
		try {
			expect(expanded.text().join("\n")).toContain("Pick a provider to sign in — you can connect more than one.");
			expect(compact.text().join("\n")).not.toContain("Pick a provider to sign in — you can connect more than one.");
			expect(compact.text().join("\n")).toContain("Select provider to login");
		} finally {
			expanded.dispose();
			compact.dispose();
			fixture.close();
		}
	});

	it("masks prompt input, keeps the complete login URL around the prompt, and copies through both shortcuts", async () => {
		const fixture = createStorage();
		const loginGate = Promise.withResolvers<void>();
		const secretReceived = Promise.withResolvers<string>();
		const loginFinished = Promise.withResolvers<void>();
		const copied: string[] = [];
		const opened: string[] = [];
		const url = `https://example.com/oauth/authorize?client_id=omp&redirect_uri=http%3A%2F%2Flocalhost%3A45454%2Fcallback&state=${"a".repeat(96)}`;
		const secretValue = crypto.randomUUID();
		let selectedProvider = "";
		fixture.storage.login = async (provider, callbacks) => {
			selectedProvider = provider;
			callbacks.onProgress?.("Resolving OAuth endpoints…");
			callbacks.onAuth({ url, instructions: "Finish sign-in in the browser." });
			try {
				secretReceived.resolve(
					await callbacks.onPrompt({ message: "Consumer key", placeholder: "secret value", secret: true }),
				);
				await loginGate.promise;
				return undefined;
			} finally {
				loginFinished.resolve();
			}
		};
		const root = mountForTest(() => SignInSceneView(createContext(fixture.storage, { copied, opened })), {
			width: 120,
			height: 24,
		});
		try {
			root.flush();
			selectFirstAvailableProvider(root);
			await Promise.resolve();

			press(root, secretValue);
			const masked = root.text().join("\n");
			expect(masked).not.toContain(secretValue);
			press(root, "\n");
			await expect(secretReceived.promise).resolves.toBe(secretValue);

			const compact = root.text(36).join("");
			expect(compact).toContain(url);
			expect(compact).not.toContain("…");
			expect(root.text().join("\n")).toContain(`Signing in to ${selectedProvider}`);
			expect(root.text().join("\n")).toContain(
				"Browser login: Open login URL (clipboard copy attempted; Alt+C retries)",
			);
			expect(root.rows().join("\n")).toContain(`\x1b]8;;${url}\x07Open login URL\x1b]8;;\x07`);
			expect(opened).toEqual([url]);

			press(root, "\x1bc");
			await Promise.resolve();
			press(root, "c");
			await Promise.resolve();
			expect(copied).toEqual([url, url, url]);
		} finally {
			root.dispose();
			loginGate.resolve();
			await loginFinished.promise;
			fixture.close();
		}
	});

	it("removes an aborted manual-code prompt and restores the completed sign-in status", async () => {
		const fixture = createStorage();
		const nativeSettled = Promise.withResolvers<void>();
		const refreshStarted = Promise.withResolvers<string>();
		const releaseRefresh = Promise.withResolvers<void>();
		let selectedProvider = "";
		fixture.storage.login = async (provider, callbacks) => {
			selectedProvider = provider;
			callbacks.onAuth({ url: "https://example.com/oauth/authorize?state=native" });
			const nativeCallback = new AbortController();
			const prompt = callbacks.onManualCodeInput?.(nativeCallback.signal);
			nativeCallback.abort(new Error("Native callback received"));
			await prompt?.catch(() => "");
			nativeSettled.resolve();
			return undefined;
		};
		const root = mountForTest(
			() =>
				SignInSceneView(
					createContext(fixture.storage, {
						refreshProvider: async provider => {
							refreshStarted.resolve(provider);
							await releaseRefresh.promise;
						},
					}),
				),
			{ width: 80, height: 24 },
		);
		try {
			root.flush();
			selectFirstAvailableProvider(root);
			await nativeSettled.promise;
			await expect(refreshStarted.promise).resolves.toBe(selectedProvider);
			releaseRefresh.resolve();
			const completed = await waitForRenderedText(root, `Signed in to ${selectedProvider}`);
			expect(completed).not.toContain("Paste the authorization code");
		} finally {
			root.dispose();
			fixture.close();
		}
	});

	it("surfaces the historical retry guidance after a failed login", async () => {
		const fixture = createStorage();
		fixture.storage.login = async () => {
			throw new Error("network offline");
		};
		const root = mountForTest(() => SignInSceneView(createContext(fixture.storage)), { width: 80, height: 24 });
		try {
			root.flush();
			selectFirstAvailableProvider(root);
			await Promise.resolve();
			await Promise.resolve();
			const rendered = root.text().join("\n");
			expect(rendered).toContain("Login failed: network offline");
			expect(rendered).toContain("Choose another provider or press Esc to continue.");
			expect(rendered).not.toContain("Open login URL");
		} finally {
			root.dispose();
			fixture.close();
		}
	});
});
