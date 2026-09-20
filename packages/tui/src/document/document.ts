import { createSignal } from "solid-js";
import type { CaptureState, DocumentChange, OutputDocument, OutputNotice, TextDocument } from "./types";
import { IncrementalLineIndex } from "./line-index";

/** Mutable ingestion surface returned by {@link createOutputDocument}. */
export interface MutableOutputDocument extends OutputDocument {
	/** Update the output capture lifecycle. */
	setCapture(capture: CaptureState): void;
	/** Replace the normalized output notices. */
	setNotices(notices: readonly OutputNotice[]): void;
}

function validateReplace(change: Extract<DocumentChange, { kind: "replace" }>, length: number): void {
	if (
		!Number.isInteger(change.start) ||
		!Number.isInteger(change.end) ||
		change.start < 0 ||
		change.end < change.start ||
		change.end > length
	) {
		throw new RangeError(`Invalid document replacement [${change.start}, ${change.end}) for length ${length}`);
	}
}

/** Create a reactive text document with an incremental UTF-16 line index. */
export function createDocument(initial = ""): TextDocument {
	let content = initial;
	const index = new IncrementalLineIndex(content);
	const [version, setVersion] = createSignal(0);
	let revision = 0;
	const listeners = new Set<(change: DocumentChange, version: number) => void>();

	const apply = (change: DocumentChange): void => {
		if (change.kind === "append") {
			if (change.text.length === 0) return;
			const previousLength = content.length;
			content += change.text;
			index.append(previousLength, change.text);
		} else if (change.kind === "replace") {
			validateReplace(change, content.length);
			if (change.start === change.end && change.text.length === 0) return;
			const previous = content;
			const next = previous.slice(0, change.start) + change.text + previous.slice(change.end);
			if (next === previous) return;
			content = next;
			index.replace(previous, next, change.start);
		} else {
			if (change.text === content) return;
			content = change.text;
			index.reset(content);
		}

		const nextVersion = ++revision;
		setVersion(nextVersion);
		for (const listener of listeners) listener(change, nextVersion);
	};

	return {
		version,
		text() {
			version();
			return content;
		},
		lineCount() {
			version();
			return index.lineCount;
		},
		line(line) {
			version();
			return index.line(content, line);
		},
		lineStart(line) {
			version();
			return index.lineStart(line);
		},
		apply,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/** Create a text document with reactive capture state and normalized notices. */
export function createOutputDocument(initial = ""): MutableOutputDocument {
	const document = createDocument(initial);
	const [capture, setCapture] = createSignal<CaptureState>("streaming");
	const [notices, setNoticeSignal] = createSignal<readonly OutputNotice[]>([]);
	return {
		...document,
		capture,
		notices,
		setCapture,
		setNotices(next) {
			setNoticeSignal(next.slice());
		},
	};
}
