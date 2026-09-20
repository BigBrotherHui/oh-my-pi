import { isRecord, parseStreamingJson } from "@oh-my-pi/pi-utils";
import { batch, createStore, reconcile } from "../reactive";
import { createOutputDocument } from "../document/document";
import { documentFromSnapshots } from "../document/snapshots";
import type { OutputNotice } from "../document/types";
import type { CallOutcome, CallPhase, DeepPartial, DeepReadonly, ImageBlock, ToolUiState, ToolViewProps } from "./view";
import { normalizeOutputPresentation } from "./output-notices";
import type { EditPreview } from "./edit";

/** Runtime result shapes accepted at the presentation ingress boundary. */
export type ToolResultPayload = unknown;

/** Options controlling whether a result is a streaming snapshot or terminal result. */
export interface ApplyToolResultOptions {
	readonly partial?: boolean;
}

/** Explicitly replace decoded arguments when execution hooks supply an authoritative snapshot. */
export interface ApplyToolArgsOptions {
	readonly snapshot?: boolean;
}

/** Reactive presentation state for one tool-call identity. */
export interface ToolCallModel<
	TArgs extends object = Record<string, unknown>,
	TDetails = unknown,
> extends ToolViewProps<TArgs, TDetails> {
	/** Apply a cumulative raw JSON snapshot or merge decoded argument fields; explicit snapshots drop omitted fields. */
	applyArgsChunk(chunk: string | DeepPartial<TArgs>, options?: ApplyToolArgsOptions): void;
	/** Advance a receiving call to the execution queue. */
	markQueued(): void;
	/** Advance a receiving or queued call to active execution. */
	markRunning(): void;
	/** Normalize and reconcile one streaming or terminal tool-result snapshot. */
	applyResult(result: ToolResultPayload, options?: ApplyToolResultOptions): void;
	/** Patch transcript-owned presentation state without replacing its reactive object. */
	setUi(patch: Partial<ToolUiState>): void;
	/** Freeze time-dependent presentation at the first supplied wall-clock instant. */
	freeze(at: number): void;
}

/** Construction fields that establish a tool-call's permanent identity. */
export interface CreateToolCallModelOptions {
	readonly id: string;
	readonly toolName: string;
	readonly label: string;
}

interface ModelState<TDetails> {
	phase: CallPhase;
	hasResult: boolean;
	rawArgs?: string;
	outcome?: CallOutcome;
	details?: TDetails;
	notices: OutputNotice[];
	images: IdentifiedImageBlock[];
	ui: MutableToolUiState;
}

interface MutableToolUiState {
	expanded: boolean;
	allocation: number;
	showImages: boolean;
	frozenAt?: number;
	edit?: EditPreview;
}

interface IdentifiedImageBlock extends ImageBlock {
	readonly id: string;
}

interface NormalizedResult<TDetails> {
	readonly text: string;
	readonly details: TDetails | undefined;
	readonly hasDetails: boolean;
	readonly images: IdentifiedImageBlock[];
	readonly isError: boolean;
	readonly status: string | undefined;
}

