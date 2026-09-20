import * as path from "node:path";

import { buildPathTree, isUrlLikePath, type PathTreeInput, walkPathTree } from "@oh-my-pi/pi-utils";

// =============================================================================
// Grouped file output (grep / ast-grep / ast-edit / lsp diagnostics)
// =============================================================================

/**
 * One file's contribution to a grouped file output. The header itself is generated
 * by `formatGroupedFiles` (one `#` per nesting level); use `headerSuffix` to tack
 * on extras like ` (1 replacement)`.
 */
/** One match or context line within a grouped file presentation. */
export interface GroupedMatch {
	filePath: string;
	line?: number;
	column?: number;
	text: string;
	isMatch: boolean;
	raw: string;
}

/** One coordinate reference (file, line, column). */
export interface GroupedCoordinate {
	filePath: string;
	line?: number;
	column?: number;
}

/** One directory entry in the grouped directory tree. */
export interface GroupedDirectory {
	path: string;
	name: string;
	depth: number;
}

/** One file entry with its presentation structure. */
export interface GroupedFile {
	path: string;
	name: string;
	depth: number;
	headerSuffix?: string;
	lines: string[];
	displayLines: string[];
	matches: GroupedMatch[];
	coordinates: GroupedCoordinate[];
	notices: string[];
}

/** Structured presentation output beside model-facing and display-facing text. */
export interface GroupedFilesStructure {
	files: GroupedFile[];
	directories: GroupedDirectory[];
	matches: GroupedMatch[];
	coordinates: GroupedCoordinate[];
	notices: string[];
}

export interface GroupedFileSection {
	/** Optional suffix appended to the file header. */
	headerSuffix?: string;
	/** Body lines emitted into the textual model output. */
	modelLines: string[];
	/** Body lines emitted into the display output. Defaults to `modelLines`. */
	displayLines?: string[];
	/** When true, the file (and its header) is omitted entirely. */
	skip?: boolean;
	/** Optional notices associated with this file. */
	notices?: string[];
	/** Optional pre-parsed coordinates for matches in this file. */
	coordinates?: GroupedCoordinate[];
	/** Optional pre-parsed matches in this file. */
	matches?: GroupedMatch[];
}

/** Parallel model-facing and display-facing lines for grouped files, with structured presentation. */
export interface GroupedFilesOutput {
	model: string[];
	display: string[];
	structure: GroupedFilesStructure;
	files: GroupedFile[];
	directories: GroupedDirectory[];
	matches: GroupedMatch[];
	coordinates: GroupedCoordinate[];
	notices: string[];
}

/**
 * Render a list of files as a multi-level, prefix-folded directory tree shared by
 * grep, ast-grep, ast-edit, and the LSP diagnostic formatter.
 *
 * Layout (one `#` per level; the shared prefix folds into the top header):
 *   # packages/pkg/src/
 *   ## root.ts
 *   …body…
 *   ## nested/
 *   ### child.ts
 *   …body…
 *
 * Files in the (folded) project root become single-`#` headers with no parent
 * directory line. A blank line precedes every directory header and every
 * root-level file so the renderers can split the output into collapsible groups.
 */
