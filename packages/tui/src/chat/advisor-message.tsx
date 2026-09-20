import { replaceTabs } from "../utils";
import { createMemo, For, type JSX, useTheme } from "../reactive";
import type { Theme } from "../theme/theme";
import type { AdvisorMessageDetails, AdvisorNote } from "./messages";

const COLLAPSED_NOTES = 3;
const EMPTY_NOTES: readonly AdvisorNote[] = [];

interface AdvisorNoteLine {
	readonly note: AdvisorNote;
	readonly text: string;
	readonly first: boolean;
}

interface AdvisorPresentation {
	readonly paddingX: number;
	readonly noteCount: number;
	readonly blockerCount: number;
	readonly rail: string;
	readonly lines: readonly AdvisorNoteLine[];
	readonly hiddenNotes: number;
}

export interface AdvisorMessageViewProps {
	readonly details?: AdvisorMessageDetails;
	readonly expanded: boolean;
}

function severityColor(note: AdvisorNote): "error" | "warning" | "muted" {
	switch (note.severity) {
		case "blocker":
			return "error";
		case "concern":
			return "warning";
		default:
			return "muted";
	}
}

function noteLines(note: AdvisorNote): AdvisorNoteLine[] {
	return note.note
		.split("\n")
		.filter(part => part.trim())
		.map((text, index) => ({ note, text: replaceTabs(text), first: index === 0 }));
}

function presentationFor(
	details: AdvisorMessageDetails | undefined,
	expanded: boolean,
	activeTheme: Theme,
): AdvisorPresentation {
	const notes = details?.notes ?? EMPTY_NOTES;
	const shown = expanded ? notes : notes.slice(0, COLLAPSED_NOTES);
	const paddingX = 1;
	const lines: AdvisorNoteLine[] = [];
	const rail = activeTheme.symbol("advisor.rail");
	for (const note of shown) lines.push(...noteLines(note));
	const blockerCount = notes.filter(note => note.severity === "blocker").length;
	return {
		paddingX,
		noteCount: notes.length,
		blockerCount,
		rail,
		lines,
		hiddenNotes: expanded ? 0 : notes.length - shown.length,
	};
}

function AdvisorMessageRows(props: AdvisorMessageViewProps): JSX.Element {
	const { theme } = useTheme();
	const presentation = createMemo(() => presentationFor(props.details, props.expanded, theme()));
	return (
		<box padding={{ left: presentation().paddingX, right: presentation().paddingX }}>
			<stack gap={0}>
				<text wrap="clip" overflow="ellipsis">
					<span color="customMessageLabel" bold>{`${theme().status.info} Advisor`}</span>{" "}
					<span color="dim">{`${presentation().noteCount} ${presentation().noteCount === 1 ? "note" : "notes"}`}</span>
					{presentation().blockerCount > 0 ? (
						<>
							<span color="dim">{theme().sep.dot}</span>
							<span color="error">{`${presentation().blockerCount} blocker${presentation().blockerCount === 1 ? "" : "s"}`}</span>
						</>
					) : null}
				</text>
				<For each={presentation().lines}>
					{line => (
						<rail
							prefix={
								<>
									<span color={severityColor(line.note)}>{`  ${presentation().rail} `}</span>
									{line.first && line.note.severity ? (
										<>
											<badge color={severityColor(line.note)}>{line.note.severity}</badge>{" "}
										</>
									) : null}
									{line.first && line.note.advisor && line.note.advisor !== "default" ? (
										<>
											<span color="dim">{`[${replaceTabs(line.note.advisor)}]`}</span>{" "}
										</>
									) : null}
								</>
							}
							rest={<span color={severityColor(line.note)}>{`  ${presentation().rail} `}</span>}
						>
							<text color="customMessageText" wrap="word">
								{line.text}
							</text>
						</rail>
					)}
				</For>
				{presentation().hiddenNotes > 0 ? (
					<text color="dim" wrap="clip" overflow="ellipsis">
						{`  ${presentation().rail} … +${presentation().hiddenNotes} more ${presentation().hiddenNotes === 1 ? "note" : "notes"}`}
					</text>
				) : null}
			</stack>
		</box>
	);
}

/** Severity-tagged advisor notes, with a controlled three-note collapsed preview. */
export function AdvisorMessageView(props: AdvisorMessageViewProps): JSX.Element {
	const paint = createMemo(() => {
		const details = props.details;
		const expanded = props.expanded;
		return () => <AdvisorMessageRows details={details} expanded={expanded} />;
	});
	return <sized paint={paint()} />;
}
