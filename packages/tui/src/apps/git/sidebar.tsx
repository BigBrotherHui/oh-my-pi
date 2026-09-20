/**
 * Right sidebar of the git TUI.
 *
 * Dirty trees show foldable staged/unstaged file trees plus the commit form.
 * Clean trees show the selected HEAD commit and its changed-file tree. The
 * controller owns terminal input; this class retains selection, form, tree,
 * scrolling, and precise row hit testing between frames.
 */
import { BracketedPasteHandler, decodeReencodedPasteControls } from "../../bracketed-paste";
import { Editor } from "../../components/editor";
import { clampScrollOffset } from "../../components/scroll-viewport";
import { getKeybindings } from "../../keybindings";
import { extractPrintableText, matchesKey } from "../../keys";
import { type JSX } from "../../reactive";
import type { HostMouseEvent } from "../../host/input";
import { getEditorTheme } from "../../theme/tui-adapters";
import { useTheme } from "../../theme/reactive";
import { getSegmenter, moveWordLeft, moveWordRight } from "../../utils";
import { AvatarView, type AvatarSource } from "./avatar";
import { pill, Runs, softPill, tintChip } from "./colors";
import type { ImageBudget } from "../../host/elements/image";
import type { ChangedFile, GitViewState } from "./state";

/** Generated conventional commit fields shown in the commit form. */
export interface GitCommitMessage {
	readonly type: string;
	readonly scope?: string | null;
	readonly summary: string;
	readonly body: readonly string[];
}

/** Actions the sidebar raises to the root component. */
export type SidebarAction =
	| { readonly type: "stage"; readonly selection?: { readonly files: ChangedFile[]; readonly label: string } }
	| { readonly type: "unstage"; readonly selection?: { readonly files: ChangedFile[]; readonly label: string } }
	| { readonly type: "discard"; readonly selection: { readonly files: ChangedFile[]; readonly label: string } }
	| { readonly type: "generate" }
	| { readonly type: "stage-ai"; readonly prompt: string }
	| { readonly type: "commit"; readonly message: string; readonly amend: boolean; readonly stageAll: boolean };

type FileTarget =
	| { readonly kind: "file"; readonly file: ChangedFile }
	| { readonly kind: "dir"; readonly key: string };
type SectionTarget = { readonly kind: "section"; readonly area: "unstaged" | "staged" };
type Target =
	| FileTarget
	| { readonly kind: "view-style"; readonly style: "path" | "tree" }
	| SectionTarget
	| { readonly kind: "stage-all" }
	| { readonly kind: "unstage-all" }
	| { readonly kind: "stage-ai" }
	| { readonly kind: "stage-ai-input" }
	| { readonly kind: "amend" }
	| { readonly kind: "summary" }
	| { readonly kind: "description" }
	| { readonly kind: "commit-button" };

interface SidebarFileEntry {
	readonly target: FileTarget;
	readonly depth?: number;
	readonly file?: ChangedFile;
	readonly dirName?: string;
	readonly collapsed?: boolean;
}

interface Row {
	readonly node: JSX.Element;
	readonly target?: Target;
}

interface TreeDir {
	name: string;
	dirs: Map<string, TreeDir>;
	files: ChangedFile[];
}

interface TextFieldSnapshot {
	readonly value: string;
	readonly cursor: number;
}

const SEGMENTER = getSegmenter();
const SUMMARY_LIMIT = 72;

const KIND_LETTER: Record<ChangedFile["kind"], string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	untracked: "?",
	conflicted: "U",
};

const KIND_COLOR: Record<ChangedFile["kind"], "warning" | "success" | "error" | "accent" | "muted"> = {
	modified: "warning",
	added: "success",
	deleted: "error",
	renamed: "accent",
	untracked: "muted",
	conflicted: "error",
};

function targetKey(target: Target): string {
	if (target.kind === "file") return `file:${target.file.area}:${target.file.path}`;
	if (target.kind === "dir") return `dir:${target.key}`;
	if (target.kind === "section") return `section:${target.area}`;
	if (target.kind === "view-style") return `view:${target.style}`;
	return target.kind;
}

function firstGrapheme(text: string): string {
	const next = SEGMENTER.segment(text)[Symbol.iterator]().next();
	return next.done ? "" : next.value.segment;
}

function previousGraphemeStart(text: string, cursor: number): number {
	const segments = [...SEGMENTER.segment(text.slice(0, cursor))];
	return Math.max(0, cursor - (segments.at(-1)?.segment.length ?? 0));
}

/** Lightweight retained single-line editor for the summary and AI prompt. */
class SidebarTextField {
	#value = "";
	#cursor = 0;
	#lastAction: "kill" | "yank" | "type-word" | null = null;
	readonly #undo: TextFieldSnapshot[] = [];
	readonly #killRing: string[] = [];
	readonly #paste = new BracketedPasteHandler();
	focused = false;

	getValue(): string {
		return this.#value;
	}

	get cursor(): number {
		return this.#cursor;
	}

	setValue(value: string): void {
		this.#value = value;
		this.#cursor = value.length;
		this.#undo.length = 0;
		this.#lastAction = null;
	}