export function formatGroupedFiles(
	files: string[],
	renderFile: (filePath: string) => GroupedFileSection,
): GroupedFilesOutput {
	const sections = new Map<string, GroupedFileSection>();
	const inputs: PathTreeInput[] = [];
	for (const filePath of files) {
		if (sections.has(filePath)) continue;
		const section = renderFile(filePath);
		if (section.skip) continue;
		sections.set(filePath, section);
		inputs.push({ path: filePath, isDir: false, key: filePath });
	}

	const tree = buildPathTree(inputs);
	const model: string[] = [];
	const display: string[] = [];
	const allFiles: GroupedFile[] = [];
	const directories: GroupedDirectory[] = [];
	const allMatches: GroupedMatch[] = [];
	const allCoordinates: GroupedCoordinate[] = [];
	const allNotices: string[] = [];
	let emitted = false;

	for (const event of walkPathTree(tree)) {
		const hashes = "#".repeat(event.depth + 1);
		const needsSeparator = emitted && (event.depth === 0 || event.kind === "dir");
		if (needsSeparator) {
			model.push("");
			display.push("");
		}
		emitted = true;
		if (event.kind === "dir") {
			const header = `${hashes} ${event.name}/`;
			model.push(header);
			display.push(header);
			directories.push({
				path: event.name,
				name: event.name,
				depth: event.depth,
			});
			continue;
		}
		const section = sections.get(event.key)!;
		const filePath = event.key;
		const header = `${hashes} ${event.name}${section.headerSuffix ?? ""}`;
		model.push(header, ...section.modelLines);
		const displayLines = section.displayLines ?? section.modelLines;
		display.push(header, ...displayLines);

		const fileMatches: GroupedMatch[] = section.matches ? [...section.matches] : [];
		const fileCoordinates: GroupedCoordinate[] = section.coordinates ? [...section.coordinates] : [];
		const fileNotices: string[] = section.notices ? [...section.notices] : [];

		if (!section.matches) {
			for (const line of displayLines) {
				const match = SEARCH_LINE_RE.exec(line);
				if (match) {
					const isMatch = match[1] === "*" || (!line.startsWith(" ") && match[1] === "");
					const lineNum = Number.parseInt(match[2]!, 10);
					const text = match[3] ?? "";
					const m: GroupedMatch = { filePath, line: lineNum, text, isMatch, raw: line };
					fileMatches.push(m);
					fileCoordinates.push({ filePath, line: lineNum });
				} else if (NOTICE_LINE_RE.test(line.trim())) {
					fileNotices.push(line.trim());
				}
			}
		}

		allMatches.push(...fileMatches);
		allCoordinates.push(...fileCoordinates);
		allNotices.push(...fileNotices);

		allFiles.push({
			path: filePath,
			name: event.name,
			depth: event.depth,
			headerSuffix: section.headerSuffix,
			lines: section.modelLines,
			displayLines,
			matches: fileMatches,
			coordinates: fileCoordinates,
			notices: fileNotices,
		});
	}

	const structure: GroupedFilesStructure = {
		files: allFiles,
		directories,
		matches: allMatches,
		coordinates: allCoordinates,
		notices: allNotices,
	};

	return {
		model,
		display,
		structure,
		files: allFiles,
		directories,
		matches: allMatches,
		coordinates: allCoordinates,
		notices: allNotices,
	};
}

const SEARCH_LINE_RE = /^\s*(\*?)\s*(\d+)(?:│|[:|])(.*)$/;
const FILE_LINE_RE = /^([^\s:]+):(\d+)(?::(.*))?$/;
const NOTICE_LINE_RE = /^(?:Parse issues:|Result limit reached|limit reached|skipped missing:|warning:|notice:)/i;

/**
 * Parse text or lines of grouped output back into the structured presentation format.
 * Enables views to consume the exact same structured presentation format without
 * ever re-parsing `#` headers in view code.
 */
