import type { JSX } from "../reactive";
import type { ThemeColor } from "../theme/schema";

/** Props for the shared progress-bar composition. */
export interface BarProps {
	readonly fraction?: number;
	readonly compact?: boolean;
	readonly filledColor?: ThemeColor;
	readonly emptyColor?: ThemeColor;
	readonly filledChar?: string;
	readonly emptyChar?: string;
}

/** Render a progress bar using its allocated row width. */
export function Bar(props: BarProps): JSX.Element {
	return (
		<progress
			value={props.fraction}
			min={0}
			max={1}
			showPercentage={!(props.compact ?? false)}
			prefix={props.compact ? "" : "["}
			suffix={props.compact ? "" : "]"}
			filled={props.filledChar}
			empty={props.emptyChar}
			color={props.filledColor}
			emptyColor={props.emptyColor}
		/>
	);
}
