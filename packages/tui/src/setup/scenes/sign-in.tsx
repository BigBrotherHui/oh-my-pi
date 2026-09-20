import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import type { OAuthPrompt } from "@oh-my-pi/pi-ai/oauth/types";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { OAuthSelector } from "../../overlays/oauth-selector";
import {
	Show,
	createSignal,
	onCleanup,
	useFocus,
	useTheme,
	useViewport,
	type Accessor,
	type JSX,
} from "../../reactive";
import { matchesKey } from "../../keys";
import { wrapTextWithAnsi } from "../../utils";
import type { SetupHost, SetupSceneResult } from "./types";

const FULL_SELECTOR_ROWS = 17;
const INTRO_ROWS = 2;
const INTRO_THRESHOLD = FULL_SELECTOR_ROWS + INTRO_ROWS;

type StatusColor = "dim" | "warning" | "error" | "success";

interface StatusLine {
	readonly text: string;
	readonly color: StatusColor;
}

interface PromptState {
	readonly message: string;
	readonly placeholder?: string;
	readonly secret: boolean;
	readonly resolve: (value: string) => void;
	readonly reject: (reason?: unknown) => void;
	abortCleanup?: () => void;
}

/** The sign-in scene's narrow host contract, retained for direct mounting and tests. */
export interface SignInSceneContext {
	readonly host: Pick<
		SetupHost,
		| "authStorage"
		| "captureBrowserSession"
		| "copyToClipboard"
		| "disabledProviders"
		| "openInBrowser"
		| "refreshProvider"
	>;
	complete(result: SetupSceneResult): void;
	/** Exact rows the wizard has made available to this scene after its own chrome. */
	readonly availableRows?: Accessor<number>;
	/** Blocks provider-tab navigation while an OAuth flow owns this scene. */
	setModal?(active: boolean): void;
	/** Whether the provider tab containing this retained scene is visible. */
	readonly active?: Accessor<boolean>;
}

function AuthUrlRows(props: { readonly url: string; readonly continuation: boolean }): JSX.Element {
	return (
		<sized
			paint={width => {
				const rows = wrapTextWithAnsi(props.url, Math.max(1, width));
				const visible = props.continuation ? rows.slice(1) : rows.slice(0, 1);
				return (
					<>
						{visible.map(row => (
							<text color="dim" wrap="none">
								{row}
							</text>
						))}
					</>
				);
			}}
		/>
	);
}

function StatusRows(props: { readonly lines: readonly StatusLine[] }): JSX.Element {
	return (
		<>
			{props.lines.map(line => (
				<text color={line.color}>{line.text}</text>
			))}
		</>
	);
}

/**
 * "Sign in" panel: lets the user authenticate one or more model providers via
 * OAuth. It never advances setup automatically, so several providers can be
 * connected before Esc continues the wizard.
 */
