import { classifyJsonPrefix, isRecord, parseStreamingJson } from "@oh-my-pi/pi-utils";

/**
 * Decode one cumulative tool-argument JSON snapshot while its provider stream
 * is still open. A non-object value or a malformed final snapshot cannot
 * describe tool arguments.
 */
export function decodeStreamingToolArgs(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string" || classifyJsonPrefix(raw) === "invalid") return {};
	const decoded: unknown = parseStreamingJson(raw);
	return isRecord(decoded) ? decoded : {};
}
