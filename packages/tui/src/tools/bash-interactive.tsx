import type { Terminal as XtermTerminalType } from "@oh-my-pi/pi-utils/vterm";
import { extractPrintableText, matchesKey, parseKey, parseKittySequence } from "../keys";
import { replaceTabs } from "../render/render-utils";
import type { SymbolKey } from "../theme/symbols";
import type { Theme } from "../theme/theme";
import type { TUI } from "../tui";
import { mountOverlay, type OverlayDisposer, Portal } from "../host/overlay";
import type { BorrowedTerminalSession } from "../host/elements/terminal";
import { createMemo, createSignal, onCleanup, Show, useTheme, useViewport, type Accessor, type JSX } from "../reactive";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";

export type { BorrowedTerminalSession };

/** Resize-only backend exposed by an interactive PTY controller. */
export interface BashInteractiveTerminalBackend {
	resize(columns: number, rows: number): void;
}

// The capture sink owns final output; this caps only the live display backlog.
const MAX_LIVE_WRITE_QUEUE_CHUNKS = 512;

export function normalizeInputForPty(data: string, applicationCursorKeysMode: boolean): string {
	const kitty = parseKittySequence(data);
	if (kitty?.eventType === 3) {
		return "";
	}
	const printableText = extractPrintableText(data);
	if (printableText) {
		return printableText;
	}
	if (!kitty) {
		return data;
	}
	const keyId = parseKey(data);
	if (!keyId) {
		return data;
	}
	const normalizedKey = keyId.toLowerCase();
	if (normalizedKey === "up") return applicationCursorKeysMode ? "\x1bOA" : "\x1b[A";
	if (normalizedKey === "down") return applicationCursorKeysMode ? "\x1bOB" : "\x1b[B";
	if (normalizedKey === "right") return applicationCursorKeysMode ? "\x1bOC" : "\x1b[C";
	if (normalizedKey === "left") return applicationCursorKeysMode ? "\x1bOD" : "\x1b[D";
	if (normalizedKey === "home") return applicationCursorKeysMode ? "\x1bOH" : "\x1b[H";
	if (normalizedKey === "end") return applicationCursorKeysMode ? "\x1bOF" : "\x1b[F";
	if (normalizedKey === "pageup") return "\x1b[5~";
	if (normalizedKey === "pagedown") return "\x1b[6~";
	if (normalizedKey === "insert") return "\x1b[2~";
	if (normalizedKey === "delete") return "\x1b[3~";
	if (normalizedKey === "shift+tab") return "\x1b[Z";
	if (normalizedKey === "enter") return "\r";
	if (normalizedKey === "tab") return "\t";
	if (normalizedKey === "space") return " ";
	if (normalizedKey === "backspace") return "\x7f";
	if (normalizedKey === "escape") return "\x1b";
	const ctrlMatch = /^ctrl\+([a-z])$/u.exec(normalizedKey);
	if (ctrlMatch) {
		const letter = ctrlMatch[1]!;
		return String.fromCharCode(letter.charCodeAt(0) - 96);
	}
	const altMatch = /^alt\+([a-z])$/u.exec(normalizedKey);
	if (altMatch) {
		return `\x1b${altMatch[1]!}`;
	}
	if (kitty.codepoint >= 32 && kitty.codepoint < 127) {
		let ch = String.fromCharCode(kitty.codepoint);
		if (kitty.modifier & 4) {
			const code = kitty.codepoint;
			if (code >= 97 && code <= 122) {
				ch = String.fromCharCode(code - 96);
			}
		}
		if (kitty.modifier & 2) {
			ch = `\x1b${ch}`;
		}
		return ch;
	}
	return data;
}

/** Rebase a host SGR report from the terminal surface to the PTY viewport. */
export function normalizeMouseForPty(event: HostMouseEvent): string {
	const column = Math.max(1, event.localCol + 1);
	const row = Math.max(1, event.localRow + 1);
	return `\x1b[<${event.rawButton};${column};${row}${event.action === "up" ? "m" : "M"}`;
}

/** Frame literal clipboard text only when the PTY requested DECSET 2004. */
export function normalizePasteForPty(text: string, bracketedPasteMode: boolean): string {
	return bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
}

