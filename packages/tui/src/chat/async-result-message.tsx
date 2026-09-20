import { formatDuration, isRecord } from "@oh-my-pi/pi-utils";
import { For, type JSX } from "../reactive";
import { formatArtifactErrorNotice } from "../tools/output-meta";
import type { OutputArtifactError } from "../tools/streaming-output";
import type { CustomMessage } from "./messages";

interface AsyncResultJob {
	readonly jobId: string;
	readonly type?: string;
	readonly duration?: string;
	readonly artifactError?: OutputArtifactError;
}

function artifactError(value: unknown): OutputArtifactError | undefined {
	if (!isRecord(value)) return undefined;
	switch (value.artifactError) {
		case "open":
		case "write":
		case "flush":
		case "end":
			return value.artifactError;
		default:
			return undefined;
	}
}

function jobFromDetails(value: unknown): AsyncResultJob {
	const details = isRecord(value) ? value : undefined;
	const jobId = details?.jobId;
	const type = details?.type;
	const durationMs = details?.durationMs;
	return {
		jobId: typeof jobId === "string" && jobId.length > 0 ? jobId : "unknown",
		type: typeof type === "string" && type.length > 0 ? type : undefined,
		duration: typeof durationMs === "number" ? formatDuration(durationMs) : undefined,
		artifactError: artifactError(details?.meta),
	};
}

/** Compact completion rows for persisted background-job deliveries. */
export function AsyncResultMessageView(props: { readonly message: CustomMessage<unknown> }): JSX.Element {
	const details = isRecord(props.message.details) ? props.message.details : undefined;
	const deliveryJobs = details?.jobs;
	const jobs =
		Array.isArray(deliveryJobs) && deliveryJobs.length > 0
			? deliveryJobs.map(jobFromDetails)
			: [jobFromDetails(details)];
	const deliveryArtifactError = artifactError(details?.meta);
	return (
		<box padding={{ left: 1 }}>
			<stack>
				<For each={jobs}>
					{job => (
						<>
							<text>
								<icon name="status.done" color="success" />{" "}
								<span color="success">Background job completed</span>{" "}
								<span color="dim">{job.type ? `[${job.type}]` : "[job]"}</span>{" "}
								<span color="accent">{job.jobId}</span>
								{job.duration ? <span color="dim">{` (${job.duration})`}</span> : null}
							</text>
							{job.artifactError ? (
								<text color="warning">{formatArtifactErrorNotice(job.artifactError)}</text>
							) : null}
						</>
					)}
				</For>
				{deliveryArtifactError ? (
					<text color="warning">{formatArtifactErrorNotice(deliveryArtifactError)}</text>
				) : null}
			</stack>
		</box>
	);
}
