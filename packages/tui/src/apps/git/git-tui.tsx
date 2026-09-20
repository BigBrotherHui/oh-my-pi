/**
 * `omp git` — fullscreen repository TUI.
 *
 * Layout: header (file path, encoding, stage-file button, close), toolbar
 * (scope chip, file/diff toggle, hunk navigation, hunk/inline/split view
 * buttons, whitespace + word-wrap toggles), center diff pane with a minimap
 * scrollbar, right sidebar (file management + commit form while dirty, HEAD
 * commit details with author avatar when clean). Submitting an empty commit
 * form generates an llm-git-compatible message; submitting populated fields
 * commits them. A footer shows key hints.
 *
 * `tab` moves focus between the diff and the sidebar; both panes take
 * arrows/PgUp/PgDn, vim motions (`j`/`k`/`h`/`l`/`g`/`G`), and mouse
 * clicks/wheel. All toolbar buttons are clickable and mirrored by keys:
 * `v` cycles the view (`1`–`4` pick one), `alt+↓`/`alt+↑` jump hunks and roll
 * into the adjacent file at the edges, `]`/`[` switch files, `s`/`u`
 * stage/unstage (hunk-aware), `x` discards a hunk, `delete` discards the
 * whole file (press twice to confirm), `w` wraps, `b` cycles
 * whitespace handling (exact → ignore whitespace → ignore
 * formatting/import-only changes), `c` jumps to the commit form, `r`
 * refreshes. In the sidebar tree `←`/`→` collapse/expand directories,
 * `enter` opens the selected file in the diff pane, `space` stages or
 * unstages the selected row, and `delete` discards it — on a directory,
 * every file underneath it.
 */

import { matchesKey } from "../../keys";
import { routeSgrMouseInput } from "../../mouse";
import { ProcessTerminal, type Terminal } from "../../terminal";
import { theme, warmHighlighter } from "../../theme/theme";
import { createSignal, onCleanup, onMount, useClock, useFocus, useTui, useViewport, type JSX } from "../../reactive";
import { type HostKeyEvent, type HostMouseEvent } from "../../host/input";
import { mountOverlay, Portal } from "../../host/overlay";
import { type ImageBudget } from "../../host/elements/image";
import { spaces, takeCells } from "../../core/out";
import { Attr, Style } from "../../core/style";
import { TUI } from "../../tui";
import type { AvatarSource } from "./avatar";
import { pill, Runs, runsWidth, softPill, type StyledRun, tintChip } from "./colors";
import {
	buildDiffDocument,
	buildLineSelectionPatch,
	DiffPane,
	type HunkAction,
	type HunkBlock,
	type ViewMode,
	type WhitespaceMode,
} from "./diff-pane";
import { Sidebar, type SidebarAction, type GitCommitMessage } from "./sidebar";
import type { ChangedFile, FileContents, GitTuiModel } from "./state";

/** AI staging counts displayed after filtering the working tree. */
export interface AiStageOutcome {
	matchedFiles: number;
	totalFiles: number;
	stagedHunks: number;
	totalHunks: number;
	wholeFiles: number;
}

/** Repository, avatar, and generation capabilities owned by the command host. */
export interface GitTuiHost {
	model: GitTuiModel;
	createAvatarSource(onReady: () => void): AvatarSource;
	aiStage(options: {
		cwd: string;
		instruction: string;
		files: readonly Pick<ChangedFile, "path" | "kind">[];
		signal?: AbortSignal;
		onProgress?: (message: string) => void;
	}): Promise<AiStageOutcome>;
	generateCommitMessage(options: {
		cwd: string;
		stageIfEmpty: boolean;
		signal?: AbortSignal;
		onProgress?: (message: string) => void;
	}): Promise<{ commit: GitCommitMessage; validationError?: string | null; stagedAll: boolean }>;
}

const REFRESH_MS = 2_000;
const STATUS_TTL_MS = 6_000;

type Focus = "diff" | "sidebar";

interface UiHit {
	from: number;
	to: number;
	action: () => void;
}

/** Toolbar/header icon set: codicons under the nerd symbol preset, unicode otherwise. */
function icons(): Record<"close" | "hunk" | "inline" | "split" | "file" | "ws" | "wrap" | "up" | "down", string> {
	if (theme.getSymbolPreset() === "nerd") {
		return {
			close: "",
			hunk: "",
			inline: "",
			split: "",
			file: "",
			ws: "",
			wrap: "",
			up: "",
			down: "",
		};
	}
	return { close: "✕", hunk: "⊟", inline: "≡", split: "◫", file: "▤", ws: "¶", wrap: "⏎", up: "↑", down: "↓" };
}

/** Accumulates one chrome row as plain styled runs plus clickable column ranges. */
class HitRow {
	readonly runs: StyledRun[] = [];
	width = 0;
	hits: UiHit[] = [];

