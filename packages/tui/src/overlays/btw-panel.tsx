import { sanitizeText } from "@oh-my-pi/pi-utils";
import { createSignal, For, type JSX } from "../reactive";
import { replaceTabs, shortenEmbeddedPaths } from "../render/render-utils";
import { clampScrollOffset, maxScrollOffset } from "../components/scroll-viewport";
import { createDocument } from "../document/document";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import type { ScrollViewportState } from "../host/elements/scroll";
import { matchesKey } from "../keys";
import type { ThemeColor } from "../theme/schema";
import type { SizeValue, TUI } from "../tui";

const PANEL_CHROME_ROWS = 5;

type BtwFooterStatus = "pending" | "warning" | "error";

export type BtwPanelState = "running" | "complete" | "branching" | "aborted" | "error";
export type BtwPanelAction = () => void | boolean | Promise<void | boolean>;

export interface BtwPanelComponentOptions {
	readonly question: string;
	readonly tui: TUI;
	readonly canBranch?: () => boolean;
	readonly canFollowUp?: () => boolean;
	readonly onCancel?: BtwPanelAction;
	readonly onClose?: BtwPanelAction;
	readonly onCopy?: BtwPanelAction;
	readonly onBranch?: BtwPanelAction;
	readonly onFollowUp?: BtwPanelAction;
}

export interface StyledSegment {
	readonly text: string;
	readonly tone?: ThemeColor;
}

interface BtwFooterPresentation {
	readonly segments: readonly StyledSegment[];
	readonly status?: BtwFooterStatus;
}

function sanitizeErrorLine(message: string): string {
	const text = shortenEmbeddedPaths(replaceTabs(sanitizeText(message.replace(/\r\n?/g, "\n"))), undefined, true);
	return text.replace(/\s+/g, " ").trim() || "Unknown error";
}

function visibleAnswer(answer: string): string {
	return replaceTabs(answer).trim();
}

function isCopyable(state: BtwPanelState, answer: string): boolean {
	return state === "complete" && answer.length > 0;
}

function footerPresentation(
	state: BtwPanelState,
	answer: string,
	copied: boolean,
	canBranch: (() => boolean) | undefined,
	canFollowUp: (() => boolean) | undefined,
): BtwFooterPresentation {
	switch (state) {
		case "running":
			return { segments: [{ text: "Esc to cancel", tone: "muted" }] };
		case "complete": {
			const copyable = isCopyable(state, answer);
			const actions: string[] = [];
			if (copyable) actions.push(copied ? "c to copy again" : "c to copy");
			if (canFollowUp?.()) actions.push("f to follow up");
			if (canBranch?.() ?? copyable) actions.push("b to branch");
			actions.push("Esc to close");
			if (copied) {
				return {
					segments: [
						{ text: "✓ Copied to clipboard", tone: "success" },
						{ text: ` · ${actions.join(" · ")}`, tone: "muted" },
					],
				};
			}
			return { segments: [{ text: actions.join(" · "), tone: "muted" }] };
		}
		case "branching":
			return { status: "pending", segments: [{ text: " Branching to chat…", tone: "muted" }] };
		case "aborted":
			return { status: "warning", segments: [{ text: " Cancelled · Esc to close", tone: "warning" }] };
		case "error":
			return { status: "error", segments: [{ text: " Error · Esc to close", tone: "error" }] };
	}
}

export interface BtwPanelViewProps {
	readonly title: string;
	readonly state: BtwPanelState;
	readonly visibleAnswer: string;
	readonly errorMessage?: string;
	readonly footer: readonly StyledSegment[];
	readonly footerStatus?: BtwFooterStatus;
	readonly bodyHeight?: number;
	readonly offset?: number;
	readonly followTail?: boolean;
	readonly onViewport?: (viewport: ScrollViewportState) => void;
}

export function BtwPanelView(props: BtwPanelViewProps): JSX.Element {
	return (
		<frame title={props.title} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<stack>
				<br />
				<scroll
					height={props.bodyHeight ?? Number.MAX_SAFE_INTEGER}
					offset={props.offset}
					followTail={props.followTail ?? true}
					shrinkToFit
					trackColor="dim"
					thumbColor="accent"
					onViewport={props.onViewport}
				>
					{props.state === "error" ? (
						<text color="error" wrap="word">
							{sanitizeErrorLine(props.errorMessage ?? "Unknown error")}
						</text>
					) : props.visibleAnswer ? (
						<markdown document={createDocument(props.visibleAnswer)} />
					) : (
						<row>
							<status value="pending" color="dim" />
							<text color="dim">
								{props.state === "running" ? " Waiting for response…" : " No text returned."}
							</text>
						</row>
					)}
				</scroll>
				<br />
				<row>
					{props.footerStatus ? <status value={props.footerStatus} /> : null}
					<For each={props.footer}>
						{segment => (
							<text color={segment.tone} wrap="none">
								{segment.text}
							</text>
						)}
					</For>
				</row>
			</stack>
		</frame>
	);
}