export function parseGroupedOutputToStructure(
	textOrLines: string | readonly string[],
	headerBase?: string,
): GroupedFilesStructure {
	const rawLines = typeof textOrLines === "string" ? textOrLines.split("\n") : textOrLines;
	const lines = rawLines.map(line => line.trimEnd());
	const contexts = classifyGroupedLines(lines, headerBase);

	const files: GroupedFile[] = [];
	const directories: GroupedDirectory[] = [];
	const matches: GroupedMatch[] = [];
	const coordinates: GroupedCoordinate[] = [];
	const notices: string[] = [];

	let currentFile: GroupedFile | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line) continue;
		const ctx = contexts[i]!;

		if (ctx.kind === "dir") {
			directories.push({
				path: ctx.headerPath ?? line.replace(/^#+\s+/, "").replace(/\/$/, ""),
				name: line.replace(/^#+\s+/, "").replace(/\/$/, ""),
				depth: ctx.depth,
			});
			currentFile = null;
			continue;
		}

		if (ctx.kind === "file") {
			const cleanHeader = line.replace(/^#+\s+/, "");
			const filePath = ctx.headerPath ?? cleanHeader.replace(HEADER_SUFFIX_RE, "").replace(HEADER_HASH_TAG_RE, "");
			const suffixMatch = HEADER_SUFFIX_RE.exec(cleanHeader);
			const hashMatch = HEADER_HASH_TAG_RE.exec(cleanHeader);
			const headerSuffix = suffixMatch ? suffixMatch[0] : hashMatch ? hashMatch[0] : undefined;
			const name = path.basename(filePath);

			currentFile = {
				path: filePath,
				name,
				depth: ctx.depth,
				headerSuffix,
				lines: [],
				displayLines: [],
				matches: [],
				coordinates: [],
				notices: [],
			};
			files.push(currentFile);
			continue;
		}

		// Content line
		if (NOTICE_LINE_RE.test(line.trim())) {
			notices.push(line.trim());
			if (currentFile) currentFile.notices.push(line.trim());
			continue;
		}

		if (currentFile === null && (ctx.filePath || headerBase)) {
			const filePath = ctx.filePath ?? headerBase!;
			currentFile = {
				path: filePath,
				name: path.basename(filePath),
				depth: 0,
				lines: [],
				displayLines: [],
				matches: [],
				coordinates: [],
				notices: [],
			};
			files.push(currentFile);
		}

		const searchMatch = SEARCH_LINE_RE.exec(line);
		const fileMatch = !searchMatch ? FILE_LINE_RE.exec(line) : null;
		if (fileMatch) {
			const targetFile = fileMatch[1]!;
			const lineNum = Number.parseInt(fileMatch[2]!, 10);
			const text = fileMatch[3] ?? "";
			if (!currentFile || currentFile.path !== targetFile) {
				currentFile = {
					path: targetFile,
					name: path.basename(targetFile),
					depth: 0,
					lines: [],
					displayLines: [],
					matches: [],
					coordinates: [],
					notices: [],
				};
				files.push(currentFile);
			}
			const m: GroupedMatch = { filePath: targetFile, line: lineNum, text, isMatch: true, raw: line };
			matches.push(m);
			coordinates.push({ filePath: targetFile, line: lineNum });
			currentFile.matches.push(m);
			currentFile.coordinates.push({ filePath: targetFile, line: lineNum });
		} else if (searchMatch) {
			const targetFile = currentFile?.path ?? ctx.filePath ?? "";
			const isMatch = searchMatch[1] === "*" || (!line.startsWith(" ") && searchMatch[1] === "");
			const lineNum = Number.parseInt(searchMatch[2]!, 10);
			const text = searchMatch[3] ?? "";
			const m: GroupedMatch = { filePath: targetFile, line: lineNum, text, isMatch, raw: line };
			matches.push(m);
			coordinates.push({ filePath: targetFile, line: lineNum });
			if (currentFile) {
				currentFile.matches.push(m);
				currentFile.coordinates.push({ filePath: targetFile, line: lineNum });
			}
		}

		if (currentFile) {
			currentFile.lines.push(line);
			currentFile.displayLines.push(line);
		}
	}

	return {
		files,
		directories,
		matches,
		coordinates,
		notices,
	};
}

// =============================================================================
// Parsing grouped output back into per-line context (TUI renderers)
// =============================================================================

const GROUPED_HEADER_RE = /^(#+)\s+(.*)$/;
const HEADER_SUFFIX_RE = /\s+\([^)]*\)\s*$/;
const HEADER_HASH_TAG_RE = /#[0-9a-f]+$/i;

/** Per-line classification of grouped output, used by renderers for hyperlinks. */
export interface GroupedLineContext {
	/** Directory header, file header, or any non-header body/content line. */
	kind: "dir" | "file" | "content";
	/** Number of leading `#` for headers; 0 for content lines. */
	depth: number;
	/** Resolved absolute path of the dir/file a header points at (when resolvable). */
	headerPath?: string;
	/** For content lines, the absolute path of the owning file (line hyperlinks). */
	filePath?: string;
	/** Header is an internal/url-like target the caller resolves itself. */
	isUrl?: boolean;
}

function resolveGroupedPath(parent: string | undefined, name: string): string | undefined {
	if (parent === undefined) return undefined;
	if (name === "" || name === ".") return parent;
	// `path.resolve` keeps an absolute `name` intact (out-of-cwd results) while
	// joining a relative folded chain (`packages/pkg/src`) onto the parent.
	return path.resolve(parent, name);
}

/**
 * Walk grouped output lines, tracking a directory stack keyed by header depth, so
 * each header and body line can be linked back to its absolute filesystem path.
 * Reconstruction is stack-based (not per-blank-group) so nested directory headers
 * resolve correctly across the whole output.
 *
 * `headerBase` is the directory the displayed (folded) header paths are relative
 * to — for grep/ast tools that is the session cwd, since display paths are
 * formatted relative to cwd regardless of the (sub)directory the search was
 * scoped to. `fileScope` is the initial owning file for body lines that appear
 * before any header (single-file scopes have no `#` headers); it defaults to
 * `headerBase` and should be passed the scoped file's absolute path.
 */
export function classifyGroupedLines(
	lines: readonly string[],
	headerBase: string | undefined,
	fileScope: string | undefined = headerBase,
): GroupedLineContext[] {
	const result: GroupedLineContext[] = [];
	const dirAtDepth = new Map<number, string>();
	// Body lines before any header (single-file scopes) link to the scoped file.
	let currentFile = fileScope;

	const clearDeeper = (depth: number) => {
		for (const key of dirAtDepth.keys()) {
			if (key >= depth) dirAtDepth.delete(key);
		}
	};

	for (const line of lines) {
		const match = GROUPED_HEADER_RE.exec(line);
		if (!match) {
			result.push({ kind: "content", depth: 0, filePath: currentFile });
			continue;
		}
		const depth = match[1]!.length;
		const rest = match[2]!.trimEnd();
		if (isUrlLikePath(rest)) {
			clearDeeper(depth);
			currentFile = undefined;
			result.push({ kind: "file", depth, isUrl: true });
			continue;
		}
		const parent = depth > 1 ? dirAtDepth.get(depth - 1) : headerBase;
		if (rest.endsWith("/")) {
			const name = rest.slice(0, -1).replace(HEADER_SUFFIX_RE, "");
			const abs = resolveGroupedPath(parent, name);
			clearDeeper(depth);
			if (abs !== undefined) dirAtDepth.set(depth, abs);
			currentFile = undefined;
			result.push({ kind: "dir", depth, headerPath: abs });
			continue;
		}
		const name = rest.replace(HEADER_SUFFIX_RE, "").replace(HEADER_HASH_TAG_RE, "");
		const abs = name ? resolveGroupedPath(parent, name) : undefined;
		currentFile = abs;
		result.push({ kind: "file", depth, headerPath: abs });
	}

	return result;
}

/**
 * Split line indices into blank-line-separated groups, mirroring
 * `splitGroupsByBlankLine`: when any blank line is present, break on runs of
 * blanks; otherwise return a single group of the non-empty lines. Returning
 * indices lets callers slice parallel arrays (raw lines, styled lines, contexts).
 */
export function groupLineIndicesByBlank(rawLines: readonly string[]): number[][] {
	const hasSeparators = rawLines.some(line => line.trim().length === 0);
	const groups: number[][] = [];
	if (hasSeparators) {
		let current: number[] = [];
		for (let i = 0; i < rawLines.length; i++) {
			if (rawLines[i]!.trim().length === 0) {
				if (current.length > 0) {
					groups.push(current);
					current = [];
				}
				continue;
			}
			current.push(i);
		}
		if (current.length > 0) groups.push(current);
	} else {
		const current: number[] = [];
		for (let i = 0; i < rawLines.length; i++) {
			if (rawLines[i]!.trim().length > 0) current.push(i);
		}
		if (current.length > 0) groups.push(current);
	}
	return groups;
}