function canonicalContent(value: unknown, seen: Set<object>): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "undefined") return "undefined";
	if (typeof value === "symbol") return value.description ?? "symbol";
	if (typeof value === "function") return `[function:${value.name}]`;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	let encoded: string;
	if (Array.isArray(value)) {
		encoded = `[${value.map(item => canonicalContent(item, seen)).join(",")}]`;
	} else {
		const record = value as Record<string, unknown>;
		encoded = `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalContent(record[key], seen)}`)
			.join(",")}}`;
	}
	seen.delete(value);
	return encoded;
}

/**
 * Derive a replay-stable identity for historical child entities that predate
 * explicit ids. The hash input is exactly `(toolName, index, content)`; labels
 * are deliberately excluded because duplicate labels are valid call state.
 */
export function stableToolEntityId(toolName: string, index: number, content: unknown): string {
	const input = `${toolName}\u0000${index}\u0000${canonicalContent(content, new Set())}`;
	let hash = 0x811c9dc5;
	for (let offset = 0; offset < input.length; offset++) {
		hash ^= input.charCodeAt(offset);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${toolName}:${index}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function unwrapHistoricalPayload(value: unknown): Record<string, unknown> {
	let current = isRecord(value) ? value : { content: value };
	for (let depth = 0; depth < 3; depth++) {
		if ("content" in current || "output" in current) break;
		const message = current.message;
		if (isRecord(message) && (message.role === "toolResult" || message.type === "tool_result")) {
			current = message;
			continue;
		}
		const result = current.result;
		if (isRecord(result)) {
			current = result;
			continue;
		}
		break;
	}
	return current;
}

function effectiveDetails(value: unknown): unknown {
	if (!isRecord(value) || !isRecord(value.xdev) || !Object.hasOwn(value.xdev, "inner")) return value;
	return value.xdev.inner;
}

function mergeLegacyDetails(source: Record<string, unknown>): { details: unknown; hasDetails: boolean } {
	const explicit = source.details;
	const hasExplicit = "details" in source;
	const legacyFields = ["exitCode", "timedOut", "cancelled", "canceled", "meta", "async", "wallTimeMs"] as const;
	const hasLegacy = legacyFields.some(key => key in source);
	if (!hasLegacy) return { details: effectiveDetails(explicit), hasDetails: hasExplicit };
	const details: Record<string, unknown> = isRecord(explicit) ? { ...explicit } : {};
	for (const key of legacyFields) {
		if (!(key in details) && key in source) details[key] = source[key];
	}
	return { details: effectiveDetails(details), hasDetails: true };
}

function mergePartialValue<T>(current: T, patch: T): T;
function mergePartialValue(current: unknown, patch: unknown): unknown {
	if (!isRecord(current) || !isRecord(patch)) return patch;
	const merged: Record<string, unknown> = { ...current };
	for (const key in patch) {
		if (!Object.hasOwn(patch, key) || key === "__proto__" || key === "constructor" || key === "prototype") continue;
		merged[key] = mergePartialValue(current[key], patch[key]);
	}
	return merged;
}

function contentBlocks(source: Record<string, unknown>): unknown[] {
	if (Array.isArray(source.content)) return source.content;
	if (typeof source.content === "string") return [{ type: "text", text: source.content }];
	if (typeof source.output === "string") return [{ type: "text", text: source.output }];
	if (typeof source.error === "string") return [{ type: "text", text: source.error }];
	return [];
}

function imageFrom(value: unknown, toolName: string, index: number): IdentifiedImageBlock | undefined {
	if (!isRecord(value) || value.type !== "image") return undefined;
	const data = typeof value.data === "string" ? value.data : undefined;
	const mimeType =
		typeof value.mimeType === "string"
			? value.mimeType
			: typeof value.mime_type === "string"
				? value.mime_type
				: typeof value.media_type === "string"
					? value.media_type
					: undefined;
	if (!data || !mimeType) return undefined;
	const path = typeof value.path === "string" ? value.path : undefined;
	return {
		id: stableToolEntityId(toolName, index, { type: "image", data, mimeType, path }),
		data,
		mimeType,
		...(path ? { path } : {}),
	};
}

function normalizeResult<TDetails>(value: ToolResultPayload, toolName: string): NormalizedResult<TDetails> {
	const source = unwrapHistoricalPayload(value);
	const blocks = contentBlocks(source);
	const text: string[] = [];
	const images: IdentifiedImageBlock[] = [];
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (typeof block === "string") {
			text.push(block);
			continue;
		}
		if (!isRecord(block)) continue;
		if ((block.type === "text" || block.type === "output_text") && typeof block.text === "string") {
			text.push(block.text);
			continue;
		}
		const image = imageFrom(block, toolName, index);
		if (image) images.push(image);
	}

	const merged = mergeLegacyDetails(source);
	if (isRecord(merged.details) && Array.isArray(merged.details.images)) {
		for (let index = 0; index < merged.details.images.length; index++) {
			const image = imageFrom(merged.details.images[index], toolName, blocks.length + index);
			if (image && !images.some(existing => existing.id === image.id)) images.push(image);
		}
	}
	const status = typeof source.status === "string" ? source.status : undefined;
	const isError =
		source.isError === true ||
		source.is_error === true ||
		source.error === true ||
		typeof source.error === "string" ||
		isRecord(source.error) ||
		status === "error" ||
		status === "failed";
	return {
		text: text.join("\n"),
		details: merged.details as TDetails | undefined,
		hasDetails: merged.hasDetails,
		images,
		isError,
		status,
	};
}

function sameNotices(previous: readonly OutputNotice[], next: readonly OutputNotice[]): boolean {
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length; index++) {
		const left = previous[index];
		const right = next[index];
		if (left?.kind !== right?.kind || left?.text !== right?.text) return false;
	}
	return true;
}

function outcomeFor(result: NormalizedResult<unknown>, detailsValue: unknown): CallOutcome {
	const details = isRecord(detailsValue) ? detailsValue : undefined;
	const interruptSkipped =
		details?.source === "interrupt_skipped" && (details.__synthetic === true || details.__interrupted === true);
	if (interruptSkipped || result.status === "skipped") return "skipped";
	if (details?.timedOut === true || result.status === "timed_out" || result.status === "timeout") return "timed_out";
	if (
		details?.cancelled === true ||
		details?.canceled === true ||
		result.status === "cancelled" ||
		result.status === "canceled" ||
		result.status === "aborted"
	) {
		return "cancelled";
	}
	const exitCode = details?.exitCode;
	if (
		result.isError ||
		details?.isError === true ||
		(typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0)
	) {
		return "failed";
	}
	return "success";
}

/** Create the reactive presentation model for one tool-call id. */
export function createToolCallModel<TArgs extends object = Record<string, unknown>, TDetails = unknown>(
	options: CreateToolCallModelOptions,
): ToolCallModel<TArgs, TDetails> {
	const [args, setArgs] = createStore<DeepPartial<TArgs>>({} as DeepPartial<TArgs>);
	const output = createOutputDocument();
	const snapshots = documentFromSnapshots();
	snapshots.doc.subscribe(change => output.apply(change));
	const [state, setState] = createStore<ModelState<TDetails>>({
		phase: "receiving",
		hasResult: false,
		notices: [],
		images: [],
		ui: { expanded: false, allocation: 0, showImages: true },
	});

	const model: ToolCallModel<TArgs, TDetails> = {
		id: options.id,
		toolName: options.toolName,
		label: options.label,
		args: args as DeepReadonly<DeepPartial<TArgs>>,
		get phase() {
			return state.phase;
		},
		get hasResult() {
			return state.hasResult;
		},
		get rawArgs() {
			return state.rawArgs;
		},
		get outcome() {
			return state.outcome;
		},
		get details() {
			return state.details as DeepReadonly<TDetails> | undefined;
		},
		output,
		get notices() {
			return state.notices;
		},
		get images() {
			return state.images;
		},
		get ui() {
			return state.ui;
		},
		applyArgsChunk(chunk, argOptions = {}) {
			if (state.phase === "settled") return;
			batch(() => {
				if (typeof chunk === "string") setState("rawArgs", chunk);
				const next = typeof chunk === "string" ? parseStreamingJson<DeepPartial<TArgs>>(chunk) : chunk;
				if (typeof next !== "object" || next === null) return;
				const snapshot =
					typeof chunk === "string" || argOptions.snapshot === true
						? next
						: mergePartialValue<DeepPartial<TArgs>>(args, next);
				setArgs(reconcile(snapshot));
			});
		},
		markQueued() {
			if (state.phase === "receiving") setState("phase", "queued");
		},
		markRunning() {
			if (state.phase === "receiving" || state.phase === "queued") setState("phase", "running");
		},
		applyResult(value, resultOptions = {}) {
			if (state.phase === "settled") return;
			const normalized = normalizeResult<TDetails>(value, options.toolName);
			const details = normalized.hasDetails
				? resultOptions.partial
					? mergePartialValue(state.details, normalized.details)
					: normalized.details
				: state.details;
			const partial =
				resultOptions.partial === true ||
				(isRecord(details) && isRecord(details.async) && details.async.state === "running");
			const presentation = normalizeOutputPresentation(normalized.text, details, partial);
			batch(() => {
				setState("hasResult", true);
				snapshots.push(presentation.text);
				output.setCapture(presentation.capture);
				const noticesChanged = !sameNotices(state.notices, presentation.notices);
				if (noticesChanged) output.setNotices(presentation.notices);
				if (normalized.hasDetails) setState("details", reconcile(details as TDetails));
				setState("images", reconcile(normalized.images));
				if (noticesChanged) setState("notices", reconcile([...presentation.notices]));
				if (partial) {
					if (state.phase === "receiving" || state.phase === "queued") setState("phase", "running");
					setState("outcome", undefined);
				} else {
					setState("outcome", outcomeFor(normalized as NormalizedResult<unknown>, details));
					setState("phase", "settled");
				}
			});
		},
		setUi(patch) {
			batch(() => {
				if (patch.expanded !== undefined) setState("ui", "expanded", patch.expanded);
				if (patch.allocation !== undefined) setState("ui", "allocation", patch.allocation);
				if (patch.showImages !== undefined) setState("ui", "showImages", patch.showImages);
				if ("frozenAt" in patch) setState("ui", "frozenAt", patch.frozenAt);
				if ("edit" in patch) setState("ui", "edit", reconcile(patch.edit));
			});
		},
		freeze(at) {
			if (state.ui.frozenAt !== undefined) return;
			setState("ui", "frozenAt", at);
		},
	};
	return model;
}