export type BashInteractiveState = "running" | "complete" | "timed_out" | "killed";
export type BashInteractiveStateSource = BashInteractiveState | Accessor<BashInteractiveState>;
export type BashInteractiveExitCodeSource = number | undefined | Accessor<number | undefined>;

export interface BashInteractiveOverlayProps {
	readonly command: string;
	readonly session: BorrowedTerminalSession;
	readonly state: BashInteractiveStateSource;
	readonly exitCode?: BashInteractiveExitCodeSource;
	/** Explicit content height for embedders; fullscreen overlays otherwise use 80% of the live viewport. */
	readonly rows?: number;
	readonly onDismiss?: () => void;
	readonly onInput?: (data: string) => void;
	readonly onDispose?: () => void;
}

function currentState(source: BashInteractiveStateSource): BashInteractiveState {
	return typeof source === "function" ? source() : source;
}

function currentExitCode(source: BashInteractiveExitCodeSource): number | undefined {
	return typeof source === "function" ? source() : source;
}

function completionLabel(
	state: BashInteractiveState,
	exitCode: number | undefined,
): { text: string; color: "warning" | "success" | "error" } {
	if (state === "running") return { text: "running", color: "warning" };
	if (state === "timed_out") return { text: "timed out", color: "warning" };
	if (state === "killed") return { text: "killed", color: "warning" };
	if (exitCode === 0) return { text: "exit 0", color: "success" };
	if (exitCode === undefined) return { text: "exited", color: "warning" };
	return { text: `exit ${exitCode}`, color: "error" };
}

interface BashInteractiveTerminalFrameProps {
	readonly command: string;
	readonly session: BorrowedTerminalSession;
	readonly state: Accessor<BashInteractiveState>;
	readonly exitCode: Accessor<number | undefined>;
	readonly rows: Accessor<number>;
	readonly onMouse?: (event: HostMouseEvent) => void;
}

/** Shared retained frame which preserves the former interactive PTY overlay chrome. */
function BashInteractiveTerminalFrame(props: BashInteractiveTerminalFrameProps): JSX.Element {
	const { theme } = useTheme();
	const running = createMemo(() => props.state() === "running");
	const statusIcon = createMemo<SymbolKey>(() => {
		const state = props.state();
		if (state === "running") return "status.running";
		if (state === "complete" && props.exitCode() === 0) return "tool.bash";
		return "status.warning";
	});
	const statusColor = createMemo<"accent" | "warning">(() =>
		props.state() === "complete" && props.exitCode() === 0
			? "accent"
			: props.state() === "running"
				? "accent"
				: "warning",
	);
	const stateInfo = createMemo(() => completionLabel(props.state(), props.exitCode()));
	const command = createMemo(() => replaceTabs(props.command));

	return (
		<frame border paddingX={0} paddingY={0} borderColor="border" fitContent>
			<row gap={1}>
				<icon name={statusIcon()} color={statusColor()} shrink={0} />
				<text color="accent" shrink={0} wrap="none">
					Console
				</text>
				<text color="muted" grow={1} shrink={1} minWidth={1} wrap="none" overflow="clip">
					{command()}
				</text>
				<text shrink={0} wrap="none">
					<span color="dim">[</span>
					<span color={stateInfo().color}>{stateInfo().text}</span>
					<span color="dim">]</span>
				</text>
			</row>
			<terminal
				session={props.session}
				rows={props.rows()}
				style={theme().style("toolOutput")}
				onMouse={props.onMouse}
			/>
			<Show
				when={running()}
				fallback={
					<text wrap="none" overflow="clip">
						<span color="dim">session finished</span>
					</text>
				}
			>
				<text wrap="none" overflow="clip">
					<span color="warning">esc</span>
					<span> </span>
					<span color="dim">force-kill</span>
					<span> </span>
					<span color="dim">· input forwarded to PTY</span>
				</text>
			</Show>
		</frame>
	);
}

