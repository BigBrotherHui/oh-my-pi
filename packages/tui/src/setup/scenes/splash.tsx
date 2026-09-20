import { gradientColor, PI_LOGO, type ShineConfig } from "../../prompt/welcome";
import type { ThemeColor } from "../../theme/schema";
import { Attr, Style } from "../../core/style";
import type { JSX } from "../../reactive";
import { cellWidth } from "../../core/richtext";

export const SETUP_SPLASH_MS = 2600;
export const SETUP_TICK_MS = 33;

const LARGE_LOGO = PI_LOGO.flatMap(line => {
	let wide = "";
	for (const char of line) wide += char === " " ? "  " : `${char}${char}`;
	return [wide, wide];
});
const LOGO_WIDTH = Math.max(...LARGE_LOGO.map(line => cellWidth(line)));
const LOGO_HEIGHT = LARGE_LOGO.length;
const MIN_SCENE_WIDTH = 56;
const MIN_SCENE_HEIGHT = 22;
const SKIP_HINT = "press enter to skip";
const WATER_RAMP = [
	{ min: 0.62, char: "█" },
	{ min: 0.5, char: "▓" },
	{ min: 0.36, char: "▒" },
	{ min: 0.24, char: "░" },
];

export interface SplashCell {
	readonly style?: Style;
	readonly color?: ThemeColor;
	readonly text: string;
}

export type SplashRows = readonly (readonly SplashCell[])[];

function blankRows(width: number, height: number): SplashCell[][] {
	return Array.from({ length: height }, () => Array.from({ length: width }, () => ({ text: " " })));
}

function starAt(x: number, y: number, frame: number): SplashCell {
	const hash = (x * 73856093) ^ (y * 19349663) ^ (frame * 83492791);
	const bucket = Math.abs(hash) % 97;
	if (bucket === 0) return { color: "accent", text: "✦" };
	if (bucket === 1) return { color: "muted", text: "·" };
	return { text: " " };
}

export function starfieldRows(width: number, height: number, frame: number): SplashRows {
	return Array.from({ length: Math.max(0, height) }, (_, y) =>
		Array.from({ length: Math.max(0, width) }, (_, x) => starAt(x, y, frame >> 3)),
	);
}

function screenGradientT(x: number, y: number, width: number, height: number, phase: number): number {
	const span = Math.max(1, width + height - 1);
	const base = (x + (height - 1 - y)) / span;
	return (((base + phase) % 1) + 1) % 1;
}

function skyGlyph(x: number, y: number, frame: number): SplashCell | null {
	const hash = (x * 73856093) ^ (y * 19349663) ^ (frame * 83492791);
	const bucket = Math.abs(hash) % 150;
	if (bucket === 0) return { color: "accent", text: "✦" };
	if (bucket === 1) return { color: "border", text: "✧" };
	if (bucket === 2) return { color: "border", text: "·" };
	return null;
}

function waterJitter(x: number, y: number): number {
	let hash = Math.imul(x, 374761393) + Math.imul(y, 668265263);
	hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
	hash ^= hash >>> 16;
	return (hash >>> 0) / 4294967296;
}

function waterAmplitude(
	x: number,
	y: number,
	centerX: number,
	waterTop: number,
	waterHeight: number,
	width: number,
	time: number,
): number {
	const dx = (x - centerX) / 2;
	const dy = y - waterTop;
	const distance = Math.sqrt(dx * dx + dy * dy);
	const wave =
		0.5 * Math.sin(distance * 0.55 - time) +
		0.3 * Math.sin(x * 0.22 + y * 0.45 - time * 0.7) +
		0.2 * Math.sin(Math.abs(dx) * 0.8 + dy * 0.5 - time * 1.4);
	const level = 0.5 + 0.5 * wave;
	const edge = Math.max(0, 1 - Math.abs(x - centerX) / (width * 0.5));
	const fade = Math.max(0, 1 - (dy / Math.max(1, waterHeight)) * 0.55);
	return level * edge ** 0.7 * fade;
}

export function gradientLogoRows(lines: readonly string[], phase: number, shine: ShineConfig): SplashCell[][] {
	const columns = Math.max(1, ...lines.map(line => line.length));
	const xSpan = Math.max(1, columns - 1);
	const ySpan = Math.max(1, lines.length - 1);
	const normalizedPhase = ((phase % 1) + 1) % 1;
	return lines.map((line, row) =>
		Array.from(line).map((character, column) => {
			if (character === " ") return { text: character };
			const base = (column / xSpan + row / ySpan) / 2;
			const position = normalizedPhase === 0 ? base : (base + normalizedPhase) % 1;
			return { style: Style.of({ fg: gradientColor(position, shine) }), text: character };
		}),
	);
}

