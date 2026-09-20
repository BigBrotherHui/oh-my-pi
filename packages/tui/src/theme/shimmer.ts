/**
 * Shimmer sweeps: a band of brighter colour travelling across text (the
 * loader's working message, live hub heads, progress bars). Paints runs with
 * one {@link Style} per run of same-tier code points; no per-character output.
 */
import type { Out } from "../core/richtext";
import { Attr, type Color, Style } from "../core/style";
import type { Theme, ThemeColor } from "./theme";

// ─── Animation velocity ──────────────────────────────────────────────────────
// Band/head travel speed in border cells per second. Driving position by a fixed
// velocity — instead of dividing a fixed sweep duration by the (length-derived)
// period — makes smoothness independent of message length: at the loader's
// default 30fps redraw cadence the band advances ≤1 cell per frame for any
// string, so it never visibly steps. Sweep/round-trip durations now scale with
// length. Keep ≤ the animated redraw fps (loader RENDER_INTERVAL_MS = 1000/30).
const SHIMMER_SPEED_CELLS_PER_S = 30;

// ─── Classic sweep tunables ──────────────────────────────────────────────────
const CLASSIC_PADDING = 10;
const CLASSIC_BAND_HALF_WIDTH = 6;

// ─── KITT scanner tunables ───────────────────────────────────────────────────
const KITT_HEAD_HALF = 0.6;
const KITT_TRAIL_LEN = 7;

// ─── Tier thresholds ─────────────────────────────────────────────────────────
const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

/** The theme surface the shimmer needs: packed foreground colours. */
export type ShimmerTheme = Pick<Theme, "fgColor">;
/** Sweep style for animated shimmer text; `disabled` renders every tier as the mid color. */
export type ShimmerMode = "classic" | "kitt" | "disabled";

let activeMode: ShimmerMode = "classic";

/** Select the shimmer sweep style. The host pushes its `display.shimmer` preference here. */
export function setShimmerMode(mode: ShimmerMode): void {
	activeMode = mode;
}

/** A tier colour: a theme token or a packed colour. */
export type ShimmerPaletteTier = ThemeColor | Color;

function resolveTier(theme: ShimmerTheme, tier: ShimmerPaletteTier): Color {
	return typeof tier === "string" ? theme.fgColor(tier) : tier;
}

/** Three-tier color stack a shimmer character cycles through as the band sweeps. */
export interface ShimmerPalette {
	/** Color for chars outside / at the edge of the band (intensity < ~0.22). */
	low: ShimmerPaletteTier;
	/** Color for chars approaching the crest (~0.22 ≤ intensity < ~0.65). */
	mid: ShimmerPaletteTier;
	/** Color at the band's crest (intensity ≥ ~0.65). */
	high: ShimmerPaletteTier;
	/** Whether to bold the crest tier. Default `false`. */
	bold?: boolean;
}

/** One run of text that shares a palette inside a larger shimmer sweep. */
export interface ShimmerSegment {
	text: string;
	palette?: ShimmerPalette;
}

export const DEFAULT_SHIMMER_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "accent",
	bold: true,
};

// ─── Palette compilation cache ───────────────────────────────────────────────
// Resolving styles for every character was the dominant per-frame cost. We
// resolve once per (theme, palette) pair into three interned styles, then
// coalesce same-tier runs at paint time. The cache is stashed as a
// Symbol-keyed slot directly on the palette object and invalidates when the
// active Theme changes.
interface CompiledPalette {
	low: Style;
	mid: Style;
	high: Style;
}

const kCompiledFor = Symbol("shimmer.compiledFor");
const kCompiled = Symbol("shimmer.compiled");
interface PaletteCache {
	[kCompiledFor]?: ShimmerTheme;
	[kCompiled]?: CompiledPalette;
}

function compile(theme: ShimmerTheme, palette: ShimmerPalette): CompiledPalette {
	const p = palette as ShimmerPalette & PaletteCache;
	const cached = p[kCompiled];
	if (cached && p[kCompiledFor] === theme) return cached;
	const high = Style.of({ fg: resolveTier(theme, palette.high), attrs: palette.bold ? Attr.Bold : Attr.None });
	const out: CompiledPalette = {
		low: Style.of({ fg: resolveTier(theme, palette.low) }),
		mid: Style.of({ fg: resolveTier(theme, palette.mid) }),
		high,
	};
	p[kCompiledFor] = theme;
	p[kCompiled] = out;
	return out;
}