export function SignInSceneView(context: SignInSceneContext): JSX.Element {
	const [provider, setProvider] = createSignal<string>();
	const [status, setStatus] = createSignal<readonly StatusLine[]>([]);
	const [authUrl, setAuthUrl] = createSignal<string>();
	const [launchUrl, setLaunchUrl] = createSignal<string>();
	const [prompt, setPrompt] = createSignal<PromptState>();
	const [selectorGeneration, setSelectorGeneration] = createSignal(1);
	const rootFocus = useFocus();
	const promptFocus = useFocus();
	const viewport = useViewport();
	const theme = useTheme();
	let loginAbort: AbortController | undefined;
	let disposed = false;

	const availableRows = (): number => Math.max(0, Math.trunc(context.availableRows?.() ?? viewport().rows));
	const showIntro = (): boolean => provider() === undefined && availableRows() >= INTRO_THRESHOLD;
	const selectorRows = (width: number): number => {
		const statusRows = status().reduce(
			(total, line) => total + wrapTextWithAnsi(line.text, Math.max(1, width)).length,
			0,
		);
		return Math.max(1, availableRows() - (showIntro() ? INTRO_ROWS : 0) - statusRows);
	};
	const clearPrompt = (): PromptState | undefined => {
		const active = prompt();
		if (!active) return undefined;
		active.abortCleanup?.();
		setPrompt(undefined);
		return active;
	};
	const resolvePrompt = (value: string): void => {
		const active = clearPrompt();
		if (!active) return;
		active.resolve(value);
		rootFocus.focus();
	};
	const rejectPrompt = (reason: unknown): void => {
		const active = clearPrompt();
		if (!active) return;
		active.reject(reason);
		rootFocus.focus();
	};
	const copyUrl = async (): Promise<void> => {
		const url = authUrl();
		if (!url) return;
		try {
			await context.host.copyToClipboard(url);
		} catch {
			// Clipboard integration is best-effort; the complete URL stays visible.
		}
	};
	const requestPrompt = (oauthPrompt: OAuthPrompt, signal?: AbortSignal): Promise<string> => {
		resolvePrompt("");
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Login input cancelled"));
		const pending = Promise.withResolvers<string>();
		const state: PromptState = {
			message: oauthPrompt.message,
			placeholder: oauthPrompt.placeholder,
			secret: oauthPrompt.secret === true,
			resolve: pending.resolve,
			reject: pending.reject,
		};
		if (signal) {
			const onAbort = (): void => {
				if (prompt() === state) rejectPrompt(signal.reason ?? new Error("Login input cancelled"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			state.abortCleanup = () => signal.removeEventListener("abort", onAbort);
		}
		setPrompt(state);
		queueMicrotask(() => {
			if (!disposed && prompt() === state) promptFocus.focus();
		});
		return pending.promise;
	};
	const finishLogin = (controller: AbortController): void => {
		if (disposed || loginAbort !== controller) return;
		resolvePrompt("");
		loginAbort = undefined;
		setProvider(undefined);
		context.setModal?.(false);
		rootFocus.blur();
	};
	const login = async (providerId: string): Promise<void> => {
		if (provider() !== undefined || disposed) return;
		const controller = new AbortController();
		loginAbort = controller;
		setProvider(providerId);
		context.setModal?.(true);
		rootFocus.focus();
		setStatus([{ text: "Starting OAuth flow…", color: "dim" }]);
		setAuthUrl(undefined);
		setLaunchUrl(undefined);
		try {
			await context.host.authStorage.login(providerId, {
				signal: controller.signal,
				onBrowserSession: (request, signal) => context.host.captureBrowserSession(request, signal),
				onAuth: info => {
					if (disposed || loginAbort !== controller) return;
					setAuthUrl(info.url);
					setLaunchUrl(info.launchUrl && info.launchUrl !== info.url ? info.launchUrl : undefined);
					const lines: StatusLine[] = [];
					if (info.instructions) lines.push({ text: info.instructions, color: "warning" });
					if (PASTE_CODE_LOGIN_PROVIDERS.has(providerId)) {
						lines.push({ text: "Paste the returned code or redirect URL when prompted.", color: "dim" });
					}
					setStatus(lines);
					void copyUrl();
					context.host.openInBrowser(info.url);
				},
				onPrompt: requestPrompt,
				onProgress: message => {
					if (!disposed && loginAbort === controller) {
						setStatus(lines => [...lines, { text: message, color: "dim" }]);
					}
				},
				onManualCodeInput: signal =>
					requestPrompt({ message: "Paste the authorization code (or full redirect URL):" }, signal),
			});
			await context.host.refreshProvider(providerId);
			if (disposed || loginAbort !== controller) return;
			setStatus([
				{ text: `${theme.theme().symbol("status.success")} Signed in to ${providerId}`, color: "success" },
				{ text: `Credentials saved to ${getAgentDbPath()}`, color: "dim" },
			]);
			setAuthUrl(undefined);
			setLaunchUrl(undefined);
			setSelectorGeneration(generation => generation + 1);
		} catch (error) {
			if (disposed || loginAbort !== controller) return;
			if (controller.signal.aborted) {
				setStatus([{ text: "Login cancelled.", color: "dim" }]);
			} else {
				const message = error instanceof Error ? error.message : String(error);
				setStatus([
					{ text: `Login failed: ${message}`, color: "error" },
					{ text: "Choose another provider or press Esc to continue.", color: "dim" },
				]);
			}
			setAuthUrl(undefined);
			setLaunchUrl(undefined);
		} finally {
			finishLogin(controller);
		}
	};
	const handlePromptKey = (event: {
		readonly data: string;
		preventDefault(): void;
		stopPropagation(): void;
	}): void => {
		if (!matchesKey(event.data, "alt+c")) return;
		void copyUrl();
		event.preventDefault();
		event.stopPropagation();
	};

	onCleanup(() => {
		disposed = true;
		loginAbort?.abort();
		resolvePrompt("");
		context.setModal?.(false);
	});

	return (
		<box
			tabIndex={provider() === undefined ? undefined : rootFocus.tabIndex}
			onKey={event => {
				if (provider() === undefined) return;
				if (matchesKey(event.data, "ctrl+c")) {
					// Let the fullscreen wizard consume Ctrl+C after aborting the owned OAuth flow.
					loginAbort?.abort();
					event.preventDefault();
					return;
				}
				if (matchesKey(event.data, "escape")) {
					loginAbort?.abort();
					event.preventDefault();
				} else if (
					authUrl() !== undefined &&
					(matchesKey(event.data, "alt+c") || (event.data === "c" && prompt() === undefined))
				) {
					void copyUrl();
					event.preventDefault();
				}
				event.stopPropagation();
			}}
			onMouse={event => {
				if (provider() !== undefined) event.stopPropagation();
			}}
		>
			<stack>
				{showIntro() ? (
					<>
						<text color="muted">Pick a provider to sign in — you can connect more than one.</text>
						<br />
					</>
				) : null}
				<scroll
					height={provider() === undefined ? selectorRows(viewport().columns) : 0}
					shrinkToFit
					scrollbar="never"
				>
					<Show when={selectorGeneration()} keyed>
						{() => (
							<OAuthSelector
								inline
								mode="login"
								authStorage={context.host.authStorage}
								disabledProviders={context.host.disabledProviders}
								active={context.active}
								maxHeight={selectorRows(viewport().columns)}
								onSelect={providerId => void login(providerId)}
								onCancel={() => context.complete("skipped")}
							/>
						)}
					</Show>
				</scroll>
				{provider() === undefined ? (
					<StatusRows lines={status()} />
				) : (
					<stack>
						<text bold>Signing in to {provider()}</text>
						{authUrl() ? (
							<text>
								<span color="accent">Browser login: </span>
								<span color="accent" link={authUrl() ?? ""}>
									Open login URL
								</span>
								<span color="dim"> (clipboard copy attempted; Alt+C retries)</span>
							</text>
						) : null}
						{authUrl() ? <AuthUrlRows url={authUrl() ?? ""} continuation={false} /> : null}
						{launchUrl() ? <text color="dim">Local shortcut (this machine only): {launchUrl()}</text> : null}
						{prompt() ? (
							<stack>
								<text color="warning">{prompt()?.message ?? ""}</text>
								{prompt()?.placeholder ? <text color="dim">{prompt()?.placeholder ?? ""}</text> : null}
								<input
									tabIndex={promptFocus.tabIndex}
									prompt="> "
									mask={prompt()?.secret ?? false}
									onKey={handlePromptKey}
									onSubmit={value => resolvePrompt(value)}
									onEscape={() => loginAbort?.abort()}
								/>
							</stack>
						) : null}
						{authUrl() ? <AuthUrlRows url={authUrl() ?? ""} continuation /> : null}
						<StatusRows lines={status()} />
					</stack>
				)}
			</stack>
		</box>
	);
}