export interface BtwPanelHandle extends OverlayDisposer {
	appendText(delta: string): void;
	setAnswer(text: string): void;
	setStatus(state: BtwPanelState): void;
	markBranching(): void;
	markAborted(): void;
	markError(message: string): void;
	markComplete(): void;
	markCopied(): void;
	isBranchable(): boolean;
	isCopyable(): boolean;
	getCopyText(): string | undefined;
	close(): void;
}

export interface BtwPanelProps {
	readonly title: string;
	readonly state: BtwPanelState;
	readonly visibleAnswer: string;
	readonly errorMessage?: string;
	readonly footer: readonly StyledSegment[];
	readonly footerStatus?: BtwFooterStatus;
	readonly canBranch?: () => boolean;
	readonly canFollowUp?: () => boolean;
	readonly onCancel?: BtwPanelAction;
	readonly onClose?: BtwPanelAction;
	readonly onCopy?: BtwPanelAction;
	readonly onBranch?: BtwPanelAction;
	readonly onFollowUp?: BtwPanelAction;
	readonly onDismiss?: () => void;
	readonly width?: SizeValue;
	readonly maxHeight?: number;
}

export function BtwPanel(props: BtwPanelProps): JSX.Element {
	const [offset, setOffset] = createSignal(0);
	const [viewport, setViewport] = createSignal<ScrollViewportState>();
	const [followingTail, setFollowingTail] = createSignal(true);
	const bodyHeight = () =>
		props.maxHeight === undefined
			? Number.MAX_SAFE_INTEGER
			: Math.max(1, Math.trunc(props.maxHeight) - PANEL_CHROME_ROWS);
	const move = (rows: number): boolean => {
		const current = viewport();
		if (!current) return false;
		setFollowingTail(false);
		setOffset(previous => clampScrollOffset(previous + rows, current.totalRows, current.height));
		return true;
	};
	const toStart = (): boolean => {
		if (!viewport()) return false;
		setFollowingTail(false);
		setOffset(0);
		return true;
	};
	const toEnd = (): boolean => {
		const current = viewport();
		if (!current) return false;
		setOffset(maxScrollOffset(current.totalRows, current.height));
		setFollowingTail(true);
		return true;
	};
	const invoke = (action: BtwPanelAction | undefined): boolean => {
		if (!action) return false;
		void action();
		return true;
	};
	const handleKey = (event: HostKeyEvent): void => {
		const answer = props.visibleAnswer;
		let handled = false;
		if (matchesKey(event.data, "escape") || matchesKey(event.data, "esc")) {
			if (props.state === "running") handled = invoke(props.onCancel);
			else if (props.state === "branching") handled = invoke(props.onClose);
			else {
				handled = invoke(props.onClose) || props.onDismiss !== undefined;
				if (handled) props.onDismiss?.();
			}
		} else if (matchesKey(event.data, "c") && isCopyable(props.state, answer)) {
			handled = invoke(props.onCopy);
		} else if (
			matchesKey(event.data, "b") &&
			props.state === "complete" &&
			(props.canBranch?.() ?? isCopyable(props.state, answer))
		) {
			handled = invoke(props.onBranch);
		} else if (matchesKey(event.data, "f") && props.state === "complete" && props.canFollowUp?.()) {
			handled = invoke(props.onFollowUp);
		} else if (matchesKey(event.data, "up")) {
			handled = move(-1);
		} else if (matchesKey(event.data, "down")) {
			handled = move(1);
		} else if (matchesKey(event.data, "pageUp")) {
			handled = move(-(Math.max(1, viewport()?.height ?? 1) - 1));
		} else if (matchesKey(event.data, "pageDown")) {
			handled = move(Math.max(1, viewport()?.height ?? 1) - 1);
		} else if (matchesKey(event.data, "home")) {
			handled = toStart();
		} else if (matchesKey(event.data, "end")) {
			handled = toEnd();
		}
		if (!handled) return;
		event.preventDefault();
		event.stopPropagation();
	};
	const handleMouse = (event: HostMouseEvent): void => {
		if (event.wheel === 0 || !move(event.wheel * 3)) return;
		event.preventDefault();
	};
	const onViewport = (next: ScrollViewportState): void => {
		setViewport(next);
		if (!followingTail()) setOffset(next.offset);
	};

	return (
		<Portal
			to="overlay"
			anchor="bottom-center"
			width={props.width ?? "100%"}
			maxHeight={props.maxHeight}
			mouseTracking
		>
			<box tabIndex={0} onKey={handleKey} onMouse={handleMouse}>
				<BtwPanelView
					title={props.title}
					state={props.state}
					visibleAnswer={props.visibleAnswer}
					errorMessage={props.errorMessage}
					footer={props.footer}
					footerStatus={props.footerStatus}
					bodyHeight={bodyHeight()}
					offset={followingTail() ? undefined : offset()}
					followTail={followingTail()}
					onViewport={onViewport}
				/>
			</box>
		</Portal>
	);
}

