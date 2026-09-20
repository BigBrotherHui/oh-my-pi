import type { JSX } from "../reactive";
import type { ThemeColor } from "../theme/schema";

/** Presentation policy for a compact transcript divider. */
export interface MessageDividerViewProps {
	readonly label: string;
	readonly color?: ThemeColor;
	readonly ruleColor?: ThemeColor;
	readonly ruleWidth?: number;
	/**
	 * Preserve an intentionally untruncated label when the terminal is too
	 * narrow for both its leading rule and text.
	 */
	readonly truncateWhenNarrow?: boolean;
}

/**
 * Short left-aligned rule and label surrounded by blank transcript rows.
 * The retained rule adapts to the available width without remounting.
 */
export function MessageDividerView(props: MessageDividerViewProps): JSX.Element {
	return (
		<stack>
			<br />
			<hr
				variant="label"
				label={props.label}
				labelColor={props.color ?? "accent"}
				ruleColor={props.ruleColor}
				ruleWidth={props.ruleWidth}
				truncateWhenNarrow={props.truncateWhenNarrow}
			/>
			<br />
		</stack>
	);
}
