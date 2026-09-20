import { createEffect, createMemo, For, Show, useTheme, type Accessor, type JSX } from "../reactive";
import { createDocument } from "../document/document";
import { getLanguageFromPath } from "../lang-from-path";
import {
	parseDiagnosticMessage,
	replaceTabs,
	sanitizeDiagnosticDisplayText,
	shortenPath,
	type ParsedDiagnostic,
} from "../render/render-utils";
import type { ToolUIStatus } from "../host/elements/status";
import { Card } from "../view/card";
import { ExpandHint } from "../view/expand-hint";
import type { ToolViewDefinition, ToolViewProps } from "./view";
import { registerToolView } from "./registry";

/** Display arguments for an LSP tool request. */
export interface LspParams {
	action:
		| "diagnostics"
		| "definition"
		| "references"
		| "hover"
		| "symbols"
		| "rename"
		| "rename_file"
		| "code_actions"
		| "type_definition"
		| "implementation"
		| "status"
		| "reload"
		| "capabilities"
		| "request";
	file?: string;
	line?: number;
	symbol?: string;
	query?: string;
	new_name?: string;
	apply?: boolean;
	timeout?: number;
	payload?: string;
}

/** Details accompanying an LSP tool response. */
export interface LspToolDetails {
	serverName?: string;
	action: string;
	success: boolean;
	request?: LspParams;
}

/** Diagnostics and formatting status for one file. */
export interface FileDiagnosticsResult {
	server?: string;
	readonly messages: readonly string[];
	summary: string;
	errored: boolean;
	formatter?: FileFormatResult;
}

/** Outcome of automatic file formatting. */
export enum FileFormatResult {
	UNCHANGED = "unchanged",
	FORMATTED = "formatted",
	FAILED = "failed",
	UNSUPPORTED = "unsupported",
}

type LspRequest = Readonly<Partial<LspParams>>;

interface RawDiagnostic {
	raw: string;
}

type DiagnosticItem = ParsedDiagnostic | RawDiagnostic;

interface DiagnosticsPresentation {
	readonly errorCount: number;
	readonly warningCount: number;
	readonly items: readonly DiagnosticItem[];
}

interface HoverPresentation {
	readonly language: string;
	readonly code: string;
	readonly beforeCode: string;
	readonly afterCode: string;
	readonly codeLineCount: number;
}

interface ReferenceLocation {
	readonly line: string;
	readonly col: string;
}

interface ReferenceFile {
	readonly path: string;
	readonly locations: readonly ReferenceLocation[];
}

interface ReferencesPresentation {
	readonly count: number;
	readonly files: readonly ReferenceFile[];
}

interface SymbolInfo {
	readonly name: string;
	readonly line: string;
	readonly indent: number;
	readonly icon: string;
}

interface PresentationIcon {
	readonly name: "status.error" | "status.warning" | "status.info" | "tool.lsp";
	readonly color: "error" | "warning" | "accent";
}

type LspContentKind = "hover" | "diagnostics" | "references" | "symbols" | "diagnostics_ok" | "response";

function sanitizeInlineText(value: string): string {
	return replaceTabs(value).replaceAll(/\r?\n/g, " ");
}

function flattenHeaderText(value: string): string {
	return value.replace(/\r\n?|\n/g, " ");
}

function requestFrom(args: LspRequest, details: Readonly<LspToolDetails> | undefined): LspRequest | undefined {
	return args.action ? args : details?.request;
}

function actionLabel(
	request: LspRequest | undefined,
	details: Readonly<LspToolDetails> | undefined,
	fallback: string,
): string {
	return (request?.action ?? details?.action ?? fallback).replaceAll("_", " ");
}

function formatDiagnosticMessage(diagnostic: ParsedDiagnostic): string {
	const source = diagnostic.source ? `[${diagnostic.source}] ` : "";
	const code = diagnostic.code ? ` (${diagnostic.code})` : "";
	return `${source}${diagnostic.message}${code}`;
}

