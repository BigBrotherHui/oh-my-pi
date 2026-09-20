import { describe, expect, it } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { OAuthSelector, type OAuthSelectorAuthSource } from "@oh-my-pi/pi-tui/overlays/oauth-selector";
import { dispatchHostInput } from "@oh-my-pi/pi-tui/overlay";
import { mountForTest } from "@oh-my-pi/pi-tui/testing";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const noCredentials: OAuthSelectorAuthSource = {
	has() {
		return false;
	},
	hasAuth() {
		return false;
	},
	getCredentialOrigin() {
		return undefined;
	},
};

describe("OAuthSelector", () => {
	it("fuzzy-filters overflowing providers and activates the matching login", () => {
		const providers = getOAuthProviders();
		expect(providers.length).toBeGreaterThan(10);
		const target =
			providers.find(provider => provider.available && provider.id === "vllm") ??
			providers.find(provider => provider.available) ??
			providers[0];
		expect(target).toBeDefined();
		if (!target) return;

		const selected: string[] = [];
		const mounted = mountForTest(() =>
			OAuthSelector({
				inline: true,
				mode: "login",
				authStorage: noCredentials,
				onSelect: providerId => selected.push(providerId),
				onCancel() {},
			}),
		);
		try {
			mounted.rows();
			for (const character of target.id) dispatchHostInput(mounted.root, character);
			const rendered = mounted.rows().map(Bun.stripANSI).join("\n");
			expect(rendered).toContain(target.name);
			expect(rendered).toContain(`Search: ${target.id}`);

			dispatchHostInput(mounted.root, "\n");
			expect(selected).toEqual([target.id]);
		} finally {
			mounted.dispose();
		}
	});

	it("excludes env-only providers from logout while retaining stored credentials", () => {
		const provider =
			getOAuthProviders().find(item => item.available && item.id === "opencode-go") ??
			getOAuthProviders().find(item => item.available);
		expect(provider).toBeDefined();
		if (!provider) return;

		const selected: string[] = [];
		const envOnly = mountForTest(() =>
			OAuthSelector({
				inline: true,
				mode: "logout",
				authStorage: {
					has() {
						return false;
					},
					hasAuth(providerId) {
						return providerId === provider.id;
					},
					getCredentialOrigin() {
						return undefined;
					},
				},
				onSelect: providerId => selected.push(providerId),
				onCancel() {},
			}),
		);
		try {
			const rendered = envOnly.rows().map(Bun.stripANSI).join("\n");
			expect(rendered).toContain("No stored provider credentials to log out");
			dispatchHostInput(envOnly.root, "\n");
			expect(selected).toEqual([]);
		} finally {
			envOnly.dispose();
		}

		const stored = mountForTest(() =>
			OAuthSelector({
				inline: true,
				mode: "logout",
				authStorage: {
					has(providerId) {
						return providerId === provider.id;
					},
					hasAuth(providerId) {
						return providerId === provider.id;
					},
					getCredentialOrigin() {
						return { kind: "oauth" };
					},
				},
				onSelect: providerId => selected.push(providerId),
				onCancel() {},
			}),
		);
		try {
			const rendered = stored.rows().map(Bun.stripANSI).join("\n");
			expect(rendered).toContain(provider.name);
			expect(rendered).toContain("logged in");
			expect(rendered).toContain("(login)");
			dispatchHostInput(stored.root, "\n");
			expect(selected).toEqual([provider.id]);
		} finally {
			stored.dispose();
		}
	});

	it("removes disabled provider and alias logins from searchable results", () => {
		const providers = getOAuthProviders();
		const provider = providers.find(item => item.available);
		const alias = providers.find(item => item.storeCredentialsAs === "openai-codex");
		const credentialProviderId = alias?.storeCredentialsAs;
		expect(provider).toBeDefined();
		expect(alias).toBeDefined();
		if (!provider || !alias || !credentialProviderId) return;

		const disabledProvider = mountForTest(() =>
			OAuthSelector({
				inline: true,
				mode: "login",
				authStorage: noCredentials,
				disabledProviders: [provider.id],
				onSelect() {},
				onCancel() {},
			}),
		);
		try {
			disabledProvider.rows();
			for (const character of provider.id) dispatchHostInput(disabledProvider.root, character);
			expect(disabledProvider.rows().map(Bun.stripANSI).join("\n")).not.toContain(provider.name);
		} finally {
			disabledProvider.dispose();
		}

		const disabledAlias = mountForTest(() =>
			OAuthSelector({
				inline: true,
				mode: "login",
				authStorage: noCredentials,
				disabledProviders: [credentialProviderId],
				onSelect() {},
				onCancel() {},
			}),
		);
		try {
			disabledAlias.rows();
			for (const character of alias.id) dispatchHostInput(disabledAlias.root, character);
			expect(disabledAlias.rows().map(Bun.stripANSI).join("\n")).not.toContain(alias.name);
		} finally {
			disabledAlias.dispose();
		}
	});

	it("clips provider rows at narrow widths without widening the framed selector", () => {
		const mounted = mountForTest(
			() =>
				OAuthSelector({
					inline: true,
					mode: "login",
					authStorage: noCredentials,
					onSelect() {},
					onCancel() {},
				}),
			{ width: 12 },
		);
		try {
			const rows = mounted.rows();
			expect(rows.map(visibleWidth)).toEqual(Array(rows.length).fill(12));
		} finally {
			mounted.dispose();
		}
	});
});
