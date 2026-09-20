/** Milliseconds between terminal spinner frames. */
const SPINNER_MS = 80;

/** Return a finite, integral caller-controlled spinner frame, if supplied. */
export function controlledSpinnerFrame(frame: number | undefined): number | undefined {
	return frame !== undefined && Number.isFinite(frame) ? Math.trunc(frame) : undefined;
}

/** Select a themed spinner frame from either a controlled index or the paint clock. */
export function selectSpinnerFrame(frames: readonly string[], frame: number | undefined, now: number): string {
	if (frames.length === 0) return "";
	const index = controlledSpinnerFrame(frame) ?? Math.floor(now / SPINNER_MS);
	return frames[((index % frames.length) + frames.length) % frames.length] ?? "";
}
