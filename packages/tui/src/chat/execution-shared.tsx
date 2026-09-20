import { createDocument } from "../document/document";
import type { JSX } from "../reactive";
import type { TruncationMeta } from "../tools/output-meta";

export type ExecutionColor = "accent" | "pythonMode" | "dim";

export interface ExecutionResultViewProps {
	readonly output: string;
	/** Interpret terminal-originated ANSI output without allowing raw host nodes. */
	readonly ansi?: boolean;
	readonly exitCode?: number;
	readonly cancelled: boolean;
	readonly expanded: boolean;
	readonly truncation?: TruncationMeta;
	readonly artifactError?: string;
}

/** Shared document-backed output and terminal-status footer for local executions. */
export function ExecutionResultView(props: ExecutionResultViewProps): JSX.Element {
	const status = props.cancelled
		? "aborted"
		: props.exitCode === 0 || props.exitCode === undefined
			? "success"
			: "error";
	const capture = props.expanded ? props.output : preview(props.output, 24);
	return (
		<stack gap={1}>
			{capture.length > 0 ? <pre document={createDocument(capture)} ansi={props.ansi} /> : null}
			{props.truncation ? <text color="warning">Output truncated</text> : null}
			{props.artifactError ? <text color="error">{props.artifactError}</text> : null}
			<row gap={1}>
				<status value={status} />
				<text color={status === "error" ? "error" : "dim"}>
					{props.cancelled
						? "Cancelled"
						: props.exitCode === undefined
							? "Completed"
							: `Exit code ${props.exitCode}`}
				</text>
			</row>
		</stack>
	);
}

function preview(output: string, limit: number): string {
	const lines = output.split("\n");
	if (lines.length <= limit) return output;
	return `${lines.slice(-limit).join("\n")}\n… ${lines.length - limit} earlier lines`;
}
