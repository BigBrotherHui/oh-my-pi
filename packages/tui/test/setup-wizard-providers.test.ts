import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { dispatchKey, dispatchMouse, HostKeyEvent, HostMouseEvent } from "../src/host/input";
import { ProvidersSceneView, type ProvidersSceneContext } from "@oh-my-pi/pi-tui/setup/scenes/providers";
import { mountForTest, type TestRoot } from "../src/testing";
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
		readonly completed?: ("done" | "skipped")[];
		readonly saved?: string[];
	} = {},
): ProvidersSceneContext {
	return {
		host: {
			authStorage,
			captureBrowserSession: async () => "",
			copyToClipboard: async () => {},
			disabledProviders: [],
			isSearchProviderAvailable: async () => false,
			openInBrowser: () => {},
			refreshProvider: async () => {},
			saveWebSearchSelection: id => {
				options.saved?.push(id);
			},
			webSearchSelection: "auto",
		},
		complete: result => {
			options.completed?.push(result);
		},
		availableRows: options.rows,
	};
}

function press(root: TestRoot, data: string): void {
	dispatchKey(root.root, new HostKeyEvent(data));
	root.flush();
}
function semanticText(root: TestRoot): string {
	return root.text().join(" ").replace(/\s+/g, " ").trim();
}

function selectFirstAvailableProvider(root: TestRoot): void {
	const index = getOAuthProviders().findIndex(provider => provider.available);
	if (index < 0) throw new Error("Expected an available OAuth provider");
	for (let step = 0; step < index; step++) press(root, "\x1b[B");
	press(root, "\n");
}

describe("ProvidersSceneView", () => {
	it("preserves the historical tab strip, keyboard cycle, and narrow mouse hit targets", () => {
		const fixture = createStorage();
		const wide = mountForTest(() => ProvidersSceneView(createContext(fixture.storage, { rows: () => 21 })), {
			width: 72,
			height: 24,
		});
		const narrow = mountForTest(() => ProvidersSceneView(createContext(fixture.storage, { rows: () => 28 })), {
			width: 20,
			height: 24,
		});
		try {
			expect(wide.text().join("\n")).toContain("Providers:   Sign in    Web search   (tab to cycle)");
			expect(wide.text().join("\n")).toContain("Pick a provider to sign in — you can connect more than one.");

			press(wide, "\t");
			expect(wide.text().join("\n")).toContain("Choose the provider the web_search tool should prefer.");
			press(wide, "\x1b[Z");
			expect(wide.text().join("\n")).toContain("Select provider to login");

			narrow.text();
			dispatchMouse(narrow.root, new HostMouseEvent({ row: 2, col: 1, action: "down" }));
			narrow.flush();
			expect(semanticText(narrow)).toContain("Choose the provider the web_search tool should prefer.");
		} finally {
			wide.dispose();
			narrow.dispose();
			fixture.close();
		}
	});

	it("does not leave the sign-in tab while OAuth owns input", async () => {
		const fixture = createStorage();
		const aborted = Promise.withResolvers<void>();
		fixture.storage.login = async (_provider, callbacks) => {
			await new Promise<void>(resolve => {
				callbacks.signal?.addEventListener(
					"abort",
					() => {
						aborted.resolve();
						resolve();
					},
					{ once: true },
				);
			});
		};
		const root = mountForTest(() => ProvidersSceneView(createContext(fixture.storage, { rows: () => 21 })), {
			width: 72,
			height: 24,
		});
		try {
			root.flush();
			selectFirstAvailableProvider(root);
			expect(root.text().join("\n")).toContain("Signing in to");
			press(root, "\t");
			expect(root.text().join("\n")).toContain("Signing in to");
			expect(root.text().join("\n")).not.toContain("Choose the provider the web_search tool should prefer.");
		} finally {
			root.dispose();
			await aborted.promise;
			fixture.close();
		}
	});

	it("keeps completed sign-in feedback when returning from web search", async () => {
		const fixture = createStorage();
		let selectedProvider = "";
		fixture.storage.login = async provider => {
			selectedProvider = provider;
		};
		const root = mountForTest(() => ProvidersSceneView(createContext(fixture.storage, { rows: () => 21 })), {
			width: 72,
			height: 24,
		});
		try {
			root.flush();
			selectFirstAvailableProvider(root);
			await Promise.resolve();
			await Promise.resolve();
			root.flush();
			expect(root.text().join("\n")).toContain(`Signed in to ${selectedProvider}`);

			press(root, "\t");
			expect(root.text().join("\n")).toContain("Choose the provider the web_search tool should prefer.");
			press(root, "\x1b[Z");
			expect(root.text().join("\n")).toContain(`Signed in to ${selectedProvider}`);
		} finally {
			root.dispose();
			fixture.close();
		}
	});
});
