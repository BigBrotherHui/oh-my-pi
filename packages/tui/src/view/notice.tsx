import { Show, type JSX } from "../reactive";
import type { ThemeColor } from "../theme/schema";
import { StatusIcon, type ToolUIStatus } from "./status-icon";

/** Props for a semantic inline notice. */
export interface NoticeProps {
	readonly severity?: ThemeColor;
	readonly status?: ToolUIStatus;
	readonly icon?: string;
	readonly children: JSX.Element;
	readonly inverse?: boolean;
}

/** Render an optional status/icon prefix and notice content. */
export function Notice(props: NoticeProps): JSX.Element {
	return (
		<text color={props.severity ?? "warning"} inverse={props.inverse}>
			<Show
				when={props.status}
				fallback={
					<Show when={props.icon}>
						<span>{props.icon} </span>
					</Show>
				}
			>
				<StatusIcon status={props.status!} />{" "}
			</Show>
			{props.children}
		</text>
	);
}