/** Reactive fullscreen interactive bash overlay hosted via Portal. */
export function BashInteractiveOverlay(props: BashInteractiveOverlayProps): JSX.Element {
	const viewport = useViewport();
	const state = () => currentState(props.state);
	const exitCode = () => currentExitCode(props.exitCode);
	const rows = createMemo(() => {
		if (props.rows !== undefined) return props.rows;
		return Math.max(1, Math.max(5, Math.floor(viewport().rows * 0.8)) - 4);
	});
	const running = createMemo(() => state() === "running");

	onCleanup(() => {
		props.onDispose?.();
	});

	const handleKey = (event: HostKeyEvent): void => {
		if (!running()) return;
		event.preventDefault();
		if (event.key === "escape" || event.key === "esc") {
			props.onDismiss?.();
			return;
		}
		const normalized = normalizeInputForPty(event.data, props.session.terminal.modes.applicationCursorKeysMode);
		if (normalized) props.onInput?.(normalized);
	};
	const handlePaste = (text: string): void => {
		if (running()) props.onInput?.(normalizePasteForPty(text, props.session.terminal.modes.bracketedPasteMode));
	};
	const handleMouse = (event: HostMouseEvent): void => {
		if (!running()) return;
		props.onInput?.(normalizeMouseForPty(event));
		event.preventDefault();
	};

	return (
		<Portal to="overlay" fullscreen mouseTracking>
			<box tabIndex={0} onKey={handleKey} onPaste={handlePaste}>
				<BashInteractiveTerminalFrame
					command={props.command}
					session={props.session}
					state={state}
					exitCode={exitCode}
					rows={rows}
					onMouse={handleMouse}
				/>
			</box>
		</Portal>
	);
}

export interface BashInteractiveOverlayViewProps {
	command: string;
	theme: Theme;
	state: BashInteractiveStateSource;
	exitCode?: BashInteractiveExitCodeSource;
	terminal: XtermTerminalType;
	getTerminalRows: () => number;
	onResize: (columns: number, rows: number) => void;
	revision?: number | Accessor<number>;
}

/** Adapts an xterm terminal and backend into a BorrowedTerminalSession. */
export function createBorrowedTerminalSession(
	terminal: XtermTerminalType,
	backend: BashInteractiveTerminalBackend,
): BorrowedTerminalSession & { notify(): void } {
	const listeners = new Set<() => void>();
	return {
		terminal,
		attach(onFrame: () => void): () => void {
			listeners.add(onFrame);
			return () => listeners.delete(onFrame);
		},
		resize(columns: number, rows: number): void {
			terminal.resize(columns, rows);
			try {
				backend.resize(columns, rows);
			} catch {
				// Session may have closed
			}
		},
		notify(): void {
			for (const listener of listeners) listener();
		},
	};
}

/** Interactive terminal overlay view for retained frames. */
export function BashInteractiveOverlayView(props: BashInteractiveOverlayViewProps): JSX.Element {
	const viewport = useViewport();
	const state = () => currentState(props.state);
	const exitCode = () => currentExitCode(props.exitCode);
	const rows = createMemo(() => {
		void viewport();
		const maxOverlayRows = Math.max(5, Math.floor(props.getTerminalRows() * 0.8));
		return Math.max(1, maxOverlayRows - 4);
	});
	const session = createMemo<BorrowedTerminalSession>(() => {
		if (typeof props.revision === "function") props.revision();
		return {
			terminal: props.terminal,
			attach: () => () => {},
			resize(columns: number, terminalRows: number): void {
				props.terminal.resize(columns, terminalRows);
				props.onResize(columns, terminalRows);
			},
		};
	});

	return (
		<BashInteractiveTerminalFrame
			command={props.command}
			session={session()}
			state={state}
			exitCode={exitCode}
			rows={rows}
		/>
	);
}

/** Interactive terminal overlay driven by an external PTY controller (transition bridge). */
export class BashInteractiveSession {
	readonly terminal: XtermTerminalType;
	readonly borrowedTerminal: BorrowedTerminalSession & { notify(): void };
	readonly #state = createSignal<"running" | "complete" | "timed_out" | "killed">("running");
	readonly #exitCode = createSignal<number | undefined>(undefined);
	#onInput: (data: string) => void = () => {};
	#onDismiss: () => void = () => {};
	#onDispose: () => void = () => {};
	#writeQueue: string[] = [];
	#writeOffset = 0;
	#flushResolvers: Array<() => void> = [];
	#writing = false;
	#disposed = false;