	add(text: string, style: Style = Style.NONE): this {
		this.runs.push({ style, text });
		this.width += Bun.stringWidth(text);
		return this;
	}

	addRuns(runs: readonly StyledRun[]): this {
		this.runs.push(...runs);
		this.width += runsWidth(runs);
		return this;
	}

	button(runs: readonly StyledRun[], action: () => void): this {
		const from = this.width;
		this.addRuns(runs);
		this.hits.push({ from, to: this.width, action });
		return this;
	}
}

/** Toggle chip: accent-on-selected background when active, dim otherwise. */
function chip(label: string, active: boolean): readonly StyledRun[] {
	return softPill(` ${label} `, { active });
}

function clipPlain(text: string, width: number): string {
	if (width <= 0) return "";
	if (Bun.stringWidth(text) <= width) return text;
	if (width === 1) return "…";
	return `${takeCells(text, width - 1)}…`;
}

function ChromeRowView({ runs, width }: { runs: readonly StyledRun[]; width: number }): JSX.Element {
	const total = runsWidth(runs);
	if (total <= width)
		return (
			<text wrap="none">
				<Runs runs={runs} />
			</text>
		);
	let remaining = Math.max(0, width - 1);
	const shown: StyledRun[] = [];
	for (const run of runs) {
		if (remaining <= 0) break;
		const text = takeCells(run.text, remaining);
		if (text) shown.push({ style: run.style, text });
		remaining -= Bun.stringWidth(text);
	}
	return (
		<text wrap="none">
			<Runs runs={shown} />…
		</text>
	);
}

export class GitTuiController {
	readonly #terminal: Terminal;
	readonly #model: GitTuiModel;
	readonly #host: GitTuiHost;
	readonly #notify: () => void;
	readonly #now: () => number;
	readonly #pane: DiffPane;
	readonly #sidebar: Sidebar;
	readonly #highlightReady = warmHighlighter();
	readonly #done = Promise.withResolvers<void>();
	#focus: Focus = "sidebar";
	#currentFile: ChangedFile | null = null;
	#contents: FileContents | null = null;
	#whitespace: WhitespaceMode = "off";
	#loadSeq = 0;
	#loadAbort: AbortController | null = null;
	#highlightAbort: AbortController | null = null;
	#generationAbort: AbortController | null = null;
	#aiStageAbort: AbortController | null = null;
	#busy = false;
	#status = "";
	#statusStyle = Style.NONE;
	#statusAt = 0;
	#statusSticky = false;
	#centerWidth = 0;
	#contentHeight = 20;
	#headerHits: UiHit[] = [];
	#toolbarHits: UiHit[] = [];
	#pendingDiscard: string | null = null;
	/** After hopping files backwards, land on the last hunk once the diff loads. */
	#pendingHunkEdge: "last" | null = null;
	#disposed = false;

