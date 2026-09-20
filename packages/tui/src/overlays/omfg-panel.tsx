import { createSignal, type JSX } from "../reactive";
import { replaceTabs } from "../render/render-utils";
import type { ThemeColor } from "../theme/schema";
import { createDocument } from "../document/document";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { SizeValue, TUI } from "../tui";

export type OmfgPanelState =
	| "generating"
	| "validating"
	| "confirming"
	| "saving"
	| "saved"
	| "rejected"
	| "aborted"
	| "error";

export interface OmfgPanelComponentOptions {
	complaint: string;
	tui: TUI;
}

export interface OmfgPanelFooter {
	readonly text: string;
	readonly tone: ThemeColor;
	readonly icon?: "status.success" | "status.warning" | "status.error";
}

function footerFor(state: OmfgPanelState, savedPath: string | undefined): OmfgPanelFooter {
	switch (state) {
		case "generating":
		case "validating":
		case "confirming":
		case "saving":
			return { text: "Esc cancel /omfg", tone: "muted" };
		case "saved":
			return {
				text: `Registered live · ${replaceTabs(savedPath ?? "saved")} · Esc dismiss`,
				tone: "success",
				icon: "status.success",
			};
		case "rejected":
			return { text: "Not saved · Esc dismiss", tone: "warning", icon: "status.warning" };
		case "aborted":
			return { text: "Cancelled · Esc dismiss", tone: "warning", icon: "status.warning" };
		case "error":
			return { text: "Error · Esc dismiss", tone: "error", icon: "status.error" };
	}
}

export interface OmfgPanelViewProps {
	readonly title: string;
	readonly status: string;
	readonly preview: string;
	readonly state: OmfgPanelState;
	readonly errorMessage?: string;
	readonly footer: OmfgPanelFooter;
}

export function OmfgPanelView(props: OmfgPanelViewProps): JSX.Element {
	const preview = replaceTabs(props.preview).trim();

	return (
		<frame title={props.title} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<stack>
				<br />
				<text color="muted" wrap="word">
					{replaceTabs(props.status)}
				</text>
				<br />
				{props.state === "error" ? (
					<text color="error" wrap="word">
						{replaceTabs(props.errorMessage ?? "Unknown error")}
					</text>
				) : preview ? (
					<markdown document={createDocument(preview)} />
				) : (
					<text color="dim" wrap="word">
						<icon name="status.pending" /> Waiting for candidate rule…
					</text>
				)}
				<br />
				<text color={props.footer.tone} wrap="word">
					{props.footer.icon ? (
						<>
							<icon name={props.footer.icon} />{" "}
						</>
					) : null}
					{props.footer.text}
				</text>
			</stack>
		</frame>
	);
}

export interface OmfgPanelHandle extends OverlayDisposer {
	appendDraft(delta: string): void;
	setRule(text: string): void;
	setStatus(state: OmfgPanelState, status: string): void;
	markSaved(path: string): void;
	markRejected(reason?: string): void;
	markAborted(): void;
	markError(message: string): void;
	close(): void;
}

export interface OmfgPanelProps {
	readonly title: string;
	readonly status: string;
	readonly preview: string;
	readonly state: OmfgPanelState;
	readonly errorMessage?: string;
	readonly footer: OmfgPanelFooter;
	readonly width?: SizeValue;
}

export function OmfgPanel(props: OmfgPanelProps): JSX.Element {
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<box tabIndex={0}>
				<OmfgPanelView
					title={props.title}
					status={props.status}
					preview={props.preview}
					state={props.state}
					errorMessage={props.errorMessage}
					footer={props.footer}
				/>
			</box>
		</Portal>
	);
}

/** Open the /omfg panel overlay on a TUI instance, returning a controller handle. */
export function openOmfgPanel(
	tui: TUI,
	options: OmfgPanelComponentOptions,
	opts?: { width?: SizeValue },
): OmfgPanelHandle {
	const title = `/omfg ${replaceTabs(options.complaint)}`.replace(/\s+/g, " ").trim();
	const [state, setState] = createSignal<OmfgPanelState>("generating");
	const [status, setStatusText] = createSignal("Generating TTSR rule…");
	const [preview, setPreview] = createSignal("");
	const [errorMessage, setErrorMessage] = createSignal<string | undefined>();
	const [savedPath, setSavedPath] = createSignal<string | undefined>();
	let closed = false;

	const close = (): void => {
		if (closed) return;
		closed = true;
		overlay?.dispose();
	};

	const overlay = mountOverlay(tui, () => (
		<OmfgPanel
			title={title}
			status={status()}
			preview={preview()}
			state={state()}
			errorMessage={errorMessage()}
			footer={footerFor(state(), savedPath())}
			width={opts?.width}
		/>
	));

	return Object.assign(close, {
		hide: close,
		dispose: close,
		appendDraft(delta: string): void {
			if (!delta || closed) return;
			setPreview(previous => previous + delta);
		},
		setRule(text: string): void {
			if (closed) return;
			setPreview(text);
		},
		setStatus(nextState: OmfgPanelState, nextStatus: string): void {
			if (closed) return;
			setState(nextState);
			setStatusText(nextStatus);
			setErrorMessage(undefined);
			setSavedPath(undefined);
		},
		markSaved(path: string): void {
			if (closed) return;
			setState("saved");
			setStatusText(`Saved ${path}`);
			setErrorMessage(undefined);
			setSavedPath(path);
		},
		markRejected(reason?: string): void {
			if (closed) return;
			setState("rejected");
			setStatusText(reason ?? "Rule was not saved.");
			setErrorMessage(undefined);
			setSavedPath(undefined);
		},
		markAborted(): void {
			if (closed) return;
			setState("aborted");
			setStatusText("Cancelled.");
			setErrorMessage(undefined);
			setSavedPath(undefined);
		},
		markError(message: string): void {
			if (closed) return;
			setState("error");
			setStatusText("Could not create rule.");
			setErrorMessage(message);
			setSavedPath(undefined);
		},
		close,
	});
}

export function OmfgPanelComponent(options: OmfgPanelComponentOptions): OmfgPanelHandle {
	return openOmfgPanel(options.tui, options);
}

export const showOmfgPanel = openOmfgPanel;