function severityColor(severity: ParsedDiagnostic["severity"]): "error" | "warning" | "accent" | "dim" {
	if (severity === "error") return "error";
	if (severity === "warning") return "warning";
	if (severity === "info") return "accent";
	return "dim";
}

function formatTarget(args: LspRequest): string | undefined {
	let target = args.file ? shortenPath(args.file) : undefined;
	const queryPreview = args.query;
	const symbolPreview = args.symbol ? sanitizeInlineText(args.symbol) : undefined;

	if (target && args.line !== undefined) {
		target += `:${args.line}`;
		if (symbolPreview) target += ` (${symbolPreview})`;
	} else if (!target && args.line !== undefined) {
		target = `line ${args.line}`;
		if (symbolPreview) target += ` (${symbolPreview})`;
	}

	return target ?? queryPreview;
}

function callPresentation(
	request: LspRequest | undefined,
	details: Readonly<LspToolDetails> | undefined,
): {
	readonly description: string;
	readonly meta: readonly string[];
} {
	const action = actionLabel(request, details, "request");
	const queryPreview = request?.query;
	const target = request && (request.file || request.line !== undefined) ? formatTarget(request) : undefined;
	const meta: string[] = [];
	if (queryPreview && target) meta.push(`query:${queryPreview}`);
	if (request?.new_name) meta.push(`new:${request.new_name}`);
	if (request?.apply !== undefined) meta.push(`apply:${request.apply ? "true" : "false"}`);
	const description = target ? `${action} ${target}` : queryPreview ? `${action} ${queryPreview}` : action;
	return { description, meta };
}

function parseHover(text: string): HoverPresentation | undefined {
	const match = text.match(/```(\w*)\n([\s\S]*?)```/);
	if (!match) return undefined;
	const code = match[2].trim();
	const codeStart = match.index ?? 0;
	const beforeCode = text.slice(0, codeStart).trimEnd();
	const afterCode = text.slice(text.indexOf("```", 3) + 3).trim();
	return {
		language: match[1] ?? "",
		code,
		beforeCode,
		afterCode,
		codeLineCount: code.split("\n").length,
	};
}

function parseDiagnostics(text: string, errorGlyph: string): DiagnosticsPresentation {
	const errorCount = Number.parseInt(text.match(/(\d+)\s+error\(s\)/)?.[1] ?? "0", 10);
	const warningCount = Number.parseInt(text.match(/(\d+)\s+warning\(s\)/)?.[1] ?? "0", 10);
	const lines = text.split("\n");
	const diagnosticLines = lines.filter(line => line.includes(errorGlyph) || /:\d+:\d+/.test(line));
	const parsed = diagnosticLines
		.map(line => parseDiagnosticMessage(line.trim()))
		.filter((diagnostic): diagnostic is ParsedDiagnostic => diagnostic !== null);
	const items =
		parsed.length > 0 ? parsed : diagnosticLines.map(raw => ({ raw: sanitizeDiagnosticDisplayText(raw.trim()) }));
	return { errorCount, warningCount, items };
}

function parseReferences(text: string, match: RegExpMatchArray): ReferencesPresentation {
	const byFile = new Map<string, ReferenceLocation[]>();
	for (const location of text.split("\n").filter(line => /^\s*\S+:\d+:\d+/.test(line))) {
		const parts = location.trim().match(/^(.+):(\d+):(\d+)$/);
		if (!parts) continue;
		const path = parts[1];
		const line = parts[2];
		const col = parts[3];
		if (!path || !line || !col) continue;
		const locations = byFile.get(path);
		if (locations) locations.push({ line, col });
		else byFile.set(path, [{ line, col }]);
	}
	return {
		count: Number.parseInt(match[1] ?? "0", 10),
		files: [...byFile].map(([path, locations]) => ({ path, locations })),
	};
}