function compactSplashRows(width: number, height: number, phase: number, shine: ShineConfig): SplashRows {
	const rows = blankRows(width, height);
	const art = height >= 14 ? LARGE_LOGO : PI_LOGO;
	const logo = gradientLogoRows(art, phase, shine);
	const titleRow = logo.length + 1;
	const contentRows = titleRow + 1;
	const start = Math.max(0, Math.floor((height - contentRows) / 2));
	for (let row = 0; row < logo.length; row++) {
		const targetY = start + row;
		if (targetY < 0 || targetY >= height) continue;
		const source = logo[row]!;
		const startX = Math.max(0, Math.floor((width - source.length) / 2));
		for (let column = 0; column < source.length && startX + column < width; column++)
			rows[targetY]![startX + column] = source[column]!;
	}
	const titleY = start + titleRow;
	const title = "O h   M y   P i";
	if (titleY >= 0 && titleY < height) {
		const startX = Math.max(0, Math.floor((width - cellWidth(title)) / 2));
		for (let column = 0; column < title.length && startX + column < width; column++) {
			rows[titleY]![startX + column] = { style: Style.NONE.plus(Attr.Bold), text: title[column]! };
		}
	}
	if (height > 2) {
		const hintY = height - 2;
		const startX = Math.max(0, Math.floor((width - cellWidth(SKIP_HINT)) / 2));
		for (let column = 0; column < SKIP_HINT.length && startX + column < width; column++) {
			rows[hintY]![startX + column] = { color: "dim", text: SKIP_HINT[column]! };
		}
	}
	return rows;
}

/** Compute all colored cells for one animation tick. */
export function setupSplashRows(width: number, height: number, elapsedMs: number): SplashRows {
	const safeWidth = Math.max(1, width);
	const safeHeight = Math.max(1, height);
	const progress = Math.max(0, Math.min(1, elapsedMs / SETUP_SPLASH_MS));
	const phase = progress * 1.8;
	const shine: ShineConfig = { pos: (progress * 2.5) % 1, strength: Math.max(0, 1 - progress * 0.35) };
	if (safeWidth < MIN_SCENE_WIDTH || safeHeight < MIN_SCENE_HEIGHT) {
		return compactSplashRows(safeWidth, safeHeight, phase, shine);
	}
	const frame = Math.floor(elapsedMs / SETUP_TICK_MS);
	const centerX = Math.floor(safeWidth / 2);
	const rows = blankRows(safeWidth, safeHeight);
	const logoX = Math.floor((safeWidth - LOGO_WIDTH) / 2);
	const logoY = Math.max(2, Math.floor(safeHeight * 0.16));
	const waterTop = logoY + LOGO_HEIGHT;
	const waterHeight = Math.max(1, safeHeight - waterTop);
	for (let y = waterTop; y < safeHeight; y++) {
		for (let x = 0; x < safeWidth; x++) {
			const amplitude =
				waterAmplitude(x, y, centerX, waterTop, waterHeight, safeWidth, frame * 0.13) +
				(waterJitter(x, y) - 0.5) * 0.06;
			const water = WATER_RAMP.find(step => amplitude > step.min);
			if (water)
				rows[y]![x] = {
					style: Style.of({ fg: gradientColor(screenGradientT(x, y, safeWidth, safeHeight, phase), shine) }),
					text: water.char,
				};
		}
	}
	for (let y = 0; y < waterTop - 1; y++) {
		for (let x = 0; x < safeWidth; x++) {
			const star = skyGlyph(x, y, frame >> 3);
			if (star) rows[y]![x] = star;
		}
	}
	LARGE_LOGO.forEach((line, row) => {
		Array.from(line).forEach((character, column) => {
			if (character !== " " && logoX + column >= 0 && logoX + column < safeWidth) {
				rows[logoY + row]![logoX + column] = {
					style: Style.of({
						fg: gradientColor(screenGradientT(logoX + column, logoY + row, safeWidth, safeHeight, phase), shine),
					}),
					text: character,
				};
			}
		});
	});
	const hintStart = Math.floor((safeWidth - cellWidth(SKIP_HINT)) / 2);
	for (let x = hintStart - 1; x <= hintStart + cellWidth(SKIP_HINT); x++) {
		if (x >= 0 && x < safeWidth) rows[safeHeight - 1]![x] = { text: " " };
	}
	for (let column = 0; column < SKIP_HINT.length; column++) {
		const character = SKIP_HINT[column]!;
		const x = hintStart + column;
		if (x >= 0 && x < safeWidth) {
			rows[safeHeight - 1]![x] = character === " " ? { text: character } : { color: "dim", text: character };
		}
	}
	return rows;
}

export function SplashFrameView(props: { readonly rows: SplashRows }): JSX.Element {
	return (
		<stack>
			{props.rows.map((row, rowIndex) => (
				<text key={rowIndex} wrap="none">
					{row.map((cell, column) => (
						<span key={column} style={cell.style} color={cell.color}>
							{cell.text}
						</span>
					))}
				</text>
			))}
		</stack>
	);
}
