import { untrack } from "solid-js";
import { createDocument } from "./document";
import type { TextDocument } from "./types";

/** Snapshot-to-change adapter that emits exactly one append or replacement per changed snapshot. */
export interface SnapshotDocument {
	readonly doc: TextDocument;
	push(snapshot: string): void;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function commonPrefixLength(previous: string, next: string): number {
	const limit = Math.min(previous.length, next.length);
	let length = 0;
	while (length < limit && previous.charCodeAt(length) === next.charCodeAt(length)) length++;
	if (
		length > 0 &&
		length < previous.length &&
		length < next.length &&
		isHighSurrogate(previous.charCodeAt(length - 1)) &&
		isLowSurrogate(previous.charCodeAt(length))
	) {
		length--;
	}
	return length;
}

function commonSuffixLength(previous: string, next: string, prefix: number): number {
	const limit = Math.min(previous.length - prefix, next.length - prefix);
	let length = 0;
	while (
		length < limit &&
		previous.charCodeAt(previous.length - length - 1) === next.charCodeAt(next.length - length - 1)
	) {
		length++;
	}
	const previousStart = previous.length - length;
	const nextStart = next.length - length;
	if (
		length > 0 &&
		previousStart > prefix &&
		nextStart > prefix &&
		isHighSurrogate(previous.charCodeAt(previousStart - 1)) &&
		isLowSurrogate(previous.charCodeAt(previousStart))
	) {
		length--;
	}
	return length;
}

/** Adapt successive complete strings into minimal single document changes. */
export function documentFromSnapshots(initial = ""): SnapshotDocument {
	const doc = createDocument(initial);
	return {
		doc,
		push(snapshot) {
			const previous = untrack(doc.text);
			if (snapshot === previous) return;
			if (snapshot.startsWith(previous)) {
				doc.apply({ kind: "append", text: snapshot.slice(previous.length) });
				return;
			}
			const prefix = commonPrefixLength(previous, snapshot);
			const suffix = commonSuffixLength(previous, snapshot, prefix);
			doc.apply({
				kind: "replace",
				start: prefix,
				end: previous.length - suffix,
				text: snapshot.slice(prefix, snapshot.length - suffix),
			});
		},
	};
}