function parseSymbols(text: string): readonly SymbolInfo[] {
	const symbols: SymbolInfo[] = [];
	for (const line of text.split("\n").filter(value => value.includes("@") && value.includes("line"))) {
		const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
		const match = line.trim().match(/^(\S+)\s+(.+?)\s*@\s*line\s*(\d+)/);
		if (!match) continue;
		const icon = match[1];
		const name = match[2];
		const sourceLine = match[3];
		if (!icon || !name || !sourceLine) continue;
		symbols.push({ icon, name, line: sourceLine, indent });
	}
	return symbols;
}

function isLastSibling(symbols: readonly SymbolInfo[], index: number): boolean {
	const symbol = symbols[index];
	if (!symbol) return true;
	for (let nextIndex = index + 1; nextIndex < symbols.length; nextIndex++) {
		const next = symbols[nextIndex];
		if (!next) continue;
		if (next.indent === symbol.indent) return false;
		if (next.indent < symbol.indent) return true;
	}
	return true;
}

function symbolPrefix(symbols: readonly SymbolInfo[], index: number, vertical: string): string {
	const symbol = symbols[index];
	if (!symbol || symbol.indent === 0) return " ";
	let prefix = " ";
	for (let level = 2; level <= symbol.indent; level += 2) {
		let ancestorIndex = -1;
		for (let candidate = index - 1; candidate >= 0; candidate--) {
			if (symbols[candidate]?.indent === level - 2) {
				ancestorIndex = candidate;
				break;
			}
		}
		prefix += ancestorIndex >= 0 && isLastSibling(symbols, ancestorIndex) ? "   " : `${vertical}  `;
	}
	return prefix;
}

function LspCallHeader(props: {
	readonly phase: ToolViewProps<LspParams, LspToolDetails>["phase"];
	readonly request: Accessor<LspRequest | undefined>;
	readonly details: Accessor<Readonly<LspToolDetails> | undefined>;
}): JSX.Element {
	const { theme } = useTheme();
	const presentation = createMemo(() => callPresentation(props.request(), props.details()));
	return (
		<text wrap="word">
			<status value="pending" /> <span color="accent">LSP</span>
			<span>: </span>
			<span color="muted">{flattenHeaderText(presentation().description)}</span>
			<Show when={presentation().meta.length > 0}>
				<span color="dim"> {flattenHeaderText(presentation().meta.join(theme().sep.dot))}</span>
			</Show>
		</text>
	);
}

function LspResultHeader(props: {
	readonly phase: Accessor<ToolViewProps<LspParams, LspToolDetails>["phase"]>;
	readonly outcome: Accessor<ToolViewProps<LspParams, LspToolDetails>["outcome"]>;
	readonly action: Accessor<string>;
}): JSX.Element {
	const failed = createMemo(() => props.outcome() === "failed" || props.outcome() === "timed_out");
	const aborted = createMemo(() => props.outcome() === "cancelled" || props.outcome() === "skipped");
	return (
		<row gap={1}>
			<Show
				when={props.phase() === "running"}
				fallback={
					<Show
						when={failed()}
						fallback={
							<Show when={aborted()} fallback={<icon name="tool.lsp" color="accent" />}>
								<icon name="status.aborted" color="error" />
							</Show>
						}
					>
						<icon name="status.error" color="error" />
					</Show>
				}
			>
				<status value="running" />
			</Show>
			<text wrap="none">LSP {props.action()}</text>
		</row>
	);
}

function RequestDetails(props: { readonly request: Accessor<LspRequest | undefined> }): JSX.Element {
	const request = props.request;
	const hasDetails = createMemo(() => {
		const current = request();
		return Boolean(
			current?.file ||
			current?.line !== undefined ||
			current?.symbol ||
			current?.query ||
			current?.new_name ||
			current?.apply !== undefined,
		);
	});
	return (
		<Show when={hasDetails()}>
			<stack>
				<Show when={request()?.file}>
					<text color="toolOutput">{request()!.file}</text>
				</Show>
				<Show when={request()!.line !== undefined}>
					<text color="dim">line {request()!.line}</text>
				</Show>
				<Show when={request()!.symbol}>
					<text color="dim">symbol: {sanitizeInlineText(request()!.symbol!)}</text>
				</Show>
				<Show when={request()!.query}>
					<text color="dim">query: {request()!.query}</text>
				</Show>
				<Show when={request()!.new_name}>
					<text color="dim">new name: {request()!.new_name}</text>
				</Show>
				<Show when={request()!.apply !== undefined}>
					<text color="dim">apply: {request()!.apply ? "true" : "false"}</text>
				</Show>
			</stack>
		</Show>
	);
}

