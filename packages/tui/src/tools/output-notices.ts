import { isRecord } from "@oh-my-pi/pi-utils";
import type { CaptureState, OutputNotice } from "../document/types";
import {
	formatArtifactErrorNotice,
	formatFullOutputReference,
	formatGroupedDiagnosticMessages,
	formatTruncationMetaNotice,
	stripOutputNotice,
	stripRawOutputArtifactNotice,
	stripTrailingNotice,
	type OutputMeta,
} from "./output-meta";

/** Text, capture state, and presentation notices normalized at the tool-result boundary. */
export interface NormalizedOutputPresentation {
	readonly text: string;
	readonly capture: CaptureState;
	readonly notices: readonly OutputNotice[];
}

function addNotice(target: OutputNotice[], notice: OutputNotice): void {
	if (target.some(candidate => candidate.kind === notice.kind && candidate.text === notice.text)) return;
	target.push(notice);
}

function addMetaNotices(target: OutputNotice[], meta: OutputMeta | undefined): void {
	if (!meta) return;
	if (meta.truncation) {
		try {
			addNotice(target, {
				kind: "truncated",
				text: formatTruncationMetaNotice(meta.truncation, meta.source),
			});
		} catch {
			// Malformed third-party metadata must not make the transcript unreadable.
		}
	}
	if (meta.artifactError) {
		addNotice(target, { kind: "warning", text: formatArtifactErrorNotice(meta.artifactError) });
	}
	const limits = meta.limits;
	if (limits?.matchLimit) {
		addNotice(target, {
			kind: "truncated",
			text: `${limits.matchLimit.reached} matches limit reached. Use limit=${limits.matchLimit.suggestion} for more`,
		});
	}
	if (limits?.resultLimit) {
		addNotice(target, {
			kind: "truncated",
			text: `${limits.resultLimit.reached} results limit reached. Use limit=${limits.resultLimit.suggestion} for more`,
		});
	}
	if (limits?.headLimit) {
		addNotice(target, {
			kind: "truncated",
			text: `${limits.headLimit.reached} results limit reached. Use limit=${limits.headLimit.suggestion} for more`,
		});
	}
	if (limits?.columnTruncated) {
		const column = limits.columnTruncated;
		let text = `Some lines truncated to ${column.maxColumn} ${column.unit ?? "chars"}`;
		if (column.artifactId != null) text += `. ${formatFullOutputReference(column.artifactId)}`;
		addNotice(target, { kind: "truncated", text });
	}
	if (meta.diagnostics && Array.isArray(meta.diagnostics.messages)) {
		const messages = meta.diagnostics.messages.filter(message => typeof message === "string");
		if (messages.length > 0) {
			addNotice(target, {
				kind: "diagnostic",
				text: `LSP Diagnostics (${meta.diagnostics.summary}):\n${formatGroupedDiagnosticMessages(messages)}`,
			});
		}
	}
}

function stripKnownFooter(text: string, footer: string | undefined): string {
	return footer ? stripTrailingNotice(text, footer) : text;
}

function captureState(
	partial: boolean,
	details: Record<string, unknown> | undefined,
	meta: OutputMeta | undefined,
): CaptureState {
	if (partial) return "streaming";
	if (details?.capture === "truncated" || details?.truncated === true || meta?.truncation || meta?.artifactError) {
		return "truncated";
	}
	return "complete";
}

/**
 * Remove model-facing footers and derive semantic display notices once, before
 * output reaches a view. The model-facing formatter exports remain in
 * `output-meta.ts`; this module owns only display-side normalization.
 */
export function normalizeOutputPresentation(
	text: string,
	detailsValue: unknown,
	partial: boolean,
): NormalizedOutputPresentation {
	const details = isRecord(detailsValue) ? detailsValue : undefined;
	const metaValue = details?.meta;
	const meta = isRecord(metaValue) ? (metaValue as unknown as OutputMeta) : undefined;
	const notices: OutputNotice[] = [];
	addMetaNotices(notices, meta);

	const asyncDetails = isRecord(details?.async) ? details.async : undefined;
	const rawJobId = asyncDetails?.jobId;
	const jobId = typeof rawJobId === "string" && rawJobId.length > 0 ? rawJobId : undefined;
	const backgroundFooter =
		asyncDetails?.state === "running" && jobId
			? `Backgrounded as job ${jobId}; result will be delivered automatically.`
			: undefined;
	if (backgroundFooter) addNotice(notices, { kind: "background", text: `Backgrounded: ${jobId}` });

	const rawWallTimeMs = details?.wallTimeMs;
	const wallTimeMs = typeof rawWallTimeMs === "number" && Number.isFinite(rawWallTimeMs) ? rawWallTimeMs : undefined;
	const wallTimeFooter = wallTimeMs === undefined ? undefined : `Wall time: ${(wallTimeMs / 1000).toFixed(2)} seconds`;
	if (wallTimeMs !== undefined) {
		addNotice(notices, { kind: "wall-time", text: `Wall: ${(wallTimeMs / 1000).toFixed(2)}s` });
	}

	const rawExitCode = details?.exitCode;
	const exitCode = typeof rawExitCode === "number" && Number.isFinite(rawExitCode) ? rawExitCode : undefined;
	const exitFooter = exitCode === undefined ? undefined : `Command exited with code ${exitCode}`;
	if (exitCode !== undefined && exitCode !== 0) {
		addNotice(notices, { kind: "exit-code", text: `Exit: ${exitCode}` });
	}
	if (details?.timedOut === true) addNotice(notices, { kind: "warning", text: "Timed out" });
	if (details?.cancelled === true || details?.canceled === true) {
		addNotice(notices, { kind: "warning", text: "Cancelled" });
	}

	let normalizedText = stripKnownFooter(text, backgroundFooter);
	try {
		normalizedText = stripOutputNotice(normalizedText, meta);
	} catch {
		// Preserve the source text if untrusted metadata cannot be formatted.
	}
	normalizedText = stripKnownFooter(normalizedText, exitFooter);
	normalizedText = stripKnownFooter(normalizedText, wallTimeFooter);
	const rawArtifact = stripRawOutputArtifactNotice(normalizedText);
	if (rawArtifact.artifactId) {
		addNotice(notices, {
			kind: "info",
			text: `Raw output: artifact://${rawArtifact.artifactId}`,
		});
	}

	return {
		text: rawArtifact.text,
		capture: captureState(partial, details, meta),
		notices,
	};
}
