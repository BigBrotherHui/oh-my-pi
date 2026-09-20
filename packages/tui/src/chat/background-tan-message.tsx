import { replaceTabs } from "../render/render-utils";
import { useTheme, useTightLayout, type JSX } from "../reactive";
import type { BackgroundTanDispatchDetails, CustomMessage } from "./messages";

const TAN_WORK_PREVIEW_LENGTH = 56;

export interface BackgroundTanDispatchViewProps {
	readonly message: CustomMessage<Partial<BackgroundTanDispatchDetails>>;
}

/** Compact `/tan` dispatch breadcrumb; system-notice body remains model-only. */
export function BackgroundTanDispatchView(props: BackgroundTanDispatchViewProps): JSX.Element {
	const theme = useTheme();
	const tight = useTightLayout();
	const details = props.message.details;
	const jobId = details?.jobId ?? "unknown";
	const work = details?.work ? previewWork(details.work) : undefined;
	return (
		<box padding={tight() ? { x: 0 } : { x: 1 }}>
			<text wrap="word">
				<span color="muted">{`${theme.symbol("icon.output")} Tangent dispatched`}</span>
				<span> </span>
				<span color="dim">[task]</span>
				<span> </span>
				<span color="accent">{jobId}</span>
				{work ? (
					<>
						<span> </span>
						<span color="dim">{`${theme.symbol("format.dash")} ${work}`}</span>
					</>
				) : null}
			</text>
		</box>
	);
}

function previewWork(work: string): string {
	const singleLine = replaceTabs(work).trim().replace(/\s+/g, " ");
	return singleLine.length <= TAN_WORK_PREVIEW_LENGTH
		? singleLine
		: `${singleLine.slice(0, TAN_WORK_PREVIEW_LENGTH - 1)}…`;
}