function HoverView(props: {
	readonly presentation: Accessor<HoverPresentation | undefined>;
	readonly expanded: Accessor<boolean>;
}): JSX.Element {
	const { theme } = useTheme();
	const document = createDocument(props.presentation()?.code ?? "");
	createEffect(() => {
		const code = props.presentation()?.code ?? "";
		if (document.text() !== code) document.apply({ kind: "reset", text: code });
	});
	const hasMore = createMemo(() => {
		const hover = props.presentation();
		return hover !== undefined && (hover.codeLineCount > 1 || Boolean(hover.beforeCode) || Boolean(hover.afterCode));
	});
	return (
		<Show
			when={props.expanded()}
			fallback={
				<stack>
					<text color="mdCodeBlockBorder">
						<icon name="status.info" color="accent" />
						<Show when={props.presentation()?.language}>
							<span> {props.presentation()!.language}</span>
						</Show>
						<ExpandHint expanded={props.expanded()} hasMore={hasMore()} />
					</text>
					<Show when={props.presentation()?.beforeCode}>
						<text wrap="clip" overflow="ellipsis">
							<span color="dim"> {theme().tree.branch} </span>
							<span color="muted">{props.presentation()!.beforeCode}</span>
						</text>
					</Show>
					<rail
						prefix={<span color="mdCodeBlockBorder">{theme().boxRound.vertical} </span>}
						rest={<span color="mdCodeBlockBorder">{theme().boxRound.vertical} </span>}
					>
						<code document={document} language={props.presentation()?.language} lineNumbers={false} endLine={1} />
					</rail>
					<Show when={props.presentation()?.codeLineCount && props.presentation()!.codeLineCount > 1}>
						<text color="mdCodeBlockBorder">
							{theme().boxRound.vertical}{" "}
							<span color="muted">… {props.presentation()!.codeLineCount - 1} more lines</span>
						</text>
					</Show>
					<Show
						when={props.presentation()?.afterCode}
						fallback={
							<text color="mdCodeBlockBorder">
								{theme().boxRound.bottomLeft}
								{theme().boxRound.horizontal.repeat(3)}
							</text>
						}
					>
						<text wrap="clip" overflow="ellipsis">
							<span color="dim"> {theme().tree.last} </span>
							<span color="muted">{props.presentation()!.afterCode}</span>
						</text>
					</Show>
				</stack>
			}
		>
			<stack>
				<text color="mdCodeBlockBorder">
					<icon name="status.info" color="accent" />
					<Show when={props.presentation()?.language}>
						<span> {props.presentation()!.language}</span>
					</Show>
				</text>
				<Show when={props.presentation()?.beforeCode}>
					<For each={props.presentation()!.beforeCode.split("\n")}>
						{line => <text color="muted"> {line}</text>}
					</For>
				</Show>
				<text color="mdCodeBlockBorder">
					{" "}
					{theme().boxRound.topLeft}
					{theme().boxRound.horizontal.repeat(3)}
				</text>
				<rail
					prefix={<span color="mdCodeBlockBorder"> {theme().boxRound.vertical} </span>}
					rest={<span color="mdCodeBlockBorder"> {theme().boxRound.vertical} </span>}
				>
					<code document={document} language={props.presentation()?.language} lineNumbers={false} />
				</rail>
				<text color="mdCodeBlockBorder">
					{" "}
					{theme().boxRound.bottomLeft}
					{theme().boxRound.horizontal.repeat(3)}
				</text>
				<Show when={props.presentation()?.afterCode}>
					<text color="muted"> {props.presentation()!.afterCode}</text>
				</Show>
			</stack>
		</Show>
	);
}

