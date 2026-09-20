import type { ThemeColor } from "../theme/schema";
import type { JSX } from "../reactive";

export interface DynamicBorderViewProps {
	readonly color?: ThemeColor;
}

/** Full-width thematic rule. */
export function DynamicBorderView(props: DynamicBorderViewProps): JSX.Element {
	return <hr ruleColor={props.color ?? "border"} />;
}
