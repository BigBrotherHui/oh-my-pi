import type { Theme } from "../theme";
import { Style, type Color } from "../core/style";
import type { SeparatorDef, StatusLineSeparatorStyle } from "./types";

/** Style a powerline transition: the previous background becomes the glyph foreground. */
export function powerlineTransitionStyle(previousBg: Color, nextBg: Color): Style {
	return Style.of({ fg: previousBg, bg: nextBg });
}

function trimSep(value: string): string {
	return value.trim();
}

export function getSeparator(style: StatusLineSeparatorStyle, theme: Theme): SeparatorDef {
	switch (style) {
		case "powerline":
			return {
				left: theme.sep.powerlineLeft,
				right: theme.sep.powerlineRight,
				endCaps: {
					left: theme.sep.powerlineRight,
					right: theme.sep.powerlineLeft,
					useBgAsFg: true,
				},
			};
		case "powerline-thin":
			return {
				left: theme.sep.powerlineThinLeft,
				right: theme.sep.powerlineThinRight,
				endCaps: {
					left: theme.sep.powerlineRight,
					right: theme.sep.powerlineLeft,
					useBgAsFg: true,
				},
			};
		case "slash": {
			const slash = trimSep(theme.sep.slash);
			return { left: slash, right: slash };
		}
		case "pipe": {
			const pipe = trimSep(theme.sep.pipe);
			return { left: pipe, right: pipe };
		}
		case "block":
			return { left: theme.sep.block, right: theme.sep.block };
		case "none":
			return { left: theme.sep.space, right: theme.sep.space };
		case "ascii":
			return { left: theme.sep.asciiLeft, right: theme.sep.asciiRight };
		default:
			return {
				left: theme.sep.powerlineThinLeft,
				right: theme.sep.powerlineThinRight,
				endCaps: {
					left: theme.sep.powerlineRight,
					right: theme.sep.powerlineLeft,
					useBgAsFg: true,
				},
			};
	}
}
