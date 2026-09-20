import { sanitizeText } from "@oh-my-pi/pi-utils";
import { createDocument } from "../document/document";
import { DynamicBorderView } from "../chrome/dynamic-border";
import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "../reactive";
import { formatArtifactErrorNotice, formatTruncationMetaNotice, type OutputMeta } from "../tools/output-meta";
import { replaceTabs } from "../utils";

const PREVIEW_ROWS = 20;

type StringSource = string | Accessor<string>;
type BooleanSource = boolean | Accessor<boolean>;
type ExitCodeSource = number | undefined | Accessor<number | undefined>;
type OutputMetaSource = OutputMeta | undefined | Accessor<OutputMeta | undefined>;

interface FooterLine {
	readonly text: string;
	readonly color: "dim" | "warning" | "error";
}

export interface EvalExecutionViewProps {
	readonly language: "js" | "python";
	readonly code: string;
	/**
	 * A source is accepted for the transient command entry so output chunks
	 * repaint in place; persisted transcript entries provide a final string.
	 */
	readonly output: StringSource;
	readonly exitCode?: ExitCodeSource;
	readonly cancelled: BooleanSource;
	readonly expanded: BooleanSource;
	/** Explicit while a transient command is live; persisted entries are settled. */
	readonly running?: BooleanSource;
	readonly excludeFromContext?: boolean;
	readonly meta?: OutputMetaSource;
}

function readValue(value: StringSource): string;
function readValue(value: BooleanSource): boolean;
function readValue(value: ExitCodeSource): number | undefined;
function readValue(value: OutputMetaSource): OutputMeta | undefined;
function readValue(
	value: StringSource | BooleanSource | ExitCodeSource | OutputMetaSource,
): string | boolean | number | OutputMeta | undefined {
	return typeof value === "function" ? value() : value;
}

function outputText(output: string): string {
	return replaceTabs(sanitizeText(output));
}

function footerLines(
	running: boolean,
	exitCode: number | undefined,
	cancelled: boolean,
	meta: OutputMeta | undefined,
): readonly FooterLine[] {
	if (running) return [];

	const lines: FooterLine[] = [];
	if (cancelled) lines.push({ text: "(cancelled)", color: "warning" });
	else if (exitCode !== undefined && exitCode !== 0) lines.push({ text: `(exit ${exitCode})`, color: "error" });
	if (meta?.truncation) lines.push({ text: formatTruncationMetaNotice(meta.truncation), color: "warning" });
	if (meta?.artifactError) lines.push({ text: formatArtifactErrorNotice(meta.artifactError), color: "warning" });
	return lines;
}

/** User-initiated eval transcript entry. */
export function EvalExecutionView(props: EvalExecutionViewProps): JSX.Element {
	const language = props.language === "js" ? "javascript" : "python";
	const color = props.excludeFromContext ? "dim" : "pythonMode";
	const running = () => {
		const source = props.running;
		return source === undefined ? false : readValue(source);
	};
	const output = createDocument("");
	createEffect(() => {
		output.apply({ kind: "reset", text: outputText(readValue(props.output)) });
	});
	const footer = createMemo(() =>
		footerLines(running(), readValue(props.exitCode), readValue(props.cancelled), readValue(props.meta)),
	);

	return (
		<stack>
			<DynamicBorderView color={color} />
			<box padding={{ x: 1 }}>
				<rail prefix={<span color={color}>{">>> "}</span>} rest={<span color={color}> </span>}>
					<code document={createDocument(props.code)} language={language} wrap />
				</rail>
			</box>
			<Show when={output.text().trim().length > 0}>
				<>
					<br />
					<box padding={{ x: 1 }}>
						<preview
							document={output}
							edge="tail"
							limit={readValue(props.expanded) ? Number.MAX_SAFE_INTEGER : PREVIEW_ROWS}
							unit="rows"
							ansi
							reserveSummary={false}
							summaryWrap
							color="muted"
							hiddenLabel={hidden => `… ${hidden} more lines (ctrl+o to expand)`}
						/>
					</box>
				</>
			</Show>
			<Show when={running()}>
				<>
					<br />
					<box padding={{ x: 1 }}>
						<row gap={1}>
							<spinner color={color} />
							<text color="muted">Running… (esc to cancel)</text>
						</row>
					</box>
				</>
			</Show>
			<Show when={footer().length > 0}>
				<>
					<br />
					<box padding={{ x: 1 }}>
						<stack>
							<For each={footer()}>{line => <text color={line.color}>{line.text}</text>}</For>
						</stack>
					</box>
				</>
			</Show>
			<DynamicBorderView color={color} />
		</stack>
	);
}
