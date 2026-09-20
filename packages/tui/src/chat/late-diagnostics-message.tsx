import { createMemo, Show, type Accessor, type JSX } from "../reactive";
import { sanitizeDiagnosticDisplayText } from "../render/render-utils";
import { DiagnosticTree } from "../view/diagnostic-tree";

/** One file's worth of late LSP diagnostics, carried on a transcript message. */
export interface LateDiagnosticsFile {
	readonly path?: string;
	readonly summary?: string;
	readonly errored?: boolean;
	readonly messages?: readonly string[];
}

/** Late diagnostic delivery and its transcript visibility state. */
export interface LateDiagnosticsMessageViewProps {
	readonly files: readonly LateDiagnosticsFile[];
	readonly expanded: boolean;
	readonly visible: boolean;
}

interface DiagnosticsPresentation {
	readonly errored: boolean;
	readonly summary: string;
	readonly messages: readonly string[];
}

function presentDiagnostics(files: readonly LateDiagnosticsFile[]): DiagnosticsPresentation | undefined {
	const messages: string[] = [];
	const summaries: string[] = [];
	let errored = false;
	for (const file of files) {
		if (file.messages?.length) messages.push(...file.messages);
		if (file.summary) summaries.push(sanitizeDiagnosticDisplayText(file.summary));
		if (file.errored) errored = true;
	}
	return messages.length === 0 ? undefined : { errored, summary: summaries.join(", "), messages };
}

/** Diagnostics delivered after the corresponding tool result settled. */
export function LateDiagnosticsMessageView(props: LateDiagnosticsMessageViewProps): JSX.Element {
	const presentation = createMemo(() => presentDiagnostics(props.files));
	return (
		<Show when={props.visible}>
			<Show when={presentation()}>
				{(current: Accessor<DiagnosticsPresentation>) => (
					<stack>
						<rail prefix=" " rest=" ">
							<row gap={1}>
								<icon
									name={current().errored ? "status.error" : "status.warning"}
									color={current().errored ? "error" : "warning"}
								/>
								<text color="toolTitle">Late diagnostics</text>
								<Show when={current().summary}>
									<text color="dim">({current().summary})</text>
								</Show>
							</row>
						</rail>
						<rail prefix="  " rest="  ">
							<DiagnosticTree messages={current().messages} expanded={props.expanded} />
						</rail>
					</stack>
				)}
			</Show>
		</Show>
	);
}
