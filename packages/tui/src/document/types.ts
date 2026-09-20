/** Text document contract (Architecture Contract v1 §3). Offsets are UTF-16 code units into the full text. */
import type { Accessor } from "../reactive";

export type DocumentChange =
	| { readonly kind: "append"; readonly text: string }
	| { readonly kind: "replace"; readonly start: number; readonly end: number; readonly text: string }
	| { readonly kind: "reset"; readonly text: string };

export interface TextDocument {
	/** Monotonic version; reactive read. */
	readonly version: Accessor<number>;
	text(): string;
	lineCount(): number;
	line(index: number): string;
	/** Offset of the first code unit of `line(index)`. */
	lineStart(index: number): number;
	apply(change: DocumentChange): void;
	subscribe(listener: (change: DocumentChange, version: number) => void): () => void;
}

export type CaptureState = "streaming" | "complete" | "truncated";

/** A tool-output notice normalized at ingestion (model-facing text is separate). */
export interface OutputNotice {
	readonly kind: "truncated" | "background" | "wall-time" | "exit-code" | "diagnostic" | "info" | "warning";
	readonly text: string;
}

export interface OutputDocument extends TextDocument {
	readonly capture: Accessor<CaptureState>;
	readonly notices: Accessor<readonly OutputNotice[]>;
}
