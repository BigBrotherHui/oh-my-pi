import { beforeAll, describe, expect, it } from "bun:test";
import {
	createLoginDialogController,
	LoginDialogView,
	type LoginDialogController,
} from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { dispatchHostInput } from "../src/host/overlay";
import { mountForTest, renderToRows } from "../src/testing";
import { visibleWidth } from "@oh-my-pi/pi-tui";

function makeDialog(): LoginDialogController {
	return createLoginDialogController(
		"openai-codex",
		() => {},
		() => {},
	);
}

function rows(dialog: LoginDialogController): string {
	return renderToRows(() => LoginDialogView({ title: "Login to OpenAI Codex", rows: dialog.rows() }), 80).join("\n");
}

function view(dialog: LoginDialogController) {
	return LoginDialogView({
		title: "Login to OpenAI Codex",
		rows: dialog.rows(),
		inputValue: dialog.inputValue,
		onInputChange(value) {
			dialog.setInputValue(value);
		},
		onSubmit(value) {
			dialog.setInputValue(value);
			dialog.handleInput("\r");
		},
		onCancel() {
			dialog.cancel();
		},
	});
}

describe("Login dialog manual code input", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("captures a pasted fallback redirect URL and resolves on submit", async () => {
		const dialog = makeDialog();
		dialog.showProgress("Waiting for callback");

		const pending = dialog.showManualInput("Paste the authorization code:");
		expect(rows(dialog)).toContain("Paste the authorization code");

		const url = "http://localhost:1455/auth/callback?code=THECODE&state=abc";
		dialog.pasteText(url);
		dialog.handleInput("\r");

		expect(await pending).toBe(url);
	});

	it("rejects pending input when another callback path wins", async () => {
		const dialog = makeDialog();
		const settled = new AbortController();
		const error = new Error("native callback received");
		const pending = dialog.showManualInput("Paste the authorization code:", settled.signal);

		settled.abort(error);

		await expect(pending).rejects.toBe(error);
	});

	it("replaces the prior prompt and clears stale input on retry", async () => {
		const dialog = makeDialog();
		dialog.showProgress("Waiting for callback");

		const first = dialog.showManualInput("Paste the code:");
		dialog.handleInput("garbage");
		dialog.handleInput("\r");
		expect(await first).toBe("garbage");

		const second = dialog.showManualInput("Paste the code:");
		const rendered = rows(dialog);
		expect(rendered.split("Paste the code:").length - 1).toBe(1);
		expect(rendered).not.toContain("garbage");

		const url = "http://localhost:1455/auth/callback?code=OK&state=abc";
		dialog.pasteText(url);
		dialog.handleInput("\r");
		expect(await second).toBe(url);
	});

	it("keeps authorization, completed answers, prompt chrome, and secret values distinct", async () => {
		const completions: Array<[boolean, string | undefined]> = [];
		const opened: string[] = [];
		const dialog = createLoginDialogController(
			"openai-codex",
			(success, message) => completions.push([success, message]),
			url => opened.push(url),
		);
		const authorizationUrl = "https://accounts.example.test/authorize?state=abcdefghijklmnopqrstuvwxyz";
		dialog.showAuth(authorizationUrl, "Finish sign-in in the browser.", "http://127.0.0.1:1455/callback");
		expect(opened).toEqual([authorizationUrl]);

		const account = dialog.showPrompt({ message: "Account label", placeholder: "personal" });
		dialog.pasteText("personal");
		dialog.handleInput("\r");
		expect(await account).toBe("personal");

		const secret = dialog.showPrompt({ message: "Consumer key", secret: true });
		dialog.pasteText("top-secret");
		expect(rows(dialog)).not.toContain("top-secret");
		dialog.handleInput("\r");
		expect(await secret).toBe("top-secret");

		const final = dialog.showPrompt({ message: "Organization" });
		const rendered = rows(dialog);
		expect(rendered).toContain(authorizationUrl);
		expect(rendered).toContain(process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open");
		expect(rendered).toContain("Local shortcut (this machine only): http://127.0.0.1:1455/callback");
		expect(rendered).toContain("Finish sign-in in the browser.");
		expect(rendered).toContain("e.g., personal");
		expect(rendered).toContain("> personal");
		expect(rendered).toContain("> ********");
		expect(rendered).not.toContain("top-secret");

		dialog.cancel();
		await expect(final).rejects.toThrow("Login cancelled");
		expect(completions).toEqual([[false, "Login cancelled"]]);
	});

	it("aborts and rejects pending input when the overlay disposes without reporting a user cancellation", async () => {
		const completions: Array<[boolean, string | undefined]> = [];
		const dialog = createLoginDialogController(
			"openai-codex",
			(success, message) => completions.push([success, message]),
			() => {},
		);
		const pending = dialog.showManualInput("Paste the authorization code:");

		dialog.dispose();

		expect(dialog.signal.aborted).toBe(true);
		await expect(pending).rejects.toThrow("Login cancelled");
		expect(completions).toEqual([]);
	});

	it("wraps complete linked authorization URLs at narrow widths", () => {
		const dialog = makeDialog();
		const authorizationUrl =
			"https://accounts.example.test/authorize?client_id=client&response_type=code&state=abcdefghijklmnopqrstuvwxyz";
		dialog.showAuth(authorizationUrl);
		const root = mountForTest(() => view(dialog), { width: 20 });
		try {
			const rendered = root.text(20);
			const content = rendered
				.filter(line => line.startsWith("│"))
				.map(line => line.slice(2, -2).trim())
				.join("");
			expect(content).toContain(authorizationUrl);
			expect(rendered.every(line => visibleWidth(line) <= 20)).toBe(true);
		} finally {
			root.dispose();
		}
	});

	it("routes retained input edits, cursor movement, and submission into the active login prompt", async () => {
		const dialog = makeDialog();
		const pending = dialog.showManualInput("Paste the authorization code:");
		const root = mountForTest(() => view(dialog), { width: 80 });
		try {
			root.flush();
			dispatchHostInput(root.root, "ab");
			dispatchHostInput(root.root, "\x1b[D");
			dispatchHostInput(root.root, "X");
			dispatchHostInput(root.root, "\r");

			expect(await pending).toBe("aXb");
		} finally {
			root.dispose();
		}
	});
});
