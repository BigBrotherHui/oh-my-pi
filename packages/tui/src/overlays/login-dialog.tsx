import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthPrompt } from "@oh-my-pi/pi-ai/oauth/types";
import { createSignal, For, onMount, useFocus, type Accessor, type JSX } from "../reactive";
import { matchesSelectCancel } from "../keybinding-matchers";
import { decodeReencodedPasteControls } from "../bracketed-paste";
import { replaceTabs } from "../utils";
import type { ThemeColor } from "../theme/schema";
import { Portal, bindOverlayController, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent } from "../host/input";
import type { SizeValue, TUI } from "../tui";

export interface LoginTextRow {
	readonly kind: "text";
	readonly text: string;
	readonly color?: ThemeColor;
	readonly link?: string;
}

export interface LoginInputRow {
	readonly kind: "input";
	readonly value: string;
	readonly secret?: boolean;
	readonly prompt?: string;
}

export type LoginContentRow = LoginTextRow | LoginInputRow | { readonly kind: "spacer" };

export interface LoginDialogViewProps {
	readonly title: string;
	readonly rows: readonly LoginContentRow[];
	readonly inputValue?: Accessor<string>;
	readonly onInputChange?: (value: string) => void;
	readonly onSubmit?: (value: string) => void;
	readonly onCancel?: () => void;
}

function LoginInput(props: {
	readonly row: LoginInputRow;
	readonly inputValue?: Accessor<string>;
	readonly onInputChange?: (value: string) => void;
	readonly onSubmit?: (value: string) => void;
	readonly onCancel?: () => void;
}): JSX.Element {
	const focus = useFocus();
	onMount(() => focus.focus());
	return (
		<input
			tabIndex={focus.tabIndex}
			value={props.inputValue?.() ?? props.row.value}
			prompt={props.row.prompt ?? "> "}
			mask={props.row.secret}
			onChange={props.onInputChange}
			onSubmit={props.onSubmit}
			onEscape={props.onCancel}
		/>
	);
}

export function LoginDialogView(props: LoginDialogViewProps): JSX.Element {
	return (
		<frame title={props.title} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<stack>
				<For each={props.rows}>
					{row => {
						if (row.kind === "spacer") return <br />;
						if (row.kind === "input") {
							return (
								<LoginInput
									row={row}
									inputValue={props.inputValue}
									onInputChange={props.onInputChange}
									onSubmit={props.onSubmit}
									onCancel={props.onCancel}
								/>
							);
						}
						return (
							<text color={row.color} link={row.link} wrap="word">
								{row.text}
							</text>
						);
					}}
				</For>
			</stack>
		</frame>
	);
}

export interface LoginDialogController {
	readonly signal: AbortSignal;
	readonly rows: Accessor<readonly LoginContentRow[]>;
	readonly inputValue: Accessor<string>;
	showAuth(url: string, instructions?: string, launchUrl?: string): void;
	showPrompt(prompt: OAuthPrompt): Promise<string>;
	showProgress(message: string): void;
	showManualInput(message: string, signal?: AbortSignal): Promise<string>;
	pasteText(text: string): void;
	setInputValue(value: string): void;
	handleInput(data: string): void;
	cancel(): void;
	dispose(): void;
}

interface PendingInput {
	resolve(value: string): void;
	reject(reason: Error): void;
	removeAbortListener?: () => void;
}

