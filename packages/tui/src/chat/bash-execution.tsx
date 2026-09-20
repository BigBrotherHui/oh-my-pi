import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Terminal as XtermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { createDocument } from "../document/document";
import { ImageView } from "../components/image";
import { getImageDimensions, imageFallback } from "../terminal-capabilities";
import { loadXtermTerminal, readTerminalRows } from "../tools/terminal-output";
import { formatArtifactErrorNotice, formatTruncationMetaNotice, type OutputMeta } from "../tools/output-meta";
import { resolveImageOptions } from "../render/render-utils";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	Show,
	useTheme,
	useViewport,
	type Accessor,
	type JSX,
} from "../reactive";

/** Number of output rows retained by a collapsed user shell execution. */
export const BASH_EXECUTION_PREVIEW_LINES = 20;

const STREAMING_LINE_CAP = BASH_EXECUTION_PREVIEW_LINES * 5;
const CHUNK_THROTTLE_MS = 50;
const PTY_SCROLLBACK_ROWS = 4_096;
const MAX_PTY_QUEUE_CHUNKS = 512;

export type BashExecutionSource<T> = T | Accessor<T>;

export interface BashExecutionCompletion {
	readonly output?: string;
	readonly meta?: OutputMeta;
	readonly images?: readonly ImageContent[];
	readonly showImages?: boolean;
}

/**
 * Live state for a user-invoked shell execution.
 *
 * The view model owns the lossy streaming preview and the lossless PTY replay;
 * callers feed it sanitized ordinary output and raw PTY bytes independently.
 * Await {@link setComplete} before retiring a live transcript row when PTY
 * output is in use, so queued xterm writes cannot be dropped during settlement.
 */
export class BashExecutionStream {
	readonly #outputSignal = createSignal("");
	readonly #exitCodeSignal = createSignal<number | undefined>(undefined);
	readonly #cancelledSignal = createSignal(false);
	readonly #runningSignal = createSignal(true);
	readonly #metaSignal = createSignal<OutputMeta | undefined>(undefined);
	readonly #imagesSignal = createSignal<readonly ImageContent[]>([]);
	readonly #showImagesSignal = createSignal(true);
	readonly #ptyModeSignal = createSignal(false);
	readonly #finalizedSignal = createSignal(false);
	readonly #finalized: Promise<void>;
	readonly #resolveFinalized: () => void;

	#outputLines: string[] = [];
	#displayRefreshScheduled = false;
	#displayRefreshTimer: NodeJS.Timeout | undefined;
	#ptyMode = false;
	#ptyTerminal: XtermTerminal | undefined;
	#ptyLoadStarted = false;
	#ptyWriting = false;
	#ptyQueue: string[] = [];
	#completionRequested = false;
	#disposed = false;
	#viewport = { cols: 78, rows: 20 };

	readonly output = this.#outputSignal[0];
	readonly exitCode = this.#exitCodeSignal[0];
	readonly cancelled = this.#cancelledSignal[0];
	readonly running = this.#runningSignal[0];
	readonly meta = this.#metaSignal[0];
	readonly images = this.#imagesSignal[0];
	readonly showImages = this.#showImagesSignal[0];
	readonly ptyMode = this.#ptyModeSignal[0];
	readonly finalized = this.#finalizedSignal[0];

	constructor() {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#finalized = promise;
		this.#resolveFinalized = resolve;
	}