	handleInput(data: string): "submit" | "handled" | "unhandled" {
		const paste = this.#paste.process(data);
		if (paste.handled) {
			if (paste.pasteContent !== undefined) this.#insertPaste(paste.pasteContent);
			if (paste.remaining.length > 0) this.handleInput(paste.remaining);
			return "handled";
		}

		const keys = getKeybindings();
		if (keys.matches(data, "tui.input.submit") || data === "\n") return "submit";
		if (keys.matches(data, "tui.editor.undo")) return this.#undoLast() ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.deleteCharBackward")) return this.#deleteBackward() ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.deleteCharForward")) return this.#deleteForward() ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.deleteWordBackward"))
			return this.#deleteWordBackward() ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.deleteWordForward"))
			return this.#deleteWordForward() ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.deleteToLineStart")) return this.#deleteToStart() ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.deleteToLineEnd")) return this.#deleteToEnd() ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.yank")) return this.#yank() ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.yankPop")) return this.#yankPop() ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.cursorLeft")) return this.#moveLeft() ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.cursorRight")) return this.#moveRight() ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.cursorLineStart")) return this.#moveTo(0) ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.cursorLineEnd"))
			return this.#moveTo(this.#value.length) ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.cursorWordLeft"))
			return this.#moveTo(moveWordLeft(this.#value, this.#cursor)) ? "handled" : "unhandled";
		if (keys.matches(data, "tui.editor.cursorWordRight"))
			return this.#moveTo(moveWordRight(this.#value, this.#cursor)) ? "handled" : "unhandled";

		const text = extractPrintableText(data);
		if (!text) return "unhandled";
		this.#insert(text);
		return "handled";
	}

