import { getLanguageFromPath } from "../lang-from-path";
import { createMemo, For, Show, type JSX, useTheme } from "../reactive";
import {
	parseDiagnosticMessage,
	sanitizeDiagnosticDisplayText,
	shortenPath,
	type ParsedDiagnostic,
} from "../render/render-utils";
import { ExpandHint } from "./expand-hint";

const COLLAPSED_DIAGNOSTIC_LIMIT = 5;

interface SeverityPresentation {
	readonly rank: number;
	readonly icon: "status.error" | "status.warning" | "status.info";
	readonly iconColor: "error" | "warning" | "muted";
	readonly messageColor: "error" | "warning" | "toolOutput";
}

const SEVERITIES: Readonly<Record<ParsedDiagnostic["severity"], SeverityPresentation>> = {
	error: { rank: 0, icon: "status.error", iconColor: "error", messageColor: "error" },
	warning: { rank: 1, icon: "status.warning", iconColor: "warning", messageColor: "warning" },
	info: { rank: 2, icon: "status.info", iconColor: "muted", messageColor: "toolOutput" },
	hint: { rank: 3, icon: "status.info", iconColor: "muted", messageColor: "toolOutput" },
};

interface DiagnosticFile {
	readonly path: string;
	readonly diagnostics: readonly ParsedDiagnostic[];
}

/** Diagnostic messages and expansion state shared by write results and late notices. */
export interface DiagnosticTreeProps {
	readonly messages: readonly string[];
	readonly expanded: boolean;
}

/** Group diagnostics by file, keeping continuation lines inside their location and tree guides. */
export function DiagnosticTree(props: DiagnosticTreeProps): JSX.Element {
	const { theme } = useTheme();
	const grouped = createMemo(() => {
		const byFile = new Map<string, ParsedDiagnostic[]>();
		const unparsed: string[] = [];
		for (const message of props.messages) {
			const diagnostic = parseDiagnosticMessage(message);
			if (diagnostic === null) {
				unparsed.push(sanitizeDiagnosticDisplayText(message));
				continue;
			}
			const diagnostics = byFile.get(diagnostic.filePath);
			if (diagnostics) diagnostics.push(diagnostic);
			else byFile.set(diagnostic.filePath, [diagnostic]);
		}
		const files: DiagnosticFile[] = [];
		for (const [path, diagnostics] of byFile) {
			diagnostics.sort((left, right) => {
				const leftSeverity = SEVERITIES[left.severity] ?? SEVERITIES.info;
				const rightSeverity = SEVERITIES[right.severity] ?? SEVERITIES.info;
				return (
					leftSeverity.rank - rightSeverity.rank ||
					left.line - right.line ||
					left.col - right.col ||
					left.message.localeCompare(right.message)
				);
			});
			files.push({ path, diagnostics });
		}
		return { files, unparsed, total: props.messages.length };
	});
	const visible = createMemo(() => {
		const all = grouped();
		if (props.expanded || all.total <= COLLAPSED_DIAGNOSTIC_LIMIT) {
			return { files: all.files, unparsed: all.unparsed, remaining: 0 };
		}
		let budget = COLLAPSED_DIAGNOSTIC_LIMIT;
		const files: DiagnosticFile[] = [];
		for (const file of all.files) {
			if (budget === 0) break;
			const diagnostics = file.diagnostics.length <= budget ? file.diagnostics : file.diagnostics.slice(0, budget);
			files.push(diagnostics === file.diagnostics ? file : { path: file.path, diagnostics });
			budget -= diagnostics.length;
		}
		const unparsed = all.unparsed.length <= budget ? all.unparsed : all.unparsed.slice(0, budget);
		const shown = files.reduce((count, file) => count + file.diagnostics.length, 0) + unparsed.length;
		return { files, unparsed, remaining: all.total - shown };
	});

	return (
		<tree>
			<For each={visible().files}>
				{file => (
					<stack>
						<row gap={1}>
							<text color="muted" wrap="none" shrink={0}>
								{theme().getLangIcon(getLanguageFromPath(file.path))}
							</text>
							<text color="accent" grow={1} minWidth={1} wrap="none" overflow="middle">
								{shortenPath(file.path)}
							</text>
						</row>
						<tree>
							<For each={file.diagnostics}>
								{diagnostic => {
									const severity = SEVERITIES[diagnostic.severity] ?? SEVERITIES.info;
									const lines = diagnostic.message.split("\n");
									return (
										<row gap={1}>
											<text wrap="none" shrink={0}>
												<icon name={severity.icon} color={severity.iconColor} />
												<span color="dim">{` :${diagnostic.line}:${diagnostic.col}`}</span>
											</text>
											<stack grow={1} minWidth={1}>
												<For each={lines}>
													{(line, index) => {
														const text = line.trimStart();
														return (
															<box padding={{ left: line.length - text.length }}>
																<text color={severity.messageColor}>
																	{text || " "}
																	<Show when={index() === lines.length - 1 && diagnostic.code}>
																		<span color="dim">{` (${diagnostic.code})`}</span>
																	</Show>
																</text>
															</box>
														);
													}}
												</For>
											</stack>
										</row>
									);
								}}
							</For>
						</tree>
					</stack>
				)}
			</For>
			<For each={visible().unparsed}>
				{message => (
					<text color={message.includes("[error]") ? "error" : message.includes("[warning]") ? "warning" : "dim"}>
						{message}
					</text>
				)}
			</For>
			<Show when={visible().remaining > 0}>
				<row gap={1}>
					<text color="muted">{`… ${visible().remaining} more`}</text>
					<ExpandHint expanded={props.expanded} />
				</row>
			</Show>
		</tree>
	);
}