function DiagnosticsView(props: {
	readonly diagnostics: Accessor<DiagnosticsPresentation>;
	readonly expanded: Accessor<boolean>;
}): JSX.Element {
	const { theme } = useTheme();
	const items = createMemo(() => {
		const all = props.diagnostics().items;
		return props.expanded() ? all : all.slice(0, 3);
	});
	const remaining = createMemo(() => Math.max(0, props.diagnostics().items.length - items().length));
	const meta = createMemo(() => {
		const diagnostics = props.diagnostics();
		const values: string[] = [];
		if (diagnostics.errorCount > 0)
			values.push(`${diagnostics.errorCount} error${diagnostics.errorCount === 1 ? "" : "s"}`);
		if (diagnostics.warningCount > 0)
			values.push(`${diagnostics.warningCount} warning${diagnostics.warningCount === 1 ? "" : "s"}`);
		return values.length > 0 ? values.join(theme().sep.dot) : "No issues";
	});
	const icon = createMemo<PresentationIcon>(() => {
		const diagnostics = props.diagnostics();
		if (diagnostics.errorCount > 0) return { name: "status.error", color: "error" };
		if (diagnostics.warningCount > 0) return { name: "status.warning", color: "warning" };
		return { name: "tool.lsp", color: "accent" };
	});
	return (
		<stack>
			<text>
				<icon name={icon().name} color={icon().color} /> <span color="dim">{meta()}</span>
				<ExpandHint expanded={props.expanded()} hasMore={remaining() > 0} />
			</text>
			<tree>
				<For each={items()}>
					{item => {
						if ("raw" in item) {
							return (
								<text color="muted" wrap="clip" overflow="ellipsis">
									{item.raw}
								</text>
							);
						}
						const message = formatDiagnosticMessage(item);
						return (
							<stack>
								<row gap={1}>
									<text color="muted" wrap="none" shrink={0}>
										{theme().getLangIcon(getLanguageFromPath(item.filePath))}
									</text>
									<text color={severityColor(item.severity)} wrap="clip" overflow="ellipsis">
										{item.filePath}:{item.line}:{item.col}
									</text>
									<text color="dim" wrap="none" shrink={0}>{`[${item.severity}]`}</text>
								</row>
								<Show when={message}>
									<text color="muted" wrap="clip" overflow="ellipsis">
										{message}
									</text>
								</Show>
							</stack>
						);
					}}
				</For>
				<Show when={remaining() > 0}>
					<text color="muted">… {remaining()} more</text>
				</Show>
			</tree>
		</stack>
	);
}

function ReferenceFileView(props: {
	readonly file: ReferenceFile;
	readonly expanded: Accessor<boolean>;
	readonly index: number;
	readonly fileCount: number;
	readonly hasMoreFiles: boolean;
}): JSX.Element {
	const { theme } = useTheme();
	const locations = createMemo(() =>
		props.expanded() ? props.file.locations.slice(0, 3) : props.file.locations.slice(0, 1),
	);
	const remaining = createMemo(() => Math.max(0, props.file.locations.length - locations().length));
	const fileContinues = createMemo(() => props.index < props.fileCount - 1 || props.hasMoreFiles);
	return (
		<stack>
			<text>
				{" "}
				<span color="dim">{fileContinues() ? theme().tree.branch : theme().tree.last}</span>{" "}
				<span color="accent">{props.file.path}</span>{" "}
				<span color="dim">
					{props.file.locations.length} reference{props.file.locations.length === 1 ? "" : "s"}
				</span>
			</text>
			<For each={locations()}>
				{(location, index) => {
					const locationContinues = () => index() < locations().length - 1 || remaining() > 0;
					return (
						<stack>
							<text>
								{" "}
								<span color="dim">{fileContinues() ? `${theme().tree.vertical}  ` : "   "}</span>
								<span color="dim">{locationContinues() ? theme().tree.branch : theme().tree.last}</span>{" "}
								<span color="muted">
									line {location.line}, col {location.col}
								</span>
							</text>
							<Show when={props.expanded()}>
								<text>
									{" "}
									<span color="dim">{fileContinues() ? `${theme().tree.vertical}  ` : "   "}</span>
									<span color="dim">{locationContinues() ? `${theme().tree.vertical}  ` : "   "}</span>
									<span color="muted">
										at {props.file.path}:{location.line}:{location.col}
									</span>
								</text>
							</Show>
						</stack>
					);
				}}
			</For>
			<Show when={remaining() > 0}>
				<text>
					{" "}
					<span color="dim">{fileContinues() ? `${theme().tree.vertical}  ` : "   "}</span>
					<span color="dim">{theme().tree.last}</span> <span color="muted">… {remaining()} more</span>
				</text>
			</Show>
		</stack>
	);
}