	#snapshot(): void {
		this.#undo.push({ value: this.#value, cursor: this.#cursor });
	}

	#insert(text: string): void {
		const word = [...SEGMENTER.segment(text)].every(part => !/\s/u.test(part.segment));
		if (!word || this.#lastAction !== "type-word") this.#snapshot();
		this.#lastAction = "type-word";
		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#cursor += text.length;
	}

	#insertPaste(text: string): void {
		const clean = decodeReencodedPasteControls(text)
			.replace(/\r\n/g, "")
			.replace(/\r/g, "")
			.replace(/\n/g, "")
			.replaceAll("\t", "    ")
			.normalize("NFC")
			.replace(/[\x00-\x1f\x7f]/g, "");
		if (!clean) return;
		this.#snapshot();
		this.#lastAction = null;
		this.#value = this.#value.slice(0, this.#cursor) + clean + this.#value.slice(this.#cursor);
		this.#cursor += clean.length;
	}

	#deleteBackward(): boolean {
		if (this.#cursor <= 0) return false;
		this.#snapshot();
		const from = previousGraphemeStart(this.#value, this.#cursor);
		this.#value = this.#value.slice(0, from) + this.#value.slice(this.#cursor);
		this.#cursor = from;
		this.#lastAction = null;
		return true;
	}

	#deleteForward(): boolean {
		if (this.#cursor >= this.#value.length) return false;
		this.#snapshot();
		const length = firstGrapheme(this.#value.slice(this.#cursor)).length || 1;
		this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(this.#cursor + length);
		this.#lastAction = null;
		return true;
	}

	#pushKill(text: string, prepend: boolean): void {
		if (!text) return;
		if (this.#lastAction === "kill" && this.#killRing.length > 0) {
			const current = this.#killRing[0] ?? "";
			this.#killRing[0] = prepend ? text + current : current + text;
		} else {
			this.#killRing.unshift(text);
			if (this.#killRing.length > 100) this.#killRing.pop();
		}
		this.#lastAction = "kill";
	}

	#deleteWordBackward(): boolean {
		if (this.#cursor <= 0) return false;
		this.#snapshot();
		const from = moveWordLeft(this.#value, this.#cursor);
		this.#pushKill(this.#value.slice(from, this.#cursor), true);
		this.#value = this.#value.slice(0, from) + this.#value.slice(this.#cursor);
		this.#cursor = from;
		return true;
	}

	#deleteWordForward(): boolean {
		if (this.#cursor >= this.#value.length) return false;
		this.#snapshot();
		const to = moveWordRight(this.#value, this.#cursor);
		this.#pushKill(this.#value.slice(this.#cursor, to), false);
		this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(to);
		return true;
	}

	#deleteToStart(): boolean {
		if (this.#cursor <= 0) return false;
		this.#snapshot();
		this.#pushKill(this.#value.slice(0, this.#cursor), true);
		this.#value = this.#value.slice(this.#cursor);
		this.#cursor = 0;
		return true;
	}

	#deleteToEnd(): boolean {
		if (this.#cursor >= this.#value.length) return false;
		this.#snapshot();
		this.#pushKill(this.#value.slice(this.#cursor), false);
		this.#value = this.#value.slice(0, this.#cursor);
		return true;
	}

	#undoLast(): boolean {
		const snapshot = this.#undo.pop();
		if (!snapshot) return false;
		this.#value = snapshot.value;
		this.#cursor = snapshot.cursor;
		this.#lastAction = null;
		return true;
	}

	#yank(): boolean {
		const text = this.#killRing[0];
		if (!text) return false;
		this.#snapshot();
		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#cursor += text.length;
		this.#lastAction = "yank";
		return true;
	}

	#yankPop(): boolean {
		if (this.#lastAction !== "yank" || this.#killRing.length < 2) return false;
		const previous = this.#killRing.shift();
		if (!previous) return false;
		this.#killRing.push(previous);
		const next = this.#killRing[0] ?? "";
		this.#snapshot();
		this.#value = this.#value.slice(0, this.#cursor - previous.length) + next + this.#value.slice(this.#cursor);
		this.#cursor += next.length - previous.length;
		return true;
	}

	#moveLeft(): boolean {
		return this.#moveTo(previousGraphemeStart(this.#value, this.#cursor));
	}

	#moveRight(): boolean {
		return this.#moveTo(this.#cursor + firstGrapheme(this.#value.slice(this.#cursor)).length);
	}

	#moveTo(cursor: number): boolean {
		const next = Math.max(0, Math.min(this.#value.length, cursor));
		if (next === this.#cursor) return false;
		this.#cursor = next;
		this.#lastAction = null;
		return true;
	}
}

function buildTreeEntries(
	files: readonly ChangedFile[],
	section: string,
	collapsed: ReadonlySet<string>,
): SidebarFileEntry[] {
	const root: TreeDir = { name: "", dirs: new Map(), files: [] };
	for (const file of files) {
		const parts = file.path.split("/");
		let node = root;
		for (const part of parts.slice(0, -1)) {
			let next = node.dirs.get(part);
			if (!next) {
				next = { name: part, dirs: new Map(), files: [] };
				node.dirs.set(part, next);
			}
			node = next;
		}
		node.files.push(file);
	}

	const compress = (node: TreeDir): void => {
		for (const [key, child] of [...node.dirs]) {
			let merged = child;
			while (merged.files.length === 0 && merged.dirs.size === 1) {
				const only = merged.dirs.values().next().value;
				if (!only) break;
				merged = { name: `${merged.name}/${only.name}`, dirs: only.dirs, files: only.files };
			}
			if (merged !== child) {
				node.dirs.delete(key);
				node.dirs.set(key, merged);
			}
			compress(merged);
		}
	};
	compress(root);

	const entries: SidebarFileEntry[] = [];
	const visit = (node: TreeDir, prefix: string, depth: number): void => {
		for (const dir of [...node.dirs.values()].sort((left, right) => left.name.localeCompare(right.name))) {
			const path = `${prefix}${dir.name}`;
			const key = `${section}:${path}`;
			entries.push({ target: { kind: "dir", key }, depth, dirName: dir.name, collapsed: collapsed.has(key) });
			if (!collapsed.has(key)) visit(dir, `${path}/`, depth + 1);
		}
		for (const file of node.files) entries.push({ target: { kind: "file", file }, depth, file });
	};
	visit(root, "", 0);
	return entries;
}

function filePathView(file: ChangedFile, depth: number | undefined): JSX.Element {
	const slash = file.path.lastIndexOf("/");
	const value = depth === undefined ? file.path : slash >= 0 ? file.path.slice(slash + 1) : file.path;
	return <path value={value} overflow="middle" strike={file.kind === "deleted"} />;
}

function singleLineField(
	field: SidebarTextField,
	placeholder: string,
	selected: boolean,
	focused: boolean,
): JSX.Element {
	const bar = selected ? "▎" : "▏";
	const barColor = selected ? "accent" : "borderMuted";
	const value = field.getValue();
	const cursor = field.cursor;
	const current = value.slice(cursor, cursor + firstGrapheme(value.slice(cursor)).length) || " ";
	return (
		<row>
			<text width={2} shrink={0}>
				{" "}
				<span color={barColor}>{bar}</span>
			</text>
			<text grow={1} wrap="clip" overflow="ellipsis">
				{value ? (
					<>
						{value.slice(0, cursor)}
						{focused ? <span inverse>{current}</span> : current}
						{value.slice(cursor + (value ? current.length : 0))}
					</>
				) : (
					<>
						{focused ? <span inverse> </span> : null}
						<span color="dim">{placeholder}</span>
					</>
				)}
			</text>
		</row>
	);
}

/** Sidebar state machine and retained reactive renderer. */
export class Sidebar {
	readonly #model: GitViewState;
	readonly #avatars: AvatarSource;
	readonly #imageBudget: ImageBudget | undefined;
	readonly #onSelectFile: (file: ChangedFile | null) => void;
	readonly #onAction: (action: SidebarAction) => void;
	readonly #onFocusDiff: () => void;
	readonly #requestRender: () => void;
	readonly summary = new SidebarTextField();
	readonly description = new Editor(getEditorTheme());
	readonly aiInput = new SidebarTextField();
	#targets: readonly Target[] = [];
	#index = 0;
	focused = false;
	#height = 24;
	amend = false;
	generating = false;
	#aiPromptOpen = false;
	viewStyle: "path" | "tree" = "tree";
	readonly #collapsed = new Set<string>();
	readonly #collapsedSections = new Set<SectionTarget["area"]>();
	#treeVersion = 0;
	readonly #targetByKey = new Map<string, Target>();
	readonly #entryDepth = new Map<string, number>();
	readonly #fileEntryCache = new Map<
		string,
		{
			readonly files: readonly ChangedFile[];
			readonly style: "path" | "tree";
			readonly treeVersion: number;
			readonly entries: readonly SidebarFileEntry[];
		}
	>();
	#snapshot:
		| {
				readonly clean: boolean;
				readonly unstaged: readonly ChangedFile[];
				readonly staged: readonly ChangedFile[];
				readonly headFiles: readonly ChangedFile[] | undefined;
				readonly style: "path" | "tree";
				readonly treeVersion: number;
		  }
		| undefined;
	#scrollOffset = 0;
	#followSelection = false;

	constructor(options: {
		readonly model: GitViewState;
		readonly avatars: AvatarSource;
		readonly imageBudget?: ImageBudget;
		readonly onSelectFile: (file: ChangedFile | null) => void;
		readonly onAction: (action: SidebarAction) => void;
		readonly onFocusDiff: () => void;
		readonly requestRender: () => void;
	}) {
		this.#model = options.model;
		this.#avatars = options.avatars;
		this.#imageBudget = options.imageBudget;
		this.#onSelectFile = options.onSelectFile;
		this.#onAction = options.onAction;
		this.#onFocusDiff = options.onFocusDiff;
		this.#requestRender = options.requestRender;
		this.description.setBorderVisible(false);
		this.description.setMaxHeight(5);
		this.description.onChange = () => this.#requestRender();
	}

	get selected(): Target | undefined {
		return this.#targets[this.#index] ?? this.#targets[0];
	}

	get selectedFile(): ChangedFile | null {
		const target = this.selected;
		return target?.kind === "file" ? target.file : null;
	}

	get editing(): boolean {
		const target = this.selected;
		return (
			this.focused &&
			(target?.kind === "summary" || target?.kind === "description" || target?.kind === "stage-ai-input")
		);
	}

	reconcile(): ChangedFile | null {
		const prior = this.selected;
		const previous = this.#targets;
		this.#rebuildTargets();
		if (prior && !this.#targetByKey.has(targetKey(prior))) {
			const survivor = this.#nearestSurvivor(previous, targetKey(prior));
			if (survivor) this.#select(survivor);
		}
		const target = this.selected;
		if (target?.kind === "file") return target.file;
		const firstFile = this.#targets.find(candidate => candidate.kind === "file");
		return firstFile?.kind === "file" ? firstFile.file : null;
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.#syncFieldFocus();
	}

	setHeight(height: number): void {
		this.#height = Math.max(1, Math.trunc(height));
	}

	selectAdjacentFile(direction: 1 | -1, from?: ChangedFile | null): boolean {
		this.#rebuildTargets();
		const start = from
			? this.#targets.findIndex(
					target => target.kind === "file" && target.file.path === from.path && target.file.area === from.area,
				)
			: this.#index;
		for (let index = start + direction; index >= 0 && index < this.#targets.length; index += direction) {
			const target = this.#targets[index];
			if (target?.kind === "file") {
				this.#select(target);
				return true;
			}
		}
		return false;
	}

	focusCommitForm(): boolean {
		this.#rebuildTargets();
		const target = this.#targets.find(candidate => candidate.kind === "summary");
		if (!target) return false;
		this.#select(target);
		return true;
	}

	handleEscape(): boolean {
		const target = this.selected;
		if (target?.kind === "stage-ai-input") {
			this.#closeAiPrompt();
			this.#select({ kind: "section", area: "unstaged" });
			return true;
		}
		if (target?.kind === "summary" || target?.kind === "description") {
			this.#select({ kind: "commit-button" });
			return true;
		}
		return false;
	}

	clearForm(): void {
		this.summary.setValue("");
		this.description.setText("");
		this.amend = false;
		this.#requestRender();
	}

	setGeneratedCommit(commit: GitCommitMessage): void {
		this.summary.setValue(`${commit.type}${commit.scope ? `(${commit.scope})` : ""}: ${commit.summary}`);
		this.description.setText(commit.body.map(detail => `- ${detail}`).join("\n"));
		this.#requestRender();
	}

	setGenerating(generating: boolean): void {
		this.generating = generating;
		this.#requestRender();
	}

	handleInput(data: string): void {
		this.#rebuildTargets();
		const target = this.selected;
		if (target?.kind === "stage-ai-input" && this.focused) {
			if (matchesKey(data, "up")) return this.#moveSelection(-1);
			if (matchesKey(data, "down")) return this.#moveSelection(1);
			if (!matchesKey(data, "pageUp") && !matchesKey(data, "pageDown")) {
				if (this.aiInput.handleInput(data) === "submit") this.#submitAiPrompt();
				else this.#requestRender();
				return;
			}
		}
		if (target?.kind === "summary" && this.focused) {
			if (matchesKey(data, "up")) return this.#moveSelection(-1);
			if (matchesKey(data, "down")) return this.#moveSelection(1);
			if (!matchesKey(data, "pageUp") && !matchesKey(data, "pageDown")) {
				if (this.summary.handleInput(data) === "submit") this.#moveSelection(1);
				else this.#requestRender();
				return;
			}
		}
		if (target?.kind === "description" && this.focused) {
			const cursor = this.description.getCursor();
			const lines = this.description.getLines();
			if (matchesKey(data, "up") && cursor.line === 0) return this.#moveSelection(-1);
			if (matchesKey(data, "down") && cursor.line >= lines.length - 1) return this.#moveSelection(1);
			if (!matchesKey(data, "pageUp") && !matchesKey(data, "pageDown")) {
				this.description.handleInput(data);
				this.#requestRender();
				return;
			}
		}

		if (matchesKey(data, "up") || data === "k") this.#moveSelection(-1);
		else if (matchesKey(data, "down") || data === "j") this.#moveSelection(1);
		else if (matchesKey(data, "left") || data === "h") this.#collapseOrParent();
		else if (matchesKey(data, "right") || data === "l") this.#expandOrOpen();
		else if (matchesKey(data, "home") || data === "g") this.#moveSelection(-this.#targets.length);
		else if (matchesKey(data, "end") || data === "G") this.#moveSelection(this.#targets.length);
		else if (matchesKey(data, "pageUp")) this.#moveSelection(-Math.max(1, this.#height - 4));
		else if (matchesKey(data, "pageDown")) this.#moveSelection(Math.max(1, this.#height - 4));
		else if ((matchesKey(data, "enter") || matchesKey(data, "return")) && target) {
			if (target.kind === "file") this.#onFocusDiff();
			else this.#activate(target);
		} else if (data === " " && (target?.kind === "file" || target?.kind === "dir" || target?.kind === "section")) {
			const action = this.#stageActionFor(target);
			if (action) this.#onAction(action);
		} else if (
			(data === "s" || data === "u") &&
			(target?.kind === "file" || target?.kind === "dir" || target?.kind === "section")
		) {
			const action = this.#stageActionFor(target);
			if (action?.type === (data === "s" ? "stage" : "unstage")) this.#onAction(action);
		} else if (matchesKey(data, "delete") && (target?.kind === "file" || target?.kind === "dir")) {
			const action = this.#discardActionFor(target);
			if (action) this.#onAction(action);
		} else if (data === "t") {
			this.viewStyle = this.viewStyle === "path" ? "tree" : "path";
			this.#treeVersion++;
			this.#requestRender();
		}
	}

	handleWheel(delta: number): void {
		this.#scrollOffset = Math.max(0, this.#scrollOffset + Math.trunc(delta) * 3);
		this.#requestRender();
	}

	viewNode(): JSX.Element {
		this.#rebuildTargets();
		this.#syncFieldFocus();
		const selected = this.selected;
		const selectedKey = selected ? targetKey(selected) : undefined;
		const isSelected = (target: Target): boolean => targetKey(target) === selectedKey;
		const rows = this.#model.clean ? this.#commitRows(isSelected) : this.#dirtyRows(isSelected);
		const pinned = this.#model.clean ? [] : this.#commitFormRows(isSelected);
		if (this.#followSelection) {
			this.#followSelection = false;
			this.#scrollOffset = Math.max(0, this.#index - 1);
		}
		return (
			<stack height="fill">
				<scroll
					grow={1}
					offset={this.#scrollOffset}
					scrollbar="never"
					followTail={false}
					onViewport={viewport => {
						this.#height = Math.max(1, viewport.height);
						this.#scrollOffset = clampScrollOffset(this.#scrollOffset, viewport.totalRows, viewport.height);
					}}
				>
					<stack>{rows.map(row => row.node)}</stack>
				</scroll>
				{pinned.map(row => row.node)}
			</stack>
		);
	}

	dispose(): void {
		this.description.dispose();
		this.#fileEntryCache.clear();
	}

	#rebuildTargets(): void {
		const headFiles = this.#model.headCommit?.files;
		const snapshot = this.#snapshot;
		if (
			snapshot?.clean === this.#model.clean &&
			snapshot.unstaged === this.#model.unstaged &&
			snapshot.staged === this.#model.staged &&
			snapshot.headFiles === headFiles &&
			snapshot.style === this.viewStyle &&
			snapshot.treeVersion === this.#treeVersion
		)
			return;
		const currentKey = this.selected ? targetKey(this.selected) : undefined;
		const targets: Target[] = [];
		this.#targetByKey.clear();
		this.#entryDepth.clear();
		const push = (target: Target, depth?: number): void => {
			targets.push(target);
			this.#targetByKey.set(targetKey(target), target);
			if (depth !== undefined) this.#entryDepth.set(targetKey(target), depth);
		};
		const pushFiles = (files: readonly ChangedFile[], section: string): void => {
			for (const entry of this.#fileEntries(files, section)) push(entry.target, entry.depth ?? 0);
		};
		if (this.#model.clean) {
			pushFiles(headFiles ?? [], "commit");
		} else {
			push({ kind: "section", area: "unstaged" });
			if (this.#aiPromptOpen) push({ kind: "stage-ai-input" });
			if (!this.#collapsedSections.has("unstaged")) pushFiles(this.#model.unstaged, "unstaged");
			push({ kind: "section", area: "staged" });
			if (!this.#collapsedSections.has("staged")) pushFiles(this.#model.staged, "staged");
			push({ kind: "amend" });
			push({ kind: "summary" });
			push({ kind: "description" });
			push({ kind: "commit-button" });
		}
		this.#targets = targets;
		const currentIndex =
			currentKey === undefined ? -1 : targets.findIndex(target => targetKey(target) === currentKey);
		this.#index = currentIndex >= 0 ? currentIndex : Math.min(this.#index, Math.max(0, targets.length - 1));
		this.#snapshot = {
			clean: this.#model.clean,
			unstaged: this.#model.unstaged,
			staged: this.#model.staged,
			headFiles,
			style: this.viewStyle,
			treeVersion: this.#treeVersion,
		};
		this.#syncFieldFocus();
	}

	#fileEntries(files: readonly ChangedFile[], section: string): readonly SidebarFileEntry[] {
		const cached = this.#fileEntryCache.get(section);
		if (cached?.files === files && cached.style === this.viewStyle && cached.treeVersion === this.#treeVersion)
			return cached.entries;
		const entries: readonly SidebarFileEntry[] =
			this.viewStyle === "path"
				? files.map<SidebarFileEntry>(file => ({ target: { kind: "file", file }, file }))
				: buildTreeEntries(files, section, this.#collapsed);
		this.#fileEntryCache.set(section, { files, style: this.viewStyle, treeVersion: this.#treeVersion, entries });
		return entries;
	}

	#nearestSurvivor(previous: readonly Target[], key: string): Target | undefined {
		const index = previous.findIndex(target => targetKey(target) === key);
		if (index < 0) return undefined;
		const survivorAt = (candidate: Target | undefined): Target | undefined => {
			if (!candidate || (candidate.kind !== "file" && candidate.kind !== "dir")) return undefined;
			return this.#targetByKey.get(targetKey(candidate));
		};
		for (let cursor = index + 1; cursor < previous.length; cursor++) {
			const survivor = survivorAt(previous[cursor]);
			if (survivor) return survivor;
		}
		for (let cursor = index - 1; cursor >= 0; cursor--) {
			const survivor = survivorAt(previous[cursor]);
			if (survivor) return survivor;
		}
		return undefined;
	}

	#select(target: Target): void {
		const index = this.#targets.findIndex(candidate => targetKey(candidate) === targetKey(target));
		this.#index = index >= 0 ? index : 0;
		this.#followSelection = true;
		this.#syncFieldFocus();
		if (target.kind === "file") this.#onSelectFile(target.file);
		this.#requestRender();
	}

	#syncFieldFocus(): void {
		const target = this.selected;
		this.summary.focused = this.focused && target?.kind === "summary";
		this.aiInput.focused = this.focused && target?.kind === "stage-ai-input";
		this.description.focused = this.focused && target?.kind === "description";
	}

	#moveSelection(delta: number): void {
		if (this.#targets.length === 0 || delta === 0) return;
		const next = Math.max(0, Math.min(this.#targets.length - 1, this.#index + delta));
		if (next === this.#index) return;
		const target = this.#targets[next];
		if (target) this.#select(target);
	}

	#activate(target: Target): void {
		switch (target.kind) {
			case "file": {
				const action = this.#stageActionFor(target);
				if (action) this.#onAction(action);
				break;
			}
			case "dir":
				if (this.#collapsed.has(target.key)) this.#collapsed.delete(target.key);
				else this.#collapsed.add(target.key);
				this.#treeVersion++;
				this.#requestRender();
				break;
			case "view-style":
				this.viewStyle = target.style;
				this.#treeVersion++;
				this.#requestRender();
				break;
			case "section":
				this.#toggleSection(target.area);
				break;
			case "stage-all":
				this.#onAction({ type: "stage" });
				break;
			case "unstage-all":
				this.#onAction({ type: "unstage" });
				break;
			case "stage-ai":
				this.#openAiPrompt();
				break;
			case "amend":
				this.#toggleAmend();
				break;
			case "commit-button":
				this.#submitCommit();
				break;
		}
	}

	#stageActionFor(target: FileTarget | SectionTarget): SidebarAction | null {
		if (target.kind === "section") return target.area === "unstaged" ? { type: "stage" } : { type: "unstage" };
		const selected = this.#selectionFor(target);
		if (!selected) return null;
		const { area, files, label } = selected;
		return area === "unstaged"
			? { type: "stage", selection: { files, label } }
			: { type: "unstage", selection: { files, label } };
	}

	#discardActionFor(target: FileTarget): SidebarAction | null {
		const selected = this.#selectionFor(target);
		if (!selected) return null;
		return { type: "discard", selection: { files: selected.files, label: selected.label } };
	}

	#selectionFor(
		target: FileTarget,
	): { readonly files: ChangedFile[]; readonly label: string; readonly area: "unstaged" | "staged" } | null {
		if (target.kind === "file") {
			if (target.file.area !== "unstaged" && target.file.area !== "staged") return null;
			return { files: [target.file], label: target.file.path, area: target.file.area };
		}
		const separator = target.key.indexOf(":");
		const area = target.key.slice(0, separator);
		if (area !== "unstaged" && area !== "staged") return null;
		const path = target.key.slice(separator + 1);
		const files = (area === "unstaged" ? this.#model.unstaged : this.#model.staged).filter(file =>
			file.path.startsWith(`${path}/`),
		);
		return files.length > 0 ? { files, label: `${path}/`, area } : null;
	}

	#openAiPrompt(): void {
		this.#aiPromptOpen = true;
		this.#treeVersion++;
		this.#rebuildTargets();
		this.#select({ kind: "stage-ai-input" });
	}

	#closeAiPrompt(): void {
		this.#aiPromptOpen = false;
		this.aiInput.setValue("");
		this.#treeVersion++;
		this.#requestRender();
	}

	#submitAiPrompt(): void {
		const prompt = this.aiInput.getValue().trim();
		if (!prompt) return;
		this.#closeAiPrompt();
		this.#rebuildTargets();
		this.#select({ kind: "section", area: "unstaged" });
		this.#onAction({ type: "stage-ai", prompt });
	}

	#toggleAmend(): void {
		this.amend = !this.amend;
		const head = this.#model.headCommit;
		if (this.amend && head && this.summary.getValue().length === 0 && this.description.getText().length === 0) {
			this.summary.setValue(head.subject);
			this.description.setText(head.body);
		}
		this.#requestRender();
	}

	#submitCommit(): void {
		const summary = this.summary.getValue().trim();
		const body = this.description.getText().trim();
		const stageAll = this.#model.staged.length === 0;
		if (stageAll && this.#model.unstaged.length === 0 && !this.amend) return;
		if (!summary) {
			if (!body) this.#onAction({ type: "generate" });
			return;
		}
		this.#onAction({
			type: "commit",
			message: body ? `${summary}\n\n${body}` : summary,
			amend: this.amend,
			stageAll,
		});
	}

	#collapseOrParent(): void {
		const target = this.selected;
		if (target?.kind === "section" && !this.#collapsedSections.has(target.area)) {
			this.#toggleSection(target.area);
			return;
		}
		if (!target || (target.kind !== "file" && target.kind !== "dir")) return;
		if (target.kind === "dir" && !this.#collapsed.has(target.key)) {
			this.#collapsed.add(target.key);
			this.#treeVersion++;
			this.#requestRender();
			return;
		}
		const depth = this.#entryDepth.get(targetKey(target)) ?? 0;
		for (let index = this.#index - 1; index >= 0; index--) {
			const candidate = this.#targets[index];
			if (!candidate || (candidate.kind !== "file" && candidate.kind !== "dir")) return;
			if (candidate.kind === "dir" && (this.#entryDepth.get(targetKey(candidate)) ?? 0) < depth) {
				this.#select(candidate);
				return;
			}
		}
	}

	#expandOrOpen(): void {
		const target = this.selected;
		if (target?.kind === "section") {
			if (this.#collapsedSections.has(target.area)) this.#toggleSection(target.area);
			else this.#moveSelection(1);
			return;
		}
		if (target?.kind === "dir") {
			if (this.#collapsed.has(target.key)) {
				this.#collapsed.delete(target.key);
				this.#treeVersion++;
				this.#requestRender();
			} else this.#moveSelection(1);
			return;
		}
		if (target?.kind === "file") this.#onFocusDiff();
	}

	#toggleSection(area: SectionTarget["area"]): void {
		if (!this.#collapsedSections.delete(area)) this.#collapsedSections.add(area);
		this.#treeVersion++;
		this.#requestRender();
	}

	#click(target: Target, event: HostMouseEvent): void {
		if (event.action !== "down" || event.button !== 0) return;
		event.stopPropagation();
		const wasSelected = this.selected !== undefined && targetKey(this.selected) === targetKey(target);
		this.#select(target);
		if (target.kind !== "file" && target.kind !== "summary" && target.kind !== "description") this.#activate(target);
		else if (target.kind === "file" && wasSelected) this.#activate(target);
	}

	#fileRows(files: readonly ChangedFile[], section: string, isSelected: (target: Target) => boolean): Row[] {
		return this.#fileEntries(files, section).map(entry => {
			const selected = isSelected(entry.target);
			const active = selected && this.focused;
			if (entry.target.kind === "dir") {
				return {
					target: entry.target,
					node: (
						<row
							background={active ? "selectedBg" : undefined}
							onMouse={event => this.#click(entry.target, event)}
						>
							<text width={2} shrink={0} color={selected ? "accent" : undefined}>
								{selected ? "▎" : " "}
							</text>
							<text width={(entry.depth ?? 0) * 2} shrink={0}>
								{" ".repeat((entry.depth ?? 0) * 2)}
							</text>
							<text width={1} shrink={0} color="muted">
								{entry.collapsed ? "▸" : "▾"}
							</text>
							<text grow={1} wrap="clip" color="dim">{`${entry.dirName}/`}</text>
						</row>
					),
				};
			}
			const file = entry.target.file;
			return {
				target: entry.target,
				node: (
					<row background={active ? "selectedBg" : undefined} onMouse={event => this.#click(entry.target, event)}>
						<text width={2} shrink={0} color={selected ? "accent" : undefined}>
							{selected ? "▎" : " "}
						</text>
						<text width={(entry.depth ?? 0) * 2} shrink={0}>
							{" ".repeat((entry.depth ?? 0) * 2)}
						</text>
						<text width={2} shrink={0} color={KIND_COLOR[file.kind]}>{`${KIND_LETTER[file.kind]} `}</text>
						<box grow={1} minWidth={1}>
							{filePathView(file, entry.depth)}
						</box>
						{file.additions ? <text shrink={0} color="success">{` +${file.additions}`}</text> : null}
						{file.deletions ? <text shrink={0} color="error">{` −${file.deletions}`}</text> : null}
					</row>
				),
			};
		});
	}

	#viewToggleRow(): Row {
		const theme = useTheme().theme();
		const nerd = theme.getSymbolPreset() === "nerd";
		const path = softPill(` ${nerd ? "" : "☰"} Path `, { active: this.viewStyle === "path" });
		const tree = softPill(` ${nerd ? "" : "└"} Tree `, { active: this.viewStyle === "tree" });
		return {
			node: (
				<row align="center">
					<text onMouse={event => this.#click({ kind: "view-style", style: "path" }, event)}>
						<Runs runs={path} />
					</text>
					<text width={1}> </text>
					<text onMouse={event => this.#click({ kind: "view-style", style: "tree" }, event)}>
						<Runs runs={tree} />
					</text>
				</row>
			),
		};
	}

	#sectionHeader(
		label: string,
		pills: readonly { readonly action: string; readonly target: Target }[],
		target: SectionTarget,
		selected: boolean,
	): Row {
		return {
			target,
			node: (
				<row
					background={selected && this.focused ? "selectedBg" : undefined}
					onMouse={event => this.#click(target, event)}
				>
					<text grow={1} wrap="clip" bold>
						{label}
					</text>
					{pills.map(item => (
						<text shrink={0} onMouse={event => this.#click(item.target, event)}>
							<Runs runs={softPill(` ${item.action} `, { active: true })} />
						</text>
					))}
				</row>
			),
		};
	}

	#dirtyRows(isSelected: (target: Target) => boolean): Row[] {
		const theme = useTheme().theme();
		const total = this.#model.unstaged.length + this.#model.staged.length;
		const branch = this.#model.branch ? tintChip(` ${this.#model.branch} `, theme.getColorHex("accent")) : [];
		const rows: Row[] = [
			{
				node: (
					<text wrap="clip">
						{" "}
						<span bold>{`${total} file change${total === 1 ? "" : "s"} on `}</span>
						<Runs runs={branch} />
					</text>
				),
			},
			this.#viewToggleRow(),
			{ node: <hr variant="frame" /> },
		];
		const unstaged: SectionTarget = { kind: "section", area: "unstaged" };
		const unstagedFolded = this.#collapsedSections.has("unstaged");
		const wand = theme.getSymbolPreset() === "nerd" ? "" : "✦";
		rows.push(
			this.#sectionHeader(
				`${unstagedFolded ? "▸" : "▾"} Unstaged Files (${this.#model.unstaged.length})`,
				[
					{ action: "Stage All", target: { kind: "stage-all" } },
					{ action: wand, target: { kind: "stage-ai" } },
				],
				unstaged,
				isSelected(unstaged),
			),
		);
		if (this.#aiPromptOpen) {
			const target: Target = { kind: "stage-ai-input" };
			rows.push({
				target,
				node: (
					<box onMouse={event => this.#click(target, event)}>
						{singleLineField(this.aiInput, "What should we stage?", isSelected(target), this.aiInput.focused)}
					</box>
				),
			});
		}
		if (!unstagedFolded) {
			rows.push(...this.#fileRows(this.#model.unstaged, "unstaged", isSelected));
			if (this.#model.unstaged.length === 0)
				rows.push({
					node: (
						<text color="dim" wrap="clip">
							{" "}
							no unstaged files
						</text>
					),
				});
		}
		rows.push({ node: <text>{""}</text> });
		const staged: SectionTarget = { kind: "section", area: "staged" };
		const stagedFolded = this.#collapsedSections.has("staged");
		rows.push(
			this.#sectionHeader(
				`${stagedFolded ? "▸" : "▾"} Staged Files (${this.#model.staged.length})`,
				[{ action: "Unstage All", target: { kind: "unstage-all" } }],
				staged,
				isSelected(staged),
			),
		);
		if (!stagedFolded) {
			rows.push(...this.#fileRows(this.#model.staged, "staged", isSelected));
			if (this.#model.staged.length === 0)
				rows.push({
					node: (
						<text color="dim" wrap="clip">
							{" "}
							no staged files
						</text>
					),
				});
		}
		return rows;
	}

	#descriptionRows(isSelected: (target: Target) => boolean): Row[] {
		const target: Target = { kind: "description" };
		const selected = isSelected(target);
		if (!this.description.getText() && !this.description.focused) {
			return [
				{
					target,
					node: (
						<text wrap="clip" onMouse={event => this.#click(target, event)}>
							{" "}
							<span color={selected ? "accent" : "borderMuted"}>{selected ? "▎" : "▏"}</span>
							<span color="dim">Description</span>
						</text>
					),
				},
			];
		}
		return [
			{
				target,
				node: (
					<row align="start" onMouse={event => this.#click(target, event)}>
						<text width={2} shrink={0}>
							{" "}
							<span color={selected ? "accent" : "borderMuted"}>{selected ? "▎" : "▏"}</span>
						</text>
						<box grow={1}>
							<editor editor={this.description} />
						</box>
					</row>
				),
			},
		];
	}

	#commitFormRows(isSelected: (target: Target) => boolean): Row[] {
		const palette = useTheme();
		const rows: Row[] = [{ node: <hr variant="frame" /> }];
		const amend: Target = { kind: "amend" };
		rows.push({
			target: amend,
			node: (
				<text
					wrap="clip"
					background={isSelected(amend) && this.focused ? "selectedBg" : undefined}
					onMouse={event => this.#click(amend, event)}
				>
					{" "}
					<span color={this.amend ? "accent" : "muted"}>{this.amend ? "▣" : "☐"}</span> Amend previous commit
				</text>
			),
		});
		const summary: Target = { kind: "summary" };
		const remaining = String(SUMMARY_LIMIT - this.summary.getValue().length);
		rows.push({
			node: (
				<row>
					<text grow={1} color="muted" wrap="clip">
						{" "}
						Commit summary
					</text>
					<text shrink={0} color={this.summary.getValue().length > SUMMARY_LIMIT ? "warning" : "dim"}>
						{remaining}
					</text>
				</row>
			),
		});
		rows.push({
			target: summary,
			node: (
				<box onMouse={event => this.#click(summary, event)}>
					{singleLineField(this.summary, "", isSelected(summary), this.summary.focused)}
				</box>
			),
		});
		rows.push(...this.#descriptionRows(isSelected));
		rows.push({ node: <text>{""}</text> });
		const commit: Target = { kind: "commit-button" };
		const hasChanges = this.#model.staged.length > 0 || this.#model.unstaged.length > 0 || this.amend;
		const canActivate =
			hasChanges &&
			!this.generating &&
			(this.summary.getValue().trim().length > 0 || this.description.getText().trim().length === 0);
		const label = this.generating
			? "-○- Generating commit message"
			: this.#model.staged.length > 0
				? "-○- Commit staged changes"
				: "-○- Stage all & commit";
		rows.push({
			target: commit,
			node: (
				<row align="center">
					<text onMouse={event => this.#click(commit, event)}>
						<Runs
							runs={pill(` ${label} `, palette.theme().getColorHex("accent"), {
								dim: !canActivate,
								selected: canActivate && isSelected(commit) && this.focused,
							})}
						/>
					</text>
				</row>
			),
		});
		return rows;
	}

	#commitRows(isSelected: (target: Target) => boolean): Row[] {
		const head = this.#model.headCommit;
		if (!head) return [{ node: <text>{""}</text> }, { node: <text color="dim"> No commits yet</text> }];
		const rows: Row[] = [
			{
				node: (
					<text bold wrap="word">
						{" "}
						{head.subject}
					</text>
				),
			},
		];
		if (head.body)
			rows.push({
				node: (
					<text color="muted" wrap="word">
						{" "}
						{head.body}
					</text>
				),
			});
		rows.push({ node: <text>{""}</text> });
		rows.push({
			node: (
				<AvatarView
					source={this.#avatars}
					email={head.authorEmail}
					cwd={this.#model.cwd}
					imageBudget={this.#imageBudget}
				/>
			),
		});
		rows.push({
			node: (
				<text wrap="clip">
					{" "}
					<span bold>{head.authorName}</span> <span color="dim">{`<${head.authorEmail}>`}</span>
				</text>
			),
		});
		const date = new Date(head.authorDate);
		if (!Number.isNaN(date.getTime()))
			rows.push({
				node: (
					<text color="dim" wrap="clip">
						{" "}
						{`authored ${date.toLocaleString()}`}
					</text>
				),
			});
		if (head.parents.length > 0)
			rows.push({
				node: (
					<text wrap="clip">
						{" "}
						<span color="dim">parent:</span>{" "}
						<span color="accent">{head.parents.map(parent => parent.slice(0, 8)).join(" ")}</span>
					</text>
				),
			});
		rows.push({ node: <hr variant="frame" /> });
		if (!head.filesLoaded) {
			rows.push({ node: <text color="dim"> Loading changed files…</text> });
			return rows;
		}
		const additions = head.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
		const deletions = head.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
		rows.push({
			node: (
				<text wrap="clip">
					{" "}
					<span bold>{`${head.files.length} modified`}</span>
					{"  "}
					<span color="success">{`+${additions}`}</span> <span color="error">{`−${deletions}`}</span>{" "}
					<span color="dim">{`· ${head.shortSha}`}</span>
				</text>
			),
		});
		rows.push(this.#viewToggleRow());
		rows.push(...this.#fileRows(head.files, "commit", isSelected));
		return rows;
	}
}