// ─── Intensity profiles ──────────────────────────────────────────────────────
/** Smooth cosine bump sweeping left → right with edge padding. */
function classicIntensity(time: number, index: number, length: number): number {
	const period = length + CLASSIC_PADDING * 2;
	const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
	const dist = Math.abs(index + CLASSIC_PADDING - pos);
	if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

/**
 * Knight Rider K.I.T.T. scanner: a single bright head ping-pongs across the
 * bar with a quadratic-decay trail behind it. No leading glow — LEDs don't
 * predict the future.
 */
function kittIntensity(time: number, index: number, length: number): number {
	const range = length - 1;
	if (range <= 0) return 1;
	const cycleCells = 2 * range;
	const sweep = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;
	const delta = index - head;
	const abs = delta < 0 ? -delta : delta;
	if (abs <= KITT_HEAD_HALF) return 1;
	const behind = goingRight ? -delta : delta;
	if (behind <= KITT_HEAD_HALF) return 0;
	const t = (behind - KITT_HEAD_HALF) / KITT_TRAIL_LEN;
	if (t >= 1) return 0;
	const f = 1 - t;
	return f * f;
}

type Tier = "low" | "mid" | "high";

function tierFor(intensity: number): Tier {
	if (intensity >= TIER_HIGH) return "high";
	if (intensity >= TIER_MID) return "mid";
	return "low";
}

/** Whether shimmer animations are active (any mode other than `disabled`). */
export function shimmerEnabled(): boolean {
	return activeMode !== "disabled";
}

/**
 * Sweep window (code-point indices) outside which the intensity is guaranteed
 * zero for `mode` at `time` over `total` cells.
 */
function activeBand(mode: "classic" | "kitt", time: number, total: number): { lo: number; hi: number } {
	if (mode === "classic") {
		const period = total + CLASSIC_PADDING * 2;
		const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
		return {
			lo: pos - CLASSIC_PADDING - CLASSIC_BAND_HALF_WIDTH,
			hi: pos - CLASSIC_PADDING + CLASSIC_BAND_HALF_WIDTH,
		};
	}
	const range = total - 1;
	if (range <= 0) return { lo: 0, hi: total };
	const cycleCells = 2 * range;
	const sweep = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;
	return goingRight
		? { lo: head - KITT_HEAD_HALF - KITT_TRAIL_LEN, hi: head + KITT_HEAD_HALF }
		: { lo: head - KITT_HEAD_HALF, hi: head + KITT_HEAD_HALF + KITT_TRAIL_LEN };
}

function countCodePoints(text: string): number {
	let n = 0;
	let i = 0;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			const c2 = text.charCodeAt(i + 1);
			if (c2 >= 0xdc00 && c2 <= 0xdfff) {
				i += 2;
				n++;
				continue;
			}
		}
		i++;
		n++;
	}
	return n;
}

/**
 * Paint a shimmer sweep across one or more segments into `out`, treating them
 * as a single continuous string for band positioning. Each segment can
 * supply its own palette so the gradient stays in lockstep while the colors
 * differ. One run per stretch of same-tier code points; no per-char work
 * outside the active band.
 */
export function paintShimmerSegments(
	out: Out,
	segments: readonly ShimmerSegment[],
	theme: ShimmerTheme,
	now: number = Date.now(),
): void {
	const mode = activeMode;
	let total = 0;
	const perSeg: { text: string; palette: ShimmerPalette }[] = [];
	for (const seg of segments) {
		total += countCodePoints(seg.text);
		perSeg.push({ text: seg.text, palette: seg.palette ?? DEFAULT_SHIMMER_PALETTE });
	}
	if (total === 0) return;

	// Disabled: no animation, no per-char work. Paint each segment in its mid
	// tier so the working line stays legible without movement.
	if (mode === "disabled") {
		for (const { text, palette } of perSeg) out.push(compile(theme, palette).mid, text);
		return;
	}

	const time = now;
	const intensityFn = mode === "kitt" ? kittIntensity : classicIntensity;
	const { lo: bandLo, hi: bandHi } = activeBand(mode, time, total);

	let index = 0;
	for (const { text, palette } of perSeg) {
		const compiled = compile(theme, palette);
		let runTier: Tier | null = null;
		let runStart = 0;
		let runEnd = 0;
		let i = 0;
		while (i < text.length) {
			const c = text.charCodeAt(i);
			let step = 1;
			if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
				const c2 = text.charCodeAt(i + 1);
				if (c2 >= 0xdc00 && c2 <= 0xdfff) step = 2;
			}
			const tier: Tier = index < bandLo || index > bandHi ? "low" : tierFor(intensityFn(time, index, total));
			if (tier !== runTier) {
				if (runTier !== null && runEnd > runStart) out.push(compiled[runTier], text.slice(runStart, runEnd));
				runTier = tier;
				runStart = i;
			}
			runEnd = i + step;
			index++;
			i += step;
		}
		if (runTier !== null && runEnd > runStart) out.push(compiled[runTier], text.slice(runStart, runEnd));
	}
}

/** Paint one shimmered string with an optional palette. */
export function paintShimmerText(
	out: Out,
	text: string,
	theme: ShimmerTheme,
	palette?: ShimmerPalette,
	now: number = Date.now(),
): void {
	paintShimmerSegments(out, [{ text, palette }], theme, now);
}