function ReferencesView(props: {
	readonly presentation: Accessor<ReferencesPresentation | undefined>;
	readonly expanded: Accessor<boolean>;
}): JSX.Element {
	const { theme } = useTheme();
	const visibleFiles = createMemo(() => {
		const files = props.presentation()?.files ?? [];
		return props.expanded() ? files : files.slice(0, 3);
	});
	const remaining = createMemo(() => Math.max(0, (props.presentation()?.files.length ?? 0) - visibleFiles().length));
	return (
		<stack>
			<text>
				<icon
					name={(props.presentation()?.count ?? 0) > 0 ? "tool.lsp" : "status.warning"}
					color={(props.presentation()?.count ?? 0) > 0 ? "accent" : "warning"}
				/>{" "}
				<span color="dim">{props.presentation()?.count ?? 0} found</span>
				<ExpandHint expanded={props.expanded()} hasMore={true} />
			</text>
			<For each={visibleFiles()}>
				{(file, index) => (
					<ReferenceFileView
						file={file}
						expanded={props.expanded}
						index={index()}
						fileCount={visibleFiles().length}
						hasMoreFiles={remaining() > 0}
					/>
				)}
			</For>
			<Show when={remaining() > 0}>
				<text>
					{" "}
					<span color="dim">{theme().tree.last}</span> <span color="muted">… {remaining()} more file</span>
				</text>
			</Show>
		</stack>
	);
}

function SymbolsView(props: { readonly text: Accessor<string>; readonly expanded: Accessor<boolean> }): JSX.Element {
	const { theme } = useTheme();
	const fileName = createMemo(() => props.text().match(/Symbols in (.+):/)?.[1]);
	const symbols = createMemo(() => parseSymbols(props.text()));
	const topLevel = createMemo(() => symbols().filter(symbol => symbol.indent === 0));
	const collapsed = createMemo(() => topLevel().slice(0, 3));
	const hasMore = createMemo(() => symbols().length > collapsed().length);
	const topLevelRemaining = createMemo(() => Math.max(0, topLevel().length - collapsed().length));
	return (
		<stack>
			<text>
				<icon name="status.info" color="accent" /> <span color="dim">in {fileName()}</span>
				<ExpandHint expanded={props.expanded()} hasMore={hasMore()} />
			</text>
			<Show
				when={props.expanded()}
				fallback={
					<stack>
						<For each={collapsed()}>
							{(symbol, index) => (
								<text wrap="clip" overflow="ellipsis">
									<span color="dim">
										{" "}
										{index() === collapsed().length - 1 && topLevelRemaining() === 0
											? theme().tree.last
											: theme().tree.branch}{" "}
									</span>
									<span color="accent">
										{symbol.icon} {symbol.name}
									</span>{" "}
									<span color="muted">line {symbol.line}</span>
								</text>
							)}
						</For>
						<Show when={topLevelRemaining() > 0}>
							<text color="muted">
								{theme().tree.last} … {topLevelRemaining()} more
							</text>
						</Show>
					</stack>
				}
			>
				<For each={symbols()}>
					{(symbol, index) => {
						const prefix = createMemo(() => symbolPrefix(symbols(), index(), theme().tree.vertical));
						const last = createMemo(() => isLastSibling(symbols(), index()));
						return (
							<stack>
								<text wrap="clip" overflow="ellipsis">
									<span color="dim">
										{prefix()}
										{last() ? theme().tree.last : theme().tree.branch}{" "}
									</span>
									<span color="accent">
										{symbol.icon} {symbol.name}
									</span>
								</text>
								<text>
									<span color="dim">
										{prefix()}
										{last() ? "   " : `${theme().tree.vertical}  `}
									</span>
									<span color="muted">line {symbol.line}</span>
								</text>
							</stack>
						);
					}}
				</For>
			</Show>
		</stack>
	);
}

