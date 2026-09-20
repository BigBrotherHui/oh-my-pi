import { describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai/types";
import { CacheInvalidationMarkerView, detectCacheInvalidation } from "@oh-my-pi/pi-tui/chat/cache-invalidation-marker";
import { mountForTest } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";

function usage(parts: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }): Usage {
	const input = parts.input ?? 0;
	const output = parts.output ?? 0;
	const cacheRead = parts.cacheRead ?? 0;
	const cacheWrite = parts.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("detectCacheInvalidation", () => {
	it("does not flag the first turn (no prior cache footprint)", () => {
		expect(detectCacheInvalidation(undefined, usage({ cacheWrite: 50_000, input: 2 }))).toBeUndefined();
	});

	it("flags a cacheRead collapse after a warm turn and reports reprocessed tokens", () => {
		// Mirrors the observed session: warm turn reads ~50k, next request reads
		// nothing and re-creates the whole prefix.
		const prev = usage({ cacheRead: 49_837, cacheWrite: 980, output: 79 });
		const current = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99, output: 99 });
		expect(detectCacheInvalidation(prev, current)).toEqual({ reprocessedTokens: 50_999 });
	});

	it("does not flag a cold turn whose predecessor only wrote the cache (never read it)", () => {
		// The session's opening request writes the prefix (cacheRead 0); a long
		// first tool call then outlives the provider's cache TTL, so the follow-up
		// re-writes cold. The cache was never proven live, so this is expected
		// warming/expiry — not a user-caused invalidation worth a marker right
		// under the opening message.
		const prev = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99 });
		const current = usage({ cacheRead: 0, cacheWrite: 51_113, input: 16 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("does not flag a turn that reused any cache", () => {
		const prev = usage({ cacheRead: 50_900, cacheWrite: 980 });
		const current = usage({ cacheRead: 50_900, cacheWrite: 3_459, input: 2 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("does not flag implicit best-effort caches that report no cacheWrite", () => {
		// Gemini/antigravity and Fireworks/glm report `cacheWrite: 0` and drop
		// `cacheRead` to zero intermittently while the prefix is unchanged — a
		// provider propagation race that self-heals next turn, not an invalidation.
		// Mirrors the observed gemini-3.5-flash turn (warm 40.8k read, then a cold
		// 43.1k reprocess with zero cacheWrite).
		const prev = usage({ cacheRead: 40_789, input: 1_069, output: 353 });
		const current = usage({ cacheRead: 0, cacheWrite: 0, input: 43_102, output: 58 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("ignores collapses when the prior footprint was below the cacheable floor", () => {
		// No meaningful cache existed to invalidate (e.g. provider without prompt
		// caching, or a tiny early context).
		const prev = usage({ input: 500 });
		expect(detectCacheInvalidation(prev, usage({ input: 600 }))).toBeUndefined();
	});

	it("ignores a cold turn that reprocessed only a trivial prompt", () => {
		const prev = usage({ cacheRead: 40_000, cacheWrite: 1_000 });
		expect(detectCacheInvalidation(prev, usage({ cacheRead: 0, input: 12 }))).toBeUndefined();
	});
});

function renderMarker(width: number): readonly string[] {
	const root = mountForTest(() => CacheInvalidationMarkerView({ info: { reprocessedTokens: 50_999 } }), {
		width,
		theme: loadThemeSync("dark"),
	});
	try {
		return root.text();
	} finally {
		root.dispose();
	}
}

describe("CacheInvalidationMarkerView", () => {
	it("restores the padded, icon-bearing partial divider at wide and narrow widths", () => {
		const label = "⊘ cache miss · 51K tokens";
		expect(renderMarker(80)).toEqual(["", `────────── ${label}`, ""]);
		// Too narrow to frame: the historic marker preserved its whole bare label.
		expect(renderMarker(10)).toEqual(["", label, ""]);
	});
});
