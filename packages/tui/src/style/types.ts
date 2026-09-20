/** Styling contract (Architecture Contract v1 §4): semantic tokens, cascade, recipes. */
import type { Color, Style } from "../core/style";
import type { ThemeBg, ThemeColor } from "../theme/schema";

/** Inheritable text properties; padding/sizes/background do not inherit. */
export interface TextStyleProps {
	readonly color?: ThemeColor | Color;
	readonly bold?: boolean;
	readonly dim?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly undercurl?: boolean;
	readonly strike?: boolean;
	readonly inverse?: boolean;
	readonly blink?: boolean;
	readonly link?: string;
}

export interface StyleProps extends TextStyleProps {
	/** Paints this element's box; children reveal it unless they set their own. */
	readonly background?: ThemeBg | Color;
	/** Named recipe from `style/recipes.ts`. */
	readonly recipe?: string;
	/** Escape hatch for element implementations; feature views use tokens. */
	readonly style?: Style;
}

/** Cascade order, lowest to highest precedence. */
export type CascadeLayer = "defaults" | "inherited" | "variant" | "recipe" | "local" | "props";
