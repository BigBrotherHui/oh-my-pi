import { Show, type JSX } from "../reactive";
import type { OutputArtifactError } from "../tools/streaming-output";
import type { SourceMeta, TruncationMeta } from "../tools/output-meta";

/** Props for a normalized truncation warning. */
export interface TruncationNoticeProps {
	readonly truncation?: TruncationMeta;
	readonly source?: SourceMeta;
	readonly artifactError?: OutputArtifactError;
	readonly text?: string;
}

function noticeText(props: TruncationNoticeProps): string {
	let message = props.text ?? "";
	if (!message && props.truncation) {
		const truncation = props.truncation;
		const range = truncation.shownRange;
		message =
			range && range.end >= range.start
				? `Showing lines ${range.start}-${range.end} of ${truncation.totalLines}`
				: `Showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		if (truncation.nextOffset != null) message += `. Use :${truncation.nextOffset} to continue`;
		if (truncation.artifactId) {
			message +=
				props.source?.type === "report"
					? `. Read artifact://${truncation.artifactId} for full report (${props.source.value})`
					: `. Read artifact://${truncation.artifactId} for full output`;
		}
	}
	if (props.artifactError) {
		if (message) message += ". ";
		message += `Full output was not saved completely (artifact ${props.artifactError} failed)`;
	}
	return message;
}

/** Render a warning only when truncation or artifact metadata has content. */
export function TruncationNotice(props: TruncationNoticeProps): JSX.Element {
	return (
		<Show when={noticeText(props)}>
			<text color="warning">
				<badge>{noticeText(props)}</badge>
			</text>
		</Show>
	);
}