/** Open the /btw panel overlay on a TUI instance, returning a controller handle. */
export function openBtwPanel(
	tui: TUI,
	options: BtwPanelComponentOptions,
	opts?: { readonly width?: SizeValue },
): BtwPanelHandle {
	const baseTitle = `/btw ${replaceTabs(options.question)}`;
	const [title, setTitle] = createSignal(baseTitle);
	const [state, setState] = createSignal<BtwPanelState>("running");
	const [answer, setVisibleAnswer] = createSignal("");
	const [errorMessage, setErrorMessage] = createSignal<string | undefined>();
	const [copied, setCopied] = createSignal(false);
	let rawAnswer = "";
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		overlay?.dispose();
	};

	const resetCopied = (): void => {
		setCopied(false);
		setTitle(baseTitle);
	};
	const updateAnswer = (nextAnswer: string): void => {
		rawAnswer = nextAnswer;
		setVisibleAnswer(visibleAnswer(nextAnswer));
		resetCopied();
	};
	const presentation = (): BtwFooterPresentation =>
		footerPresentation(state(), answer(), copied(), options.canBranch, options.canFollowUp);
	const overlay = mountOverlay(tui, () => {
		const footer = presentation();
		return (
			<BtwPanel
				title={title()}
				state={state()}
				visibleAnswer={answer()}
				errorMessage={errorMessage()}
				footer={footer.segments}
				footerStatus={footer.status}
				canBranch={options.canBranch}
				canFollowUp={options.canFollowUp}
				onCancel={options.onCancel}
				onClose={options.onClose}
				onCopy={options.onCopy}
				onBranch={options.onBranch}
				onFollowUp={options.onFollowUp}
				onDismiss={close}
				maxHeight={tui.terminal.rows}
				width={opts?.width}
			/>
		);
	});

	return Object.assign(close, {
		hide: close,
		dispose: close,
		appendText(delta: string): void {
			if (!delta || closed) return;
			updateAnswer(rawAnswer + delta);
		},
		setAnswer(text: string): void {
			if (closed) return;
			updateAnswer(text);
		},
		setStatus(nextState: BtwPanelState): void {
			if (closed) return;
			setState(nextState);
			if (nextState !== "error") setErrorMessage(undefined);
			resetCopied();
		},
		markBranching(): void {
			if (closed) return;
			setState("branching");
			setErrorMessage(undefined);
			resetCopied();
		},
		markAborted(): void {
			if (closed) return;
			setState("aborted");
			setErrorMessage(undefined);
			resetCopied();
		},
		markError(message: string): void {
			if (closed) return;
			setState("error");
			setErrorMessage(message);
			resetCopied();
		},
		markComplete(): void {
			if (closed) return;
			setState("complete");
			setErrorMessage(undefined);
			resetCopied();
		},
		markCopied(): void {
			if (closed || !isCopyable(state(), answer())) return;
			setCopied(true);
			setTitle(`${baseTitle} ✓ Copied`);
		},
		isBranchable(): boolean {
			return isCopyable(state(), answer());
		},
		isCopyable(): boolean {
			return isCopyable(state(), answer());
		},
		getCopyText(): string | undefined {
			return isCopyable(state(), answer()) ? answer() : undefined;
		},
		close,
	});
}

export function BtwPanelComponent(options: BtwPanelComponentOptions): BtwPanelHandle {
	return openBtwPanel(options.tui, options);
}

export const showBtwPanel = openBtwPanel;
