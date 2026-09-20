import type { JSX } from "../reactive";
import type { ToolUIStatus } from "../host/elements/status";

/** Status vocabulary shared by retained status glyphs and view compositions. */
export type { ToolUIStatus } from "../host/elements/status";

/** Props for a semantic status glyph. */
export interface StatusIconProps {
	readonly status: ToolUIStatus;
}

/** Render status through the host element that owns symbols and animation. */
export function StatusIcon(props: StatusIconProps): JSX.Element {
	return <status value={props.status} />;
}