function GenericView(props: { readonly text: Accessor<string>; readonly expanded: Accessor<boolean> }): JSX.Element {
	const { theme } = useTheme();
	const lines = createMemo(() => props.text().split("\n"));
	const hasError = createMemo(() => props.text().includes("Error:") || props.text().includes(theme().status.error));
	const hasSuccess = createMemo(
		() => props.text().includes(theme().status.success) || props.text().includes("Applied"),
	);
	const icon = createMemo<PresentationIcon>(() => {
		if (hasError() && !hasSuccess()) return { name: "status.error", color: "error" };
		if (hasSuccess() && !hasError()) return { name: "tool.lsp", color: "accent" };
		return { name: "status.info", color: "accent" };
	});
	const preview = createMemo(() => lines().slice(1, 4));
	const remaining = createMemo(() => Math.max(0, lines().length - 4));
	return (
		<Show
			when={props.expanded()}
			fallback={
				<stack>
					<text>
						<icon name={icon().name} color={icon().color} /> <span color="dim">{lines()[0] || "No output"}</span>
						<ExpandHint expanded={props.expanded()} hasMore={lines().length > 1} />
					</text>
					<Show when={lines().length > 1}>
						<tree>
							<For each={preview()}>
								{line => (
									<text color="dim" wrap="clip" overflow="ellipsis">
										{replaceTabs(line.trim())}
									</text>
								)}
							</For>
							<Show when={remaining() > 0}>
								<text color="muted">… {remaining()} more lines</text>
							</Show>
						</tree>
					</Show>
				</stack>
			}
		>
			<stack>
				<text>
					<icon name={icon().name} color={icon().color} /> <span color="dim">Output</span>
				</text>
				<For each={lines()}>
					{line => (
						<text>
							{" "}
							<span color="dim">{theme().tree.last}</span> {replaceTabs(line)}
						</text>
					)}
				</For>
			</stack>
		</Show>
	);
}

function NoResultView(): JSX.Element {
	return (
		<stack>
			<row gap={1}>
				<icon name="status.warning" color="warning" />
				<text color="accent">LSP</text>
			</row>
			<text color="dim">No result</text>
		</stack>
	);
}

function TerminalEmptyResult(props: {
	readonly phase: Accessor<ToolViewProps<LspParams, LspToolDetails>["phase"]>;
	readonly outcome: Accessor<ToolViewProps<LspParams, LspToolDetails>["outcome"]>;
	readonly action: Accessor<string>;
}): JSX.Element {
	const failed = createMemo(() => props.outcome() === "failed" || props.outcome() === "timed_out");
	const aborted = createMemo(() => props.outcome() === "cancelled" || props.outcome() === "skipped");
	return (
		<Show when={failed() || aborted()} fallback={<NoResultView />}>
			<Card
				title={<LspResultHeader phase={props.phase} outcome={props.outcome} action={props.action} />}
				borderColor="dim"
			>
				<stack>
					<hr variant="frame" label="Response" />
					<text color={aborted() ? "warning" : "error"}>{aborted() ? "Cancelled" : "No result"}</text>
				</stack>
			</Card>
		</Show>
	);
}