	constructor(terminal: Terminal, host: GitTuiHost, notify: () => void, now: () => number, imageBudget?: ImageBudget) {
		this.#terminal = terminal;
		this.#host = host;
		this.#notify = notify;
		this.#now = now;
		this.#model = host.model;
		this.#pane = new DiffPane(imageBudget);
		this.#pane.onHunkAction = (hunk, action) => void this.#hunkAction(hunk, action);
		this.#sidebar = new Sidebar({
			model: this.#model,
			avatars: host.createAvatarSource(() => this.#notify()),
			imageBudget,
			onSelectFile: file => this.#showFile(file),
			onAction: action => void this.#runAction(action),
			onFocusDiff: () => this.#setFocus("diff"),
			requestRender: () => this.#notify(),
		});
		this.#sidebar.setFocused(true);
	}

	async run(onReady?: () => void): Promise<void> {
		await this.refresh(true);
		if (!this.#disposed) onReady?.();
		return this.#done.promise;
	}

	async refresh(force = false): Promise<void> {
		await this.#refresh(force);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#loadAbort?.abort();
		this.#highlightAbort?.abort();
		this.#generationAbort?.abort();
		this.#aiStageAbort?.abort();
		this.#sidebar.dispose();
	}

	// ── data ───────────────────────────────────────────────────────────────

	async #refresh(force: boolean): Promise<void> {
		if (this.#disposed) return;
		try {
			const changed = await this.#model.refresh();
			if (!changed && !force) return;
			this.#syncSidebar(true);
			this.#loadDeferredDetails();
		} catch (error) {
			this.#setError(error);
		}
	}

	/** Reconcile model changes without reloading an unchanged diff for decoration-only updates. */
	#syncSidebar(reloadCurrent: boolean): void {
		const suggested = this.#sidebar.reconcile();
		const current = this.#currentFile;
		const stillExists =
			current &&
			[...this.#model.unstaged, ...this.#model.staged, ...(this.#model.headCommit?.files ?? [])].some(
				candidate => candidate.path === current.path && candidate.area === current.area,
			);
		const file = stillExists ? current : suggested;
		const sameFile = file !== null && current !== null && file.path === current.path && file.area === current.area;
		if (reloadCurrent || !sameFile) this.#showFile(file);
		this.#notify();
	}

	/** Load count/list details after the initial file list and diff are usable. */
	#loadDeferredDetails(): void {
		const apply = (changed: boolean): void => {
			if (changed && !this.#disposed) this.#syncSidebar(false);
		};
		const fail = (error: unknown): void => {
			if (!this.#disposed) this.#setError(error);
		};
		void this.#model.loadChangeStats().then(apply).catch(fail);
		if (this.#model.clean) void this.#model.loadHeadFiles().then(apply).catch(fail);
	}

	#patchTargetFor(file: ChangedFile | null): "stage" | "unstage" | null {
		if (!file) return null;
		if (file.area === "unstaged") return file.kind === "untracked" || file.kind === "conflicted" ? null : "stage";
		if (file.area === "staged") return "unstage";
		return null;
	}

	#showFile(file: ChangedFile | null): void {
		this.#loadAbort?.abort();
		this.#loadAbort = null;
		this.#highlightAbort?.abort();
		this.#highlightAbort = null;
		this.#currentFile = file;
		this.#contents = null;
		this.#pane.patchTarget = this.#patchTargetFor(file);
		const seq = ++this.#loadSeq;
		if (!file) {
			this.#pane.emptyMessage = this.#model.clean && !this.#model.headCommit ? "No commits yet" : "No changes";
			this.#pane.setDocument(null, "empty");
			this.#notify();
			return;
		}
		const abort = new AbortController();
		this.#loadAbort = abort;
		this.#pane.startStream(file.path);
		this.#notify();
		void this.#model
			.streamContents(
				file,
				update => {
					if (seq !== this.#loadSeq || this.#disposed) return;
					this.#pane.updateStream(update);
					this.#notify();
				},
				abort.signal,
			)
			.then(contents => {
				if (seq !== this.#loadSeq || this.#disposed) return;
				if (this.#loadAbort === abort) this.#loadAbort = null;
				this.#contents = contents;
				this.#rebuildDocument();
			})
			.catch(error => {
				if (seq !== this.#loadSeq || abort.signal.aborted) return;
				this.#pane.setDocument(null, "empty");
				this.#setError(error);
			});
	}

	/** Build the pane document from the cached contents (view toggles re-run this). */
	#rebuildDocument(): void {
		const file = this.#currentFile;
		const contents = this.#contents;
		if (!file || !contents) return;
		this.#highlightAbort?.abort();
		this.#highlightAbort = null;
		const edge = this.#pendingHunkEdge;
		this.#pendingHunkEdge = null;
		if (contents.kind === "asset") {
			this.#pane.setAsset(file.path, contents.old, contents.new);
		} else {
			this.#pane.setDocument(
				buildDiffDocument(contents.oldText, contents.newText, file.path, {
					whitespace: this.#whitespace,
					streamResult: contents.streamResult,
				}),
				"ready",
			);
			if (edge) this.#pane.seekHunk(edge);
			const abort = new AbortController();
			this.#highlightAbort = abort;
			void this.#highlightReady
				.then(() =>
					abort.signal.aborted ? undefined : this.#pane.highlightAsync(abort.signal, () => this.#notify()),
				)
				.catch(() => undefined);
		}
		this.#notify();
	}

	async #runAction(action: SidebarAction): Promise<void> {
		if (action.type === "discard") {
			// Two-step confirm keyed on the exact target, matching hunk/line discards.
			const key = action.selection.files.map(file => `${file.area}:${file.path}`).join("\0");
			if (this.#pendingDiscard !== key) {
				this.#pendingDiscard = key;
				this.#setStatus(
					`Discard changes to ${action.selection.label}? Press delete again to confirm`,
					theme.style("warning"),
				);
				return;
			}
			this.#pendingDiscard = null;
		}
		if (this.#busy) return;
		this.#busy = true;
		try {
			switch (action.type) {
				case "discard":
					await this.#model.discard(action.selection.files);
					this.#setStatus(`Discarded ${action.selection.label}`, theme.style("success"));
					break;
				case "stage":
					await this.#model.stage(action.selection?.files);
					this.#setStatus(
						action.selection ? `Staged ${action.selection.label}` : "Staged all changes",
						theme.style("success"),
					);
					break;
				case "unstage":
					await this.#model.unstage(action.selection?.files);
					this.#setStatus(
						action.selection ? `Unstaged ${action.selection.label}` : "Unstaged all changes",
						theme.style("success"),
					);
					break;
				case "stage-ai": {
					const abort = new AbortController();
					this.#aiStageAbort = abort;
					this.#setStatus(`Filtering changes: ${action.prompt}`, theme.style("accent"));
					try {
						const outcome = await this.#host.aiStage({
							cwd: this.#model.cwd,
							instruction: action.prompt,
							files: this.#model.unstaged,
							signal: abort.signal,
							onProgress: message => {
								if (!this.#disposed) this.#setStatus(message, theme.style("dim"));
							},
						});
						if (outcome.stagedHunks === 0 && outcome.wholeFiles === 0) {
							this.#setStatus(`No changes matched "${action.prompt}"`, theme.style("warning"));
						} else {
							const parts: string[] = [];
							if (outcome.stagedHunks > 0) parts.push(`${outcome.stagedHunks} of ${outcome.totalHunks} hunks`);
							if (outcome.wholeFiles > 0) {
								parts.push(`${outcome.wholeFiles} whole file${outcome.wholeFiles === 1 ? "" : "s"}`);
							}
							this.#setStatus(
								`Staged ${parts.join(" + ")} (${outcome.matchedFiles}/${outcome.totalFiles} files matched)`,
								theme.style("success"),
							);
						}
					} finally {
						if (this.#aiStageAbort === abort) this.#aiStageAbort = null;
					}
					break;
				}
				case "generate": {
					const abort = new AbortController();
					this.#generationAbort = abort;
					this.#sidebar.setGenerating(true);
					this.#setStatus("Generating commit message…", theme.style("accent"));
					try {
						const generated = await this.#host.generateCommitMessage({
							cwd: this.#model.cwd,
							stageIfEmpty: true,
							signal: abort.signal,
							onProgress: message => {
								if (!this.#disposed) this.#setStatus(message, theme.style("dim"));
							},
						});
						this.#sidebar.setGeneratedCommit(generated.commit);
						this.#setStatus(
							generated.validationError
								? `Generated message needs review: ${generated.validationError}`
								: generated.stagedAll
									? "Staged all changes and generated commit message"
									: "Generated commit message",
							theme.style(generated.validationError ? "warning" : "success"),
						);
					} finally {
						if (this.#generationAbort === abort) this.#generationAbort = null;
						this.#sidebar.setGenerating(false);
					}
					break;
				}
				case "commit": {
					if (action.stageAll) await this.#model.stage();
					await this.#model.commit(action.message, { amend: action.amend });
					this.#sidebar.clearForm();
					this.#setStatus(action.amend ? "Amended commit" : "Created commit", theme.style("success"));
					break;
				}
			}
			await this.#refresh(true);
		} catch (error) {
			this.#setError(error);
		} finally {
			this.#busy = false;
		}
	}

	async #hunkAction(hunk: HunkBlock, action: HunkAction): Promise<void> {
		if (!hunk.patch) return;
		if (action === "discard" && this.#pendingDiscard !== hunk.patch) {
			this.#pendingDiscard = hunk.patch;
			this.#setStatus("Discard hunk? Press x (or click) again to confirm", theme.style("warning"));
			return;
		}
		this.#pendingDiscard = null;
		if (this.#busy) return;
		this.#busy = true;
		try {
			if (action === "stage") await this.#model.applyPatch(hunk.patch, { cached: true });
			else if (action === "unstage") await this.#model.applyPatch(hunk.patch, { cached: true, reverse: true });
			else await this.#model.applyPatch(hunk.patch, { reverse: true });
			this.#setStatus(
				action === "stage" ? "Staged hunk" : action === "unstage" ? "Unstaged hunk" : "Discarded hunk",
				theme.style("success"),
			);
			await this.#refresh(true);
		} catch (error) {
			this.#setError(error);
		} finally {
			this.#busy = false;
		}
	}
	/** Stage/unstage/discard the shift-selected lines of the current file. */
	async #lineAction(action: HunkAction): Promise<void> {
		const doc = this.#pane.doc;
		const span = this.#pane.selection;
		if (!doc || !span) return;
		const intent = action === "stage" ? "apply" : "revert";
		const patch = buildLineSelectionPatch(doc, span.from, span.to, intent);
		if (!patch) {
			this.#setStatus("Selection contains no changes", theme.style("warning"));
			return;
		}
		if (action === "discard" && this.#pendingDiscard !== patch) {
			this.#pendingDiscard = patch;
			this.#setStatus("Discard selected lines? Press x again to confirm", theme.style("warning"));
			return;
		}
		this.#pendingDiscard = null;
		if (this.#busy) return;
		this.#busy = true;
		try {
			// stage: apply-intent patch into the index. unstage: revert-intent
			// patch into the index. discard: revert-intent patch onto the worktree.
			await this.#model.applyPatch(patch, { cached: action !== "discard" });
			this.#pane.clearSelection();
			this.#setStatus(
				action === "stage"
					? "Staged selection"
					: action === "unstage"
						? "Unstaged selection"
						: "Discarded selection",
				theme.style("success"),
			);
			await this.#refresh(true);
		} catch (error) {
			this.#setError(error);
		} finally {
			this.#busy = false;
		}
	}

	#setStatus(text: string, style: Style = Style.NONE): void {
		this.#status = text;
		this.#statusStyle = style;
		this.#statusAt = this.#now();
		this.#statusSticky = false;
		this.#notify();
	}
	/** Persistent single-line error status; provider/git messages may span lines. */
	#setError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.#setStatus(message.replace(/\s+/g, " ").trim(), theme.style("error"));
		this.#statusSticky = true;
	}

	// ── input ──────────────────────────────────────────────────────────────

	#setFocus(focus: Focus): void {
		this.#focus = focus;
		this.#sidebar.setFocused(focus === "sidebar");
		this.#pane.focused = focus === "diff";
		this.#notify();
	}

	#stageCurrentFile(): void {
		const file = this.#currentFile;
		if (!file) return;
		const selection = { files: [file], label: file.path };
		if (file.area === "unstaged") void this.#runAction({ type: "stage", selection });
		else if (file.area === "staged") void this.#runAction({ type: "unstage", selection });
	}

	/** `delete` in the diff pane: discard every change of the shown file. */
	#discardCurrentFile(): void {
		const file = this.#currentFile;
		if (!file || file.area === "commit") return;
		void this.#runAction({ type: "discard", selection: { files: [file], label: file.path } });
	}

	#setMode(mode: ViewMode): void {
		this.#pane.setMode(mode);
		this.#notify();
	}

	/** `b`/toolbar chip: exact → ignore whitespace → ignore formatting/imports. */
	#cycleWhitespace(): void {
		this.#whitespace =
			this.#whitespace === "off" ? "whitespace" : this.#whitespace === "whitespace" ? "formatting" : "off";
		this.#setStatus(
			this.#whitespace === "off"
				? "Showing all changes"
				: this.#whitespace === "whitespace"
					? "Ignoring whitespace-only line changes"
					: "Ignoring formatting and import-only changes",
			theme.style("dim"),
		);
		this.#rebuildDocument();
	}
	/** Alt+Down/Up: next/prev hunk, rolling into the adjacent file at the edges. */
	#jumpHunkOrFile(direction: 1 | -1): void {
		if (this.#pane.jumpHunk(direction)) {
			this.#notify();
			return;
		}
		this.#selectFile(direction, direction < 0 ? "last" : "first");
	}

	/** `]`/`[`: show the next/previous file; `edge` picks the landing hunk. */
	#selectFile(direction: 1 | -1, edge: "first" | "last" = "first"): void {
		this.#pendingHunkEdge = edge === "last" ? "last" : null;
		if (!this.#sidebar.selectAdjacentFile(direction, this.#currentFile)) this.#pendingHunkEdge = null;
		this.#notify();
	}

	handleKey(event: HostKeyEvent): void {
		this.handleInput(event.data);
		if (matchesKey(event.data, "tab") || matchesKey(event.data, "shift+tab")) event.preventDefault();
	}

	handleMouse(event: HostMouseEvent): void {
		const wheel = event.action === "wheel" && event.wheel !== 0 ? event.wheel : null;
		this.#routeMouse(
			event.localRow,
			event.localCol,
			wheel,
			event.action === "down" && (event.button & 3) === 0,
			event.shiftKey,
		);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.#done.resolve();
			return;
		}
		if (this.#handleMouse(data)) return;
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#setFocus(this.#focus === "diff" ? "sidebar" : "diff");
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.#focus === "sidebar" && this.#sidebar.handleEscape()) return;
			if (this.#focus === "diff" && this.#pane.clearSelection()) {
				this.#notify();
				return;
			}
			this.#done.resolve();
			return;
		}
		// Global shortcuts — active unless a commit-form input is capturing text.
		if (!(this.#focus === "sidebar" && this.#sidebar.editing)) {
			if (matchesKey(data, "q")) {
				this.#done.resolve();
				return;
			}
			// Ghostty on macOS reports Option as super+alt (kitty mod 11).
			if (matchesKey(data, "alt+down") || matchesKey(data, "super+alt+down")) return this.#jumpHunkOrFile(1);
			if (matchesKey(data, "alt+up") || matchesKey(data, "super+alt+up")) return this.#jumpHunkOrFile(-1);
			if (data === "]") return this.#selectFile(1);
			if (data === "[") return this.#selectFile(-1);
			if (data === "v") {
				this.#pane.cycleMode();
				this.#notify();
				return;
			}
			if (data === "1" || data === "2" || data === "3" || data === "4") {
				const modes: ViewMode[] = ["file", "split", "inline", "hunk"];
				return this.#setMode(modes[Number(data) - 1]);
			}
			if (data === "w") {
				this.#pane.toggleWrap();
				this.#notify();
				return;
			}
			if (data === "b") return this.#cycleWhitespace();
			if (data === "r") return void this.#refresh(true);
			if (data === "c") {
				if (this.#sidebar.focusCommitForm()) this.#setFocus("sidebar");
				return;
			}
		}
		if (this.#focus === "diff") {
			if (matchesKey(data, "shift+up")) this.#pane.moveCursor(-1, true);
			else if (matchesKey(data, "shift+down")) this.#pane.moveCursor(1, true);
			else if (matchesKey(data, "up") || data === "k") this.#pane.moveCursor(-1, false);
			else if (matchesKey(data, "down") || data === "j") this.#pane.moveCursor(1, false);
			else if (matchesKey(data, "pageUp")) this.#pane.moveCursor(-Math.max(1, this.#contentHeight - 2), false);
			else if (matchesKey(data, "pageDown") || data === " ")
				this.#pane.moveCursor(Math.max(1, this.#contentHeight - 2), false);
			else if (matchesKey(data, "left") || data === "h") this.#pane.scrollLeftBy(-8);
			else if (matchesKey(data, "right") || data === "l") this.#pane.scrollLeftBy(8);
			else if (matchesKey(data, "home") || data === "g") this.#pane.cursorToEdge("start");
			else if (matchesKey(data, "end") || data === "G") this.#pane.cursorToEdge("end");
			else if (matchesKey(data, "enter")) return this.#jumpHunkOrFile(1);
			else if (data === "s" || data === "u") {
				if (this.#pane.selection?.explicit && this.#pane.patchTarget) {
					void this.#lineAction(this.#pane.patchTarget);
					return;
				}
				const hunk = this.#pane.mode === "hunk" ? this.#pane.currentHunk : null;
				if (hunk && this.#pane.patchTarget) void this.#hunkAction(hunk, this.#pane.patchTarget);
				else this.#stageCurrentFile();
				return;
			} else if (data === "x") {
				if (this.#pane.selection?.explicit && this.#pane.patchTarget === "stage") {
					void this.#lineAction("discard");
					return;
				}
				const hunk = this.#pane.mode === "hunk" ? this.#pane.currentHunk : null;
				if (hunk && this.#pane.patchTarget === "stage") void this.#hunkAction(hunk, "discard");
				return;
			} else if (matchesKey(data, "delete")) {
				this.#discardCurrentFile();
				return;
			} else return;
			this.#notify();
			return;
		}
		this.#sidebar.handleInput(data);
	}

	#handleMouse(data: string): boolean {
		if (!data.startsWith("\x1b[<")) return false;
		return routeSgrMouseInput(data, event =>
			this.#routeMouse(event.row, event.col, event.wheel, event.leftClick, (event.button & 4) !== 0),
		);
	}

	#paneMouse(event: HostMouseEvent): void {
		if (event.action === "wheel" && event.wheel !== 0) {
			this.#pane.scrollBy(event.wheel * 3);
			event.stopPropagation();
			this.#notify();
			return;
		}
		if (event.action !== "down" || event.button !== 0) return;
		if (this.#focus !== "diff") this.#setFocus("diff");
		const click = this.#pane.clickAt(event.localCol, event.localRow, event.shiftKey);
		if (click?.type === "hunk-action") void this.#hunkAction(click.hunk, click.action);
		event.stopPropagation();
		this.#notify();
	}

	#sidebarMouse(event: HostMouseEvent): void {
		if (event.action !== "wheel" || event.wheel === 0) return;
		this.#sidebar.handleWheel(event.wheel);
		event.stopPropagation();
	}

	#routeMouse(row: number, col: number, wheel: -1 | 1 | null, leftClick: boolean, shift: boolean): boolean {
		if (wheel !== null) {
			if (row < 2 || col === this.#centerWidth) return true;
			if (col > this.#centerWidth) this.#sidebar.handleWheel(wheel);
			else {
				this.#pane.scrollBy(wheel * 3);
				this.#notify();
			}
			return true;
		}
		if (!leftClick) return true;
		if (row === 0 || row === 1) {
			const hits = row === 0 ? this.#headerHits : this.#toolbarHits;
			hits.find(hit => col >= hit.from && col < hit.to)?.action();
			return true;
		}
		if (col === this.#centerWidth) return true;
		const line = row - 2;
		if (col > this.#centerWidth) {
			if (this.#focus !== "sidebar") this.#setFocus("sidebar");
		} else {
			if (this.#focus !== "diff") this.#setFocus("diff");
			const click = this.#pane.clickAt(col, line, shift);
			if (click?.type === "hunk-action") void this.#hunkAction(click.hunk, click.action);
		}
		this.#notify();
		return true;
	}

	// ── view ───────────────────────────────────────────────────────────────

	viewNode(width: number, height = Math.max(10, this.#terminal.rows)): JSX.Element {
		const sidebarWidth = Math.max(30, Math.min(48, Math.floor(width * 0.3)));
		this.#centerWidth = Math.max(0, width - sidebarWidth - 1);
		const contentHeight = height - 2;
		this.#contentHeight = contentHeight;
		this.#pane.setHeight(contentHeight);
		this.#sidebar.setHeight(contentHeight);
		return (
			<stack>
				{this.#headerView(width)}
				{this.#toolbarView(width)}
				<split
					leftSize={{ fixed: this.#centerWidth }}
					rightMinWidth={sidebarWidth}
					height={contentHeight}
					divider="│"
					dividerStyle={theme.style(this.#focus === "sidebar" ? "accent" : "borderMuted")}
				>
					<box onMouse={event => this.#paneMouse(event)}>
						{this.#pane.viewNode(this.#centerWidth, contentHeight)}
					</box>
					<box onMouse={event => this.#sidebarMouse(event)}>{this.#sidebar.viewNode()}</box>
				</split>
			</stack>
		);
	}

	#headerView(width: number): JSX.Element {
		const glyphs = icons();
		const row = new HitRow();
		const file = this.#currentFile;
		row.add(" ");
		if (file) {
			const slash = file.path.lastIndexOf("/");
			const directory = slash >= 0 ? file.path.slice(0, slash + 1) : "";
			const basename = slash >= 0 ? file.path.slice(slash + 1) : file.path;
			row.add(directory, theme.style("dim"));
			row.add(basename, Style.NONE.plus(Attr.Bold));
			const doc = this.#pane.doc;
			if (doc) {
				row.add("  ");
				row.add(`+${doc.additions}`, theme.style("success"));
				row.add(" ");
				row.add(`−${doc.deletions}`, theme.style("error"));
			}
		} else {
			row.add("no file selected", theme.style("dim"));
		}

		const right = new HitRow();
		const asset = this.#contents?.kind === "asset" ? this.#contents : null;
		const contentKind =
			asset && (asset.old.kind === "image" || asset.new.kind === "image") ? "Media" : asset ? "Binary" : "UTF-8";
		right.add(contentKind, theme.style("dim")).add("  ");
		if (file?.area === "unstaged") {
			right.button(pill(" Stage File ", theme.getColorHex("toolDiffAdded")), () => this.#stageCurrentFile());
		} else if (file?.area === "staged") {
			right.button(pill(" Unstage File ", theme.getColorHex("warning")), () => this.#stageCurrentFile());
		}
		right.add(" ").button(softPill(` ${glyphs.close} `), () => this.#done.resolve());

		const hasStatus = this.#statusSticky || this.#now() - this.#statusAt < STATUS_TTL_MS;
		const middle = hasStatus
			? this.#status
			: this.#focus === "diff"
				? "alt+↓/↑ hunk · ]/[ file · shift+↑/↓ select · s/u stage · x/del discard · v view · c commit · q quit"
				: "↑/↓ move · ←/→ fold · space stage · del discard · enter open · alt+↓/↑ hunk · c commit · t tree · q quit";
		const middleStyle = hasStatus ? this.#statusStyle : theme.style("dim");
		const free = width - row.width - right.width - 1;
		const middleLimit = Math.max(0, free - 4);
		const middleClipped = free <= Bun.stringWidth(middle) + 4 && Bun.stringWidth(middle) > middleLimit;
		const middleText = middleClipped ? clipPlain(middle, middleLimit) : middle;
		const middleWidth = Bun.stringWidth(middleText);
		const leftPad = Math.max(1, Math.floor((free - middleWidth) / 2));
		const pad = Math.max(1, free - leftPad - middleWidth);
		this.#headerHits = [
			...row.hits,
			...right.hits.map(hit => ({
				...hit,
				from: hit.from + row.width + leftPad + middleWidth + pad,
				to: hit.to + row.width + leftPad + middleWidth + pad,
			})),
		];
		const middleRuns: StyledRun[] =
			middleClipped && middleText.endsWith("…")
				? [
						{ style: middleStyle, text: middleText.slice(0, -1) },
						{ style: Style.NONE, text: "…" },
					]
				: [{ style: middleStyle, text: middleText }];
		return (
			<ChromeRowView
				width={width}
				runs={[
					...row.runs,
					{ style: Style.NONE, text: spaces(leftPad) },
					...middleRuns,
					{ style: Style.NONE, text: spaces(pad) },
					...right.runs,
				]}
			/>
		);
	}

	#toolbarView(width: number): JSX.Element {
		const glyphs = icons();
		const file = this.#currentFile;
		const mode = this.#pane.mode;
		const row = new HitRow();
		row.add(" ");
		const scope: readonly StyledRun[] =
			file?.area === "staged"
				? tintChip(" Staged ", theme.getColorHex("success"))
				: file?.area === "unstaged"
					? tintChip(file.kind === "untracked" ? " Untracked " : " Unstaged ", theme.getColorHex("warning"))
					: file
						? tintChip(` ${this.#model.headCommit?.shortSha ?? "commit"} `, theme.getColorHex("accent"))
						: [{ style: theme.style("dim"), text: ` ${this.#model.branch ?? "detached"} ` }];
		row.addRuns(scope);

		const segments: { label: string; mode: ViewMode }[] = [
			{ label: ` ${glyphs.file} `, mode: "file" },
			{ label: ` ${glyphs.split} `, mode: "split" },
			{ label: ` ${glyphs.inline} `, mode: "inline" },
			{ label: ` ${glyphs.hunk} `, mode: "hunk" },
		];
		const navUp: readonly StyledRun[] = [{ style: theme.style("muted"), text: ` ${glyphs.up} ` }];
		const navDown: readonly StyledRun[] = [{ style: theme.style("muted"), text: ` ${glyphs.down} ` }];
		const segmentsWidth = segments.reduce((sum, segment) => sum + Bun.stringWidth(segment.label), 0);
		const groupWidth = runsWidth(navUp) + runsWidth(navDown) + 2 + segmentsWidth;
		const groupStart = Math.max(row.width + 2, Math.floor((this.#centerWidth - groupWidth) / 2));
		row.add(spaces(Math.max(0, groupStart - row.width)));
		row.button(navUp, () => this.#jumpHunkOrFile(-1));
		row.button(navDown, () => this.#jumpHunkOrFile(1));
		row.add("  ");
		for (const segment of segments) {
			row.button(softPill(segment.label, { active: mode === segment.mode }), () => this.#setMode(segment.mode));
		}

		const right = new HitRow();
		right.button(
			chip(this.#whitespace === "formatting" ? `${glyphs.ws}+` : glyphs.ws, this.#whitespace !== "off"),
			() => this.#cycleWhitespace(),
		);
		right.add(" ");
		right.button(chip(glyphs.wrap, this.#pane.wrap), () => {
			this.#pane.toggleWrap();
			this.#notify();
		});
		right.add(" ");

		const pad = Math.max(1, width - row.width - right.width);
		this.#toolbarHits = [
			...row.hits,
			...right.hits.map(hit => ({ ...hit, from: hit.from + row.width + pad, to: hit.to + row.width + pad })),
		];
		return (
			<ChromeRowView width={width} runs={[...row.runs, { style: Style.NONE, text: spaces(pad) }, ...right.runs]} />
		);
	}

	quit(): void {
		this.#done.resolve();
	}
}

/** Reactive git application for a standalone root or fullscreen overlay portal. */
export function GitTuiApp(props: { readonly host: GitTuiHost; onDone(): void }): JSX.Element {
	const tui = useTui();
	const [revision, setRevision] = createSignal(0);
	const focus = useFocus();
	const viewport = useViewport();
	const tick = useClock("second");
	const controller = new GitTuiController(
		tui.terminal,
		props.host,
		() => setRevision(value => value + 1),
		tick,
		tui.imageBudget,
	);
	let refreshTimer: NodeJS.Timeout | undefined;
	onMount(() => {
		focus.focus();
		void controller
			.run(() => {
				refreshTimer = setInterval(() => void controller.refresh(), REFRESH_MS);
			})
			.then(props.onDone);
	});
	onCleanup(() => {
		clearInterval(refreshTimer);
		controller.dispose();
	});
	return (
		<box
			tabIndex={focus.tabIndex}
			onKey={event => controller.handleKey(event)}
			onMouse={event => controller.handleMouse(event)}
			height="fill"
		>
			{() => {
				revision();
				tick();
				const dimensions = viewport();
				return controller.viewNode(dimensions.columns, Math.max(10, dimensions.rows));
			}}
		</box>
	);
}

/** Mount the git review as the historical fullscreen overlay and resolve after close. */
export async function showGitOverlay(ui: TUI, host: GitTuiHost): Promise<void> {
	const completed = Promise.withResolvers<void>();
	const overlay = mountOverlay(ui, () => (
		<Portal to="overlay" anchor="top-left" width="100%" maxHeight="100%" margin={0} fullscreen mouseTracking>
			<GitTuiApp host={host} onDone={completed.resolve} />
		</Portal>
	));
	try {
		await completed.promise;
	} finally {
		overlay.dispose();
	}
}

/** Run the fullscreen git TUI standalone (`omp git`) until the user quits. */
export async function runGitTui(host: GitTuiHost): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	ui.start();
	try {
		await showGitOverlay(ui, host);
	} finally {
		ui.stop();
	}
}
