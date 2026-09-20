import type { SymbolKey } from "../theme/symbols";
import type { ThemeColor } from "../theme/schema";
import type { Style } from "../core/style";
import { Show, type JSX } from "../reactive";
import type { ToolUIStatus } from "./status-icon";

/** Props for the standard tool heading row. */
export interface ToolHeaderProps {
	readonly status?: ToolUIStatus;
	/** Override the status glyph tone when it represents a tool identity instead of an outcome. */
	readonly statusColor?: ThemeColor;
	readonly icon?: SymbolKey;
	/** Semantic tone of an identity glyph rendered independently from status. */
	readonly iconColor?: ThemeColor;
	readonly successIcon?: SymbolKey;
	readonly labelOverflow?: "clip" | "ellipsis" | "middle";
	/** Overflow marker styling for a clipped inline tool heading. */
	readonly ellipsisStyle?: Style;
	/** Keep path-oriented headings on one row instead of wrapping prose. */
	readonly wrap?: "word" | "none";
	readonly label: JSX.Element;
	readonly badge?: JSX.Element;
	readonly meta?: JSX.Element;
	/** Preserve caller-owned fragment colors when metadata includes unstyled separators. */
	readonly metaStyle?: "dim" | "content";
	readonly grow?: number;
}

/** Render a wrapping inline heading; enclosing frames own title truncation. */
export function ToolHeader(props: ToolHeaderProps): JSX.Element {
	return (
		<text
			wrap={props.wrap ?? "word"}
			overflow={props.labelOverflow ?? "ellipsis"}
			ellipsisStyle={props.ellipsisStyle}
			grow={props.grow}
		>
			<Show when={props.status}>
				<status value={props.status!} successIcon={props.successIcon} color={props.statusColor} />{" "}
			</Show>
			<Show when={props.icon}>
				<icon name={props.icon!} color={props.iconColor} />{" "}
			</Show>
			<Show when={typeof props.label === "string"} fallback={props.label}>
				<span recipe="tool.header">{props.label}</span>
			</Show>
			<Show when={props.badge}>
				{" "}
				<badge>{props.badge}</badge>
			</Show>
			<Show when={props.meta}>
				{" "}
				<Show when={props.metaStyle === "content"} fallback={<meta recipe="tool.header.meta">{props.meta}</meta>}>
					{props.meta}
				</Show>
			</Show>
		</text>
	);
}