/** Reactive LSP request and result presentation. */
export const lspToolView: ToolViewDefinition<LspParams, LspToolDetails> = {
	framed: true,
	tint: false,
	view: (props: ToolViewProps<LspParams, LspToolDetails>): JSX.Element => {
		const { theme } = useTheme();
		const request = createMemo(() => requestFrom(props.args, props.details));
		const text = createMemo(() => props.output.text());
		const hover = createMemo(() => parseHover(text()));
		const diagnostics = createMemo(() => parseDiagnostics(text(), theme().status.error));
		const referencesMatch = createMemo(() => text().match(/(\d+)\s+reference\(s\)/));
		const references = createMemo(() => {
			const match = referencesMatch();
			return match ? parseReferences(text(), match) : undefined;
		});
		const symbolsMatch = createMemo(() => text().match(/Symbols in (.+):/));
		const hasStatusError = createMemo(() => text().includes(theme().status.error));
		const hasDiagnostics = createMemo(
			() => diagnostics().errorCount > 0 || diagnostics().warningCount > 0 || hasStatusError(),
		);
		const contentKind = createMemo<LspContentKind>(() => {
			if (hover()) return "hover";
			if (hasDiagnostics()) return "diagnostics";
			if (references()) return "references";
			if (symbolsMatch()) return "symbols";
			if ((request()?.action ?? props.details?.action) === "diagnostics" && text() === "OK") return "diagnostics_ok";
			return "response";
		});
		const resultAction = createMemo(() => {
			const fallback =
				contentKind() === "hover"
					? "hover"
					: contentKind() === "diagnostics" || contentKind() === "diagnostics_ok"
						? "diagnostics"
						: contentKind() === "references"
							? "references"
							: contentKind() === "symbols"
								? "symbols"
								: "response";
			return actionLabel(request(), props.details, fallback);
		});
		const isSettled = createMemo(() => props.phase === "settled");
		const hasResultSurface = createMemo(() => isSettled() || text().length > 0);
		return (
			<Show
				when={hasResultSurface()}
				fallback={<LspCallHeader phase={props.phase} request={request} details={() => props.details} />}
			>
				<Show
					when={text().length > 0}
					fallback={
						<TerminalEmptyResult phase={() => props.phase} outcome={() => props.outcome} action={resultAction} />
					}
				>
					<Card
						title={
							<LspResultHeader phase={() => props.phase} outcome={() => props.outcome} action={resultAction} />
						}
						borderColor="dim"
					>
						<stack>
							<RequestDetails request={request} />
							<hr variant="frame" label="Response" />
							<Show
								when={contentKind() === "hover"}
								fallback={
									<Show
										when={contentKind() === "diagnostics"}
										fallback={
											<Show
												when={contentKind() === "references"}
												fallback={
													<Show
														when={contentKind() === "symbols"}
														fallback={
															<Show
																when={contentKind() === "diagnostics_ok"}
																fallback={
																	<GenericView text={text} expanded={() => props.ui.expanded} />
																}
															>
																<text>
																	<icon name="tool.lsp" color="accent" /> <span color="dim">OK</span>
																</text>
															</Show>
														}
													>
														<SymbolsView text={text} expanded={() => props.ui.expanded} />
													</Show>
												}
											>
												<ReferencesView presentation={references} expanded={() => props.ui.expanded} />
											</Show>
										}
									>
										<DiagnosticsView diagnostics={diagnostics} expanded={() => props.ui.expanded} />
									</Show>
								}
							>
								<HoverView presentation={hover} expanded={() => props.ui.expanded} />
							</Show>
						</stack>
					</Card>
				</Show>
			</Show>
		);
	},

	summary: props => {
		const request = requestFrom(props.args, props.details);
		const status: ToolUIStatus =
			props.phase !== "settled"
				? props.phase === "running"
					? "running"
					: "pending"
				: props.outcome === "failed" || props.outcome === "timed_out"
					? "error"
					: props.outcome === "cancelled" || props.outcome === "skipped"
						? "aborted"
						: "done";
		return {
			label: `LSP ${actionLabel(request, props.details, "request")}`,
			detail: request ? formatTarget(request) : undefined,
			status,
		};
	},
};

registerToolView("lsp", lspToolView);
