/** Run-native colour helpers for the git TUI, derived from the active theme. */
import { colorLuma, hexToRgb, rgbToHex } from "@oh-my-pi/pi-utils/color";
import { useTheme } from "../../theme/reactive";
import { type Color, parseColor, Style } from "../../core/style";
import type { JSX } from "../../reactive";

/** One plain-text run with an explicit terminal style. */
export interface StyledRun {
	readonly style: Style;
	readonly text: string;
}

/** Decode a hex color into RGB channels. */
export function hexChannels(hex: string): [number, number, number] {
	const { r, g, b } = hexToRgb(hex);
	return [r, g, b];
}

/** Linear blend of two hex colors (`t` = 0 → `a`, 1 → `b`). */
export function mixHex(a: string, b: string, t: number): string {
	const ca = hexToRgb(a);
	const cb = hexToRgb(b);
	return rgbToHex({
		r: ca.r + (cb.r - ca.r) * t,
		g: ca.g + (cb.g - ca.g) * t,
		b: ca.b + (cb.b - ca.b) * t,
	});
}

/** Packed truecolor value for the run pipeline. */
export function colorHex(hex: string): Color {
	return parseColor(hex);
}

/** Explicit foreground style built from a theme-derived hex value. */
export function fgStyle(hex: string): Style {
	return Style.of({ fg: colorHex(hex) });
}

/** Explicit background style built from a theme-derived hex value. */
export function bgStyle(hex: string): Style {
	return Style.of({ bg: colorHex(hex) });
}

/** True when the theme sits on a dark surface. */
export function isDark(): boolean {
	const value = useTheme().theme().statusLineLuminance;
	return value === undefined || value <= 0.5;
}

/** The theme's canvas color: the surface diff tints and pills blend toward. */
export function canvasHex(): string {
	const hex = useTheme().theme().getBgHex("statusLineBg");
	return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : isDark() ? "#000000" : "#ffffff";
}

/** The theme's default text color, used as the bright mix pole. */
export function textHex(): string {
	return useTheme().theme().getColorHex("text");
}

/** Perceptual luminance of a hex color (0..1). */
export function luminance(hex: string): number {
	return colorLuma(hex)!;
}

/** Render a small immutable run list as inline spans. */
export function Runs({ runs }: { runs: readonly StyledRun[] }): JSX.Element {
	return (
		<span>
			{runs.map((run, index) => (
				<span key={index} style={run.style}>
					{run.text}
				</span>
			))}
		</span>
	);
}

/** Cell width of plain text carried by a run list. */
export function runsWidth(runs: readonly StyledRun[]): number {
	let width = 0;
	for (const run of runs) width += Bun.stringWidth(run.text);
	return width;
}

/** Filled pill with half-block end caps (`▐ label ▌`). */
export function pill(
	label: string,
	hex: string,
	options: { selected?: boolean; dim?: boolean } = {},
): readonly StyledRun[] {
	const fill = options.selected ? mixHex(hex, textHex(), 0.22) : options.dim ? mixHex(hex, canvasHex(), 0.55) : hex;
	const labelHex = luminance(fill) > 0.5 ? mixHex(fill, "#000000", 0.82) : mixHex(fill, "#ffffff", 0.92);
	const fillColor = colorHex(fill);
	return [
		{ style: Style.of({ fg: fillColor }), text: "▐" },
		{ style: Style.of({ fg: colorHex(labelHex), bg: fillColor }), text: label },
		{ style: Style.of({ fg: fillColor }), text: "▌" },
	];
}

/** Flat filled chip with a contrast-computed label. */
export function chipFill(label: string, hex: string): readonly StyledRun[] {
	const labelHex = luminance(hex) > 0.5 ? mixHex(hex, "#000000", 0.82) : mixHex(hex, "#ffffff", 0.92);
	return [{ style: Style.of({ fg: colorHex(labelHex), bg: colorHex(hex) }), text: label }];
}

/** Selection-row background chosen to retain every semantic foreground. */
export function selectionStyle(dim = false): Style {
	return bgStyle(mixHex(canvasHex(), textHex(), dim ? 0.08 : 0.14));
}

/** Tinted chip: faint fill of a theme color with the full color as label. */
export function tintChip(label: string, hex: string): readonly StyledRun[] {
	return [{ style: Style.of({ fg: colorHex(hex), bg: colorHex(mixHex(canvasHex(), hex, 0.18)) }), text: label }];
}

/** Subtle toggle chip: accent fill when active, neutral surface otherwise. */
export function softPill(label: string, options: { active?: boolean } = {}): readonly StyledRun[] {
	if (options.active) return chipFill(label, useTheme().theme().getColorHex("accent"));
	const canvas = canvasHex();
	return [
		{
			style: Style.of({
				fg: colorHex(mixHex(canvas, textHex(), 0.62)),
				bg: colorHex(mixHex(canvas, textHex(), 0.1)),
			}),
			text: label,
		},
	];
}