	constructor(
		readonly command: string,
		terminalCtor: typeof XtermTerminalType,
		backend: BashInteractiveTerminalBackend,
	) {
		this.terminal = new terminalCtor({
			cols: 120,
			rows: 40,
			disableStdin: true,
			allowProposedApi: true,
			scrollback: 10_000,
		});
		this.borrowedTerminal = createBorrowedTerminalSession(this.terminal, backend);
	}

	state(): "running" | "complete" | "timed_out" | "killed" {
		return this.#state[0]();
	}

	exitCode(): number | undefined {
		return this.#exitCode[0]();
	}

	setHandlers(onInput: (data: string) => void, onDismiss: () => void, onDispose: () => void): void {
		this.#onInput = onInput;
		this.#onDismiss = onDismiss;
		this.#onDispose = onDispose;
	}

	appendOutput(chunk: string): void {
		this.#writeQueue.push(chunk);
		this.#trimWriteQueue();
		this.#drainQueue();
	}

	#trimWriteQueue(): void {
		if (this.#writeOffset > 0) {
			this.#writeQueue.splice(0, this.#writeOffset);
			this.#writeOffset = 0;
		}
		const firstPending = this.#writing ? 1 : 0;
		const overflow = this.#writeQueue.length - firstPending - MAX_LIVE_WRITE_QUEUE_CHUNKS;
		if (overflow > 0) {
			this.#writeQueue.splice(firstPending, overflow);
			this.#writeQueue[firstPending] = `\u001b\\${this.#writeQueue[firstPending]}`;
		}
	}

	#drainQueue(): void {
		if (this.#writing) return;
		if (this.#writeOffset >= this.#writeQueue.length) {
			this.#resolveFlushWaiters();
			return;
		}
		this.#writing = true;
		const data = this.#writeQueue[this.#writeOffset]!;
		this.terminal.write(data, () => {
			this.#writing = false;
			this.#writeOffset += 1;
			if (this.#writeOffset >= this.#writeQueue.length) {
				this.#writeQueue = [];
				this.#writeOffset = 0;
				this.#resolveFlushWaiters();
			}
			this.borrowedTerminal.notify();
			this.#drainQueue();
		});
	}

	#resolveFlushWaiters(): void {
		if (this.#writing || this.#writeOffset < this.#writeQueue.length || this.#flushResolvers.length === 0) return;
		const resolvers = this.#flushResolvers;
		this.#flushResolvers = [];
		for (const resolve of resolvers) resolve();
	}

	flushOutput(): Promise<void> {
		if (!this.#writing && this.#writeOffset >= this.#writeQueue.length) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#flushResolvers.push(resolve);
		return promise;
	}

	setComplete(result: { exitCode: number | undefined; cancelled: boolean; timedOut: boolean }): void {
		this.#exitCode[1](result.exitCode);
		if (result.timedOut) this.#state[1]("timed_out");
		else if (result.cancelled) this.#state[1]("killed");
		else this.#state[1]("complete");
	}

	handleInput(data: string): void {
		if (this.state() === "running" && (matchesKey(data, "escape") || matchesKey(data, "esc"))) {
			this.#onDismiss();
			return;
		}
		if (this.state() !== "running") return;
		const normalizedInput = normalizeInputForPty(data, this.terminal.modes.applicationCursorKeysMode);
		if (normalizedInput) this.#onInput(normalizedInput);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.terminal.dispose();
		this.#onDispose();
	}
}

/** Mount an interactive PTY as a reactive fullscreen overlay. */
export function openBashInteractiveOverlay(tui: TUI, session: BashInteractiveSession): OverlayDisposer {
	return mountOverlay(tui, () => (
		<BashInteractiveOverlay
			command={session.command}
			session={session.borrowedTerminal}
			state={() => session.state()}
			exitCode={() => session.exitCode()}
			onInput={data => session.handleInput(data)}
			onDismiss={() => session.handleInput("\x1b")}
			onDispose={() => session.dispose()}
		/>
	));
}
