import { PI_LOGO } from "../../prompt/welcome";
import { theme } from "../../theme/theme";
import { cellWidth } from "../../core/richtext";
import { Attr, type Style } from "../../core/style";
import type { JSX } from "../../reactive";
import {
	gradientLogoRows,
	SplashFrameView,
	starfieldRows,
	SETUP_TICK_MS,
	type SplashCell,
	type SplashRows,
} from "./splash";

export const SETUP_OUTRO_MS = 1200;

function centeredRow(width: number, cells: readonly SplashCell[]): SplashCell[] {
	const row = Array.from({ length: Math.max(0, width) }, () => ({ text: " " }) satisfies SplashCell);
	const contentWidth = cells.reduce((sum, cell) => sum + cellWidth(cell.text), 0);
	let column = Math.max(0, Math.floor((width - contentWidth) / 2));
	for (const cell of cells) {
		const columns = cellWidth(cell.text);
		if (column + columns > row.length) break;
		row[column] = cell;
		column += columns;
	}
	return row;
}

function textCells(text: string, style: Style): SplashCell[] {
	return Array.from(text).map(character => ({ style, text: character }));
}

/** Compute all colored cells for one outro animation tick. */
export function setupOutroRows(width: number, height: number, elapsedMs: number): SplashRows {
	const safeWidth = Math.max(0, width);
	const safeHeight = Math.max(0, height);
	const frame = Math.floor(elapsedMs / SETUP_TICK_MS);
	const rows = starfieldRows(safeWidth, safeHeight, frame + 1000).map(row => [...row]);
	const progress = Math.max(0, Math.min(1, elapsedMs / SETUP_OUTRO_MS));
	const content: SplashCell[][] = [
		...gradientLogoRows(PI_LOGO, progress * 1.2, { pos: (progress * 2) % 1, strength: 1 - progress }),
		[],
		textCells(`${theme.status.success} Setup saved`, theme.style("success").plus(Attr.Bold)),
		textCells("Handing off to the normal CLI…", theme.style("muted")),
		[],
	];
	const sweepWidth = Math.max(1, Math.min(safeWidth - 8, Math.floor((safeWidth - 8) * progress)));
	content.push([
		...textCells("━".repeat(sweepWidth), theme.style("accent")),
		...textCells("─".repeat(Math.max(0, safeWidth - 8 - sweepWidth)), theme.style("dim")),
	]);
	const start = Math.max(0, Math.floor((safeHeight - content.length) / 2));
	for (let index = 0; index < content.length && start + index < safeHeight; index++) {
		rows[start + index] = centeredRow(safeWidth, content[index]!);
	}
	return rows;
}

export function SetupOutroView(props: { readonly rows: SplashRows }): JSX.Element {
	return <SplashFrameView rows={props.rows} />;
}
