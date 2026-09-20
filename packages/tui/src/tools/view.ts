/** One tool presentation per tool-call identity (Architecture Contract v1 §5). */
import type { JSX } from "../reactive";
import type { OutputDocument, OutputNotice } from "../document/types";
import type { ToolUIStatus } from "../host/elements/status";
import type { EditPreview } from "./edit";

export type CallPhase = "receiving" | "queued" | "running" | "settled";
export type CallOutcome = "success" | "failed" | "cancelled" | "timed_out" | "skipped";

export type DeepPartial<T> = T extends readonly (infer U)[]
	? readonly DeepPartial<U>[]
	: T extends object
		? { [K in keyof T]?: DeepPartial<T[K]> }
		: T;
export type DeepReadonly<T> = T extends readonly (infer U)[]
	? readonly DeepReadonly<U>[]
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;

export interface ImageBlock {
	/** Stable result-block identity for retained image ownership. */
	readonly id?: string;
	readonly data: string;
	readonly mimeType: string;
	readonly path?: string;
}

export interface ToolUiState {
	readonly expanded: boolean;
	/** Rows the transcript can give this block; 0 hides it, <3 selects the compact summary. */
	readonly allocation: number;
	readonly showImages: boolean;
	/** Wall clock frozen once the block settles/commits; undefined while live. */
	readonly frozenAt?: number;
	/** Executor-derived edit preview, normalized once before presentation. */
	readonly edit?: EditPreview;
}

export interface ToolViewProps<TArgs, TDetails> {
	readonly id: string;
	readonly toolName: string;
	readonly label: string;
	readonly args: DeepReadonly<DeepPartial<TArgs>>;
	readonly phase: CallPhase;
	/** True after the first result snapshot, including an empty partial result. */
	readonly hasResult: boolean;
	/** Latest raw provider argument prefix, when supplied by streaming ingress. */
	readonly rawArgs?: string;
	readonly outcome?: CallOutcome;
	readonly details?: DeepReadonly<TDetails>;
	readonly output: OutputDocument;
	readonly notices: readonly OutputNotice[];
	readonly images: readonly ImageBlock[];
	readonly ui: ToolUiState;
}

export type ToolView<TArgs, TDetails> = (props: ToolViewProps<TArgs, TDetails>) => JSX.Element;

/** Pure semantic summary for compact rows; no styling, no widths. */
export interface ActivitySummary {
	readonly label: string;
	readonly detail?: string;
	readonly status: ToolUIStatus;
}

export interface ToolViewDefinition<TArgs, TDetails> {
	readonly view: ToolView<TArgs, TDetails>;
	readonly summary?: (props: ToolViewProps<TArgs, TDetails>) => ActivitySummary;
	/** Bypasses transcript card, compact-summary, and result-image chrome. */
	readonly presentation?: "inline";
	/** Owns its card chrome; the transcript adds no lifecycle tint or horizontal inset. */
	readonly framed?: boolean;
	/** Disable the transcript wrapper's automatic lifecycle background. */
	readonly tint?: boolean;
}
