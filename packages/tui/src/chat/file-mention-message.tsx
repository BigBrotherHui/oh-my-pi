import { formatBytes } from "@oh-my-pi/pi-utils";
import { For, type JSX } from "../reactive";
import { useTheme } from "../theme/reactive";
import type { FileMentionMessage } from "./messages";

export interface FileMentionMessageViewProps {
	readonly files: FileMentionMessage["files"];
}

function fileSuffix(file: FileMentionMessage["files"][number]): string {
	if (file.skippedReason === "tooLarge" || file.skippedReason === "binary") {
		const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
		return file.skippedReason === "binary" ? `(skipped: binary, ${size})` : `(skipped: ${size})`;
	}
	if (file.image) return "(image)";
	return file.lineCount === undefined ? "(unknown lines)" : `(${file.lineCount} lines)`;
}

/** Compact status rows for files auto-read through `@filepath` mentions. */
export function FileMentionMessageView(props: FileMentionMessageViewProps): JSX.Element {
	const { theme } = useTheme();
	return (
		<box padding={{ left: 1 }}>
			<stack>
				<For each={props.files}>
					{file => (
						<row gap={1}>
							<text color="dim" shrink={0}>{`${theme().tree.last} `}</text>
							<text color="muted" shrink={0}>
								Read
							</text>
							<path value={file.path} color="accent" grow={0} minWidth={1} overflow="middle" />
							<text color="dim" shrink={0} overflow="clip">
								{fileSuffix(file)}
							</text>
						</row>
					)}
				</For>
			</stack>
		</box>
	);
}