/** State controller for a login dialog. It is independent of the overlay host for direct testability. */
export function createLoginDialogController(
	providerId: string,
	onComplete: (success: boolean, message?: string) => void,
	openUrl: (url: string) => void,
): LoginDialogController {
	const abortController = new AbortController();
	const [rows, setRows] = createSignal<LoginContentRow[]>([]);
	const [inputValue, setInputValueSignal] = createSignal("");
	let pending: PendingInput | undefined;
	let disposed = false;

	const replaceInput = (): void => {
		setRows(previous => previous.map(row => (row.kind === "input" ? { ...row, value: inputValue() } : row)));
	};
	const rejectPending = (reason: Error): void => {
		const current = pending;
		pending = undefined;
		current?.removeAbortListener?.();
		current?.reject(reason);
	};
	const resolvePending = (): void => {
		const current = pending;
		if (!current) return;
		pending = undefined;
		current.removeAbortListener?.();
		current.resolve(inputValue());
	};
	const waitForInput = (signal?: AbortSignal): Promise<string> =>
		new Promise<string>((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
				return;
			}
			const onAbort = () =>
				rejectPending(signal?.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
			signal?.addEventListener("abort", onAbort, { once: true });
			pending = {
				resolve,
				reject,
				removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
			};
		});
	const cancel = (): void => {
		if (disposed) return;
		if (!abortController.signal.aborted) abortController.abort();
		rejectPending(new Error("Login cancelled"));
		onComplete(false, "Login cancelled");
	};
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		if (!abortController.signal.aborted) abortController.abort();
		rejectPending(new Error("Login cancelled"));
	};

	return {
		get signal(): AbortSignal {
			return abortController.signal;
		},
		rows,
		inputValue,
		showAuth(url: string, instructions?: string, launchUrl?: string): void {
			const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
			const nextRows: LoginContentRow[] = [
				{ kind: "spacer" },
				{ kind: "text", text: url, color: "accent", link: url },
				{ kind: "text", text: clickHint, color: "dim", link: url },
			];
			if (launchUrl && launchUrl !== url) {
				nextRows.push({ kind: "text", text: `Local shortcut (this machine only): ${launchUrl}`, color: "dim" });
			}
			if (instructions) nextRows.push({ kind: "spacer" }, { kind: "text", text: instructions, color: "warning" });
			setRows(nextRows);
			openUrl(url);
		},
		showPrompt(prompt: OAuthPrompt): Promise<string> {
			rejectPending(new Error("Login prompt replaced"));
			const secret = "secret" in prompt && prompt.secret === true;
			const prior = rows().find((row): row is LoginInputRow => row.kind === "input");
			setRows(previous => {
				const next: LoginContentRow[] =
					prior === undefined
						? [...previous]
						: previous.map(row => {
								if (row !== prior) return row;
								return {
									kind: "text",
									text: `${prior.prompt ?? "> "}${prior.secret ? "********" : inputValue()}`,
									color: "dim",
								};
							});
				next.push({ kind: "spacer" }, { kind: "text", text: prompt.message, color: "text" });
				if (prompt.placeholder) next.push({ kind: "text", text: `e.g., ${prompt.placeholder}`, color: "dim" });
				next.push(
					{ kind: "input", value: "", secret },
					{ kind: "text", text: "(Escape to cancel, Enter to submit)", color: "dim" },
				);
				return next;
			});
			setInputValueSignal("");
			return waitForInput();
		},
		showProgress(message: string): void {
			rejectPending(new Error("Login prompt replaced"));
			setRows(previous => [...previous, { kind: "text", text: message, color: "dim" }]);
		},
		showManualInput(message: string, signal?: AbortSignal): Promise<string> {
			rejectPending(new Error("Login prompt replaced"));
			setInputValueSignal("");
			setRows(previous => {
				const inputIndex = previous.findIndex(row => row.kind === "input");
				if (inputIndex >= 0) {
					const next = [...previous];
					next[inputIndex] = { kind: "input", value: "" };
					return next;
				}
				return [
					...previous,
					{ kind: "spacer" },
					{ kind: "text", text: message, color: "dim" },
					{ kind: "input", value: "" },
					{ kind: "text", text: "(Escape to cancel)", color: "dim" },
				];
			});
			return waitForInput(signal);
		},
		pasteText(text: string): void {
			if (!pending) return;
			const pasted = replaceTabs(
				decodeReencodedPasteControls(text).replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, ""),
			)
				.normalize("NFC")
				.replace(/[\x00-\x1f\x7f]/g, "");
			if (!pasted) return;
			setInputValueSignal(inputValue() + pasted);
			replaceInput();
		},
		setInputValue(value: string): void {
			setInputValueSignal(value);
		},
		handleInput(data: string): void {
			if (matchesSelectCancel(data) || data === "\x1b" || data === "\x03") {
				cancel();
				return;
			}
			if (!pending) return;
			if (data === "\r" || data === "\n") {
				resolvePending();
				return;
			}
			if (data === "\x7f" || data === "\b") {
				setInputValueSignal(Array.from(inputValue()).slice(0, -1).join(""));
				replaceInput();
				return;
			}
			if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
				setInputValueSignal(inputValue() + data);
				replaceInput();
			}
		},
		cancel,
		dispose,
	};
}

export interface LoginDialogProps {
	readonly title: string;
	readonly controller: LoginDialogController;
	readonly width?: SizeValue;
}

export function LoginDialog(props: LoginDialogProps): JSX.Element {
	const handleKey = (event: HostKeyEvent): boolean => {
		if (!event.defaultPrevented) props.controller.handleInput(event.data);
		return true;
	};
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<box onKey={handleKey} tabIndex={0}>
				<LoginDialogView
					title={props.title}
					rows={props.controller.rows()}
					inputValue={props.controller.inputValue}
					onInputChange={value => props.controller.setInputValue(value)}
					onSubmit={value => {
						props.controller.setInputValue(value);
						props.controller.handleInput("\r");
					}}
					onCancel={() => props.controller.cancel()}
				/>
			</box>
		</Portal>
	);
}

export interface LoginDialogHandle extends OverlayDisposer, LoginDialogController {}

/** Open the login dialog overlay on a TUI instance, returning its reactive controller handle. */
export function openLoginDialog(
	tui: TUI,
	providerId: string,
	onComplete: (success: boolean, message?: string) => void,
	openUrl: (url: string) => void,
	opts?: { width?: SizeValue },
): LoginDialogHandle {
	const providerInfo = getOAuthProviders().find(provider => provider.id === providerId);
	const title = `Login to ${providerInfo?.name || providerId}`;
	const controller = createLoginDialogController(providerId, onComplete, openUrl);
	const disposer = mountOverlay(tui, () => <LoginDialog title={title} controller={controller} width={opts?.width} />);
	return bindOverlayController(disposer, controller);
}

export const showLoginDialog = openLoginDialog;