	/** Append sanitized ordinary output. PTY output must use {@link appendPtyChunk}. */
	appendOutput(chunk: string): void {
		if (this.#disposed || this.#ptyMode || !chunk) return;

		const incomingLines = chunk.split("\n");
		if (this.#outputLines.length > 0 && incomingLines.length > 0) {
			const lastIndex = this.#outputLines.length - 1;
			const merged = [`${this.#outputLines[lastIndex]}${incomingLines[0]}`, ...incomingLines.slice(1)];
			this.#outputLines[lastIndex] = merged[0] ?? "";
			this.#outputLines.push(...merged.slice(1));
		} else {
			this.#outputLines.push(...incomingLines);
		}
		if (this.#outputLines.length > STREAMING_LINE_CAP) {
			this.#outputLines = this.#outputLines.slice(-STREAMING_LINE_CAP);
		}
		this.#scheduleDisplayRefresh();
	}

	/** Feed raw terminal bytes from a user-shell PTY through the headless replay terminal. */
	appendPtyChunk(chunk: string): void {
		if (this.#disposed || (!this.running() && !this.#ptyWriting && this.#ptyQueue.length === 0)) return;
		this.#ptyMode = true;
		this.#ptyModeSignal[1](true);
		this.#ptyQueue.push(chunk);
		if (this.#ptyQueue.length > MAX_PTY_QUEUE_CHUNKS) {
			const firstPending = this.#ptyWriting ? 1 : 0;
			this.#ptyQueue.splice(firstPending, this.#ptyQueue.length - firstPending - MAX_PTY_QUEUE_CHUNKS);
			this.#ptyQueue[firstPending] = `\u001b\\${this.#ptyQueue[firstPending] ?? ""}`;
		}
		this.#startPtyReplay();
		this.#drainPtyQueue();
	}

	/** Current replay-terminal dimensions, suitable for an executor PTY request. */
	getPtyViewport(): { readonly cols: number; readonly rows: number } {
		return this.#viewport;
	}

	/** Resize the replay terminal to the current execution-frame interior. */
	setPtyViewport(cols: number, rows: number): void {
		const next = { cols: Math.max(20, Math.trunc(cols)), rows: Math.max(5, Math.trunc(rows)) };
		if (next.cols === this.#viewport.cols && next.rows === this.#viewport.rows) return;
		this.#viewport = next;
		if (!this.#ptyTerminal) return;
		this.#ptyTerminal.resize(next.cols, next.rows);
		this.#refreshPtyLines(false);
	}

	/**
	 * Finalize the execution. The returned promise waits for any queued PTY data
	 * to reach the replay terminal and be snapshotted into immutable rows.
	 */
	setComplete(exitCode: number | undefined, cancelled: boolean, options: BashExecutionCompletion = {}): Promise<void> {
		if (this.#disposed) return this.#finalized;
		this.#completionRequested = true;
		this.#exitCodeSignal[1](exitCode);
		this.#cancelledSignal[1](cancelled);
		this.#metaSignal[1](options.meta);
		this.#imagesSignal[1](options.images ?? []);
		this.#showImagesSignal[1](options.showImages ?? true);
		this.#runningSignal[1](false);
		if (options.output !== undefined && !this.#ptyMode) this.#setOutput(options.output);
		if (this.#ptyMode) {
			this.#drainPtyQueue();
			if (!this.#ptyWriting && this.#ptyQueue.length === 0) this.#finalizePtyOutput();
		} else {
			this.#markFinalized();
		}
		return this.#finalized;
	}

	/** Release a still-running replay terminal when its owning command is abandoned. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#displayRefreshTimer !== undefined) clearTimeout(this.#displayRefreshTimer);
		this.#displayRefreshTimer = undefined;
		this.#displayRefreshScheduled = false;
		this.#ptyQueue = [];
		this.#ptyTerminal?.dispose();
		this.#ptyTerminal = undefined;
		this.#markFinalized();
	}

	getOutput(): string {
		return this.output();
	}

	#publishOutput(): void {
		this.#outputSignal[1](this.#outputLines.join("\n"));
	}

	#startPtyReplay(): void {
		if (this.#ptyLoadStarted) return;
		this.#ptyLoadStarted = true;
		void loadXtermTerminal().then(Terminal => {
			if (this.#disposed) return;
			this.#ptyTerminal = new Terminal({
				cols: this.#viewport.cols,
				rows: this.#viewport.rows,
				disableStdin: true,
				allowProposedApi: true,
				scrollback: PTY_SCROLLBACK_ROWS,
			});
			this.#drainPtyQueue();
		});
	}

	#drainPtyQueue(): void {
		const terminal = this.#ptyTerminal;
		if (!terminal || this.#ptyWriting || this.#disposed) return;
		const chunk = this.#ptyQueue.shift();
		if (chunk === undefined) {
			if (this.#completionRequested) this.#finalizePtyOutput();
			return;
		}
		this.#ptyWriting = true;
		terminal.write(chunk, () => {
			this.#ptyWriting = false;
			this.#scheduleDisplayRefresh();
			this.#drainPtyQueue();
		});
	}

	/**
	 * Publish immediately, then one trailing snapshot per throttle window.
	 * Every source chunk is already retained before this runs; the timer only
	 * coalesces reactive redraws, never input ingestion.
	 */
	#scheduleDisplayRefresh(): void {
		if (this.#displayRefreshScheduled) return;
		this.#displayRefreshScheduled = true;
		this.#publishCurrentDisplay();
		this.#displayRefreshTimer = setTimeout(() => {
			this.#displayRefreshScheduled = false;
			this.#displayRefreshTimer = undefined;
			this.#publishCurrentDisplay();
		}, CHUNK_THROTTLE_MS);
	}

	#publishCurrentDisplay(): void {
		if (this.#ptyMode) this.#refreshPtyLines(false);
		else this.#publishOutput();
	}

	#refreshPtyLines(full: boolean): void {
		const terminal = this.#ptyTerminal;
		if (!terminal) return;
		const buffer = terminal.buffer.active;
		const startRow = full ? 0 : Math.max(0, buffer.length - STREAMING_LINE_CAP);
		const rows = readTerminalRows(terminal, startRow, buffer.length - startRow);
		while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
		this.#outputLines = rows;
		this.#publishOutput();
	}

	#finalizePtyOutput(): void {
		const terminal = this.#ptyTerminal;
		if (!terminal) return;
		this.#refreshPtyLines(true);
		this.#ptyTerminal = undefined;
		terminal.dispose();
		this.#markFinalized();
	}

	#markFinalized(): void {
		if (this.finalized()) return;
		this.#finalizedSignal[1](true);
		this.#resolveFinalized();
	}

	#setOutput(output: string): void {
		this.#outputLines = output.length === 0 ? [] : output.split("\n");
		this.#publishOutput();
	}
}

export interface BashExecutionViewProps {
	readonly command: string;
	/** Completed transcript output; omit when rendering a {@link BashExecutionStream}. */
	readonly output?: BashExecutionSource<string>;
	readonly exitCode?: BashExecutionSource<number | undefined>;
	readonly cancelled?: BashExecutionSource<boolean>;
	readonly running?: BashExecutionSource<boolean>;
	readonly expanded: BashExecutionSource<boolean>;
	readonly excludeFromContext?: boolean;
	readonly meta?: BashExecutionSource<OutputMeta | undefined>;
	readonly images?: BashExecutionSource<readonly ImageContent[] | undefined>;
	readonly showImages?: BashExecutionSource<boolean>;
	readonly stream?: BashExecutionStream;
}

function isBashExecutionAccessor<T>(value: BashExecutionSource<T> | undefined): value is Accessor<T> {
	return typeof value === "function";
}

function sourceValue<T>(value: BashExecutionSource<T> | undefined, fallback: T): T {
	if (isBashExecutionAccessor(value)) return value();
	return value ?? fallback;
}

function BashOutputView(props: {
	readonly output: Accessor<string>;
	readonly expanded: Accessor<boolean>;
}): JSX.Element {
	const document = createDocument("");
	createEffect(() => {
		document.apply({ kind: "reset", text: props.output() });
	});
	return (
		<preview
			document={document}
			edge="tail"
			limit={props.expanded() ? Number.MAX_SAFE_INTEGER : BASH_EXECUTION_PREVIEW_LINES}
			unit="rows"
			ansi
			preserveSixel
			maxLineCells={4_000}
			trimEnd
			reserveSummary={false}
			color="muted"
			hiddenLabel={hidden => `… ${hidden} more lines (ctrl+o to expand)`}
		/>
	);
}

function BashExecutionFooter(props: {
	readonly exitCode: Accessor<number | undefined>;
	readonly cancelled: Accessor<boolean>;
	readonly meta: Accessor<OutputMeta | undefined>;
}): JSX.Element {
	const hasFooter = createMemo(() => {
		const meta = props.meta();
		return (
			props.cancelled() ||
			(props.exitCode() !== undefined && props.exitCode() !== 0) ||
			meta?.truncation !== undefined ||
			meta?.artifactError !== undefined
		);
	});
	return (
		<Show when={hasFooter()}>
			<br />
			<stack>
				<Show when={props.cancelled()}>
					<text color="warning">(cancelled)</text>
				</Show>
				<Show when={!props.cancelled() && props.exitCode() !== undefined && props.exitCode() !== 0}>
					<text color="error">{`(exit ${props.exitCode()})`}</text>
				</Show>
				<Show when={props.meta()?.truncation}>
					<text color="warning">
						{formatTruncationMetaNotice(props.meta()!.truncation!, props.meta()!.source)}
					</text>
				</Show>
				<Show when={props.meta()?.artifactError}>
					<text color="warning">{formatArtifactErrorNotice(props.meta()!.artifactError!)}</text>
				</Show>
			</stack>
		</Show>
	);
}

/** User-invoked local shell execution, faithful to the original transcript block. */
export function BashExecutionView(props: BashExecutionViewProps): JSX.Element {
	const viewport = useViewport();
	const { capabilities, theme } = useTheme();
	const instanceId = nextBashExecutionViewId++;
	const output = () => (props.stream ? props.stream.output() : sourceValue(props.output, ""));
	const exitCode = () => (props.stream ? props.stream.exitCode() : sourceValue(props.exitCode, undefined));
	const cancelled = () => (props.stream ? props.stream.cancelled() : sourceValue(props.cancelled, false));
	const running = () => (props.stream ? props.stream.running() : sourceValue(props.running, false));
	const expanded = () => sourceValue(props.expanded, false);
	const meta = () => (props.stream ? props.stream.meta() : sourceValue(props.meta, undefined));
	const images = () => (props.stream ? props.stream.images() : (sourceValue(props.images, undefined) ?? []));
	const showImages = () => (props.stream ? props.stream.showImages() : sourceValue(props.showImages, true));
	const borderColor = props.excludeFromContext ? "dim" : "bashMode";
	const hasOutput = createMemo(() => output().length > 0);

	createEffect(() => {
		const size = viewport();
		props.stream?.setPtyViewport(size.columns - 2, size.rows - 4);
	});
	return (
		<stack>
			<hr variant="full" ruleColor={borderColor} />
			<box padding={{ x: 1 }}>
				<stack>
					<text color={borderColor}>{`$ ${props.command}`}</text>
					<Show when={hasOutput()}>
						<br />
						<BashOutputView output={output} expanded={expanded} />
					</Show>
					<For each={images()}>
						{(image, index) => (
							<Show
								when={showImages() && capabilities.imageProtocol !== null}
								fallback={
									<text color="muted">
										{imageFallback(
											image.mimeType,
											getImageDimensions(image.data, image.mimeType) ?? undefined,
										)}
									</text>
								}
							>
								<ImageView
									base64Data={image.data}
									mimeType={image.mimeType}
									theme={{ fallbackStyle: theme().style("toolOutput") }}
									options={{ ...resolveImageOptions(), imageKey: `bash-execution:${instanceId}:${index()}` }}
								/>
							</Show>
						)}
					</For>
					<Show when={running()}>
						<row gap={1}>
							<spinner color={borderColor} />
							<text color="muted">Running… (esc to cancel)</text>
						</row>
					</Show>
					<Show when={!running()}>
						<BashExecutionFooter exitCode={exitCode} cancelled={cancelled} meta={meta} />
					</Show>
				</stack>
			</box>
			<hr variant="full" ruleColor={borderColor} />
		</stack>
	);
}

let nextBashExecutionViewId = 0;
