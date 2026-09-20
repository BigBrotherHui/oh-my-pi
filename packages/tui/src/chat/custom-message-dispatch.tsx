import { isRecord } from "@oh-my-pi/pi-utils";
import { Show, type JSX } from "../reactive";
import { AdvisorMessageView } from "./advisor-message";
import { AsyncResultMessageView } from "./async-result-message";
import { BackgroundTanDispatchView } from "./background-tan-message";
import { CollabPromptMessageView } from "./collab-prompt-message";
import { HandoffSummaryMessageView, isHandoffMessage } from "./compaction-summary-message";
import { CustomMessageView } from "./custom-message";
import { HookMessageView } from "./hook-message";
import { IrcMessageView } from "./irc-message";
import { LateDiagnosticsMessageView, type LateDiagnosticsFile } from "./late-diagnostics-message";
import { LaunchCompletionMessageView } from "./launch-completion-message";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	COLLAB_PROMPT_MESSAGE_TYPE,
	LAUNCH_COMPLETION_MESSAGE_TYPE,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	type AdvisorMessageDetails,
	type BackgroundTanDispatchDetails,
	type CollabPromptDetails,
	type CustomMessage,
	type HookMessage,
} from "./messages";
import { SkillMessageView, isSkillMessage } from "./skill-message";

export interface CustomMessageDispatchProps {
	readonly message: CustomMessage<unknown>;
	readonly expanded: () => boolean;
	readonly toolActivityVisible: () => boolean;
	readonly getMessageView?: (
		customType: string,
	) =>
		| ((props: { readonly message: CustomMessage<unknown>; readonly expanded: boolean }) => JSX.Element | undefined)
		| undefined;
}

export interface HookMessageDispatchProps {
	readonly message: HookMessage<unknown>;
	readonly expanded: () => boolean;
	readonly getHookMessageView?: (
		customType: string,
	) =>
		| ((props: { readonly message: HookMessage<unknown>; readonly expanded: boolean }) => JSX.Element | undefined)
		| undefined;
}

/** Whether a custom message is compact tool activity and obeys its visibility control. */
export function isCustomMessageToolActivity(message: CustomMessage<unknown>): boolean {
	return message.customType === "async-result" || message.customType === LAUNCH_COMPLETION_MESSAGE_TYPE;
}

/** Shared custom-message dispatch for live delivery and persisted transcript replay. */
export function CustomMessageDispatchView(props: CustomMessageDispatchProps): JSX.Element {
	const message = props.message;
	if (!message.display) return null;
	if (message.customType === "async-result") {
		return (
			<Show when={props.toolActivityVisible()}>
				<AsyncResultMessageView message={message} />
			</Show>
		);
	}
	if (message.customType === LAUNCH_COMPLETION_MESSAGE_TYPE) {
		return (
			<Show when={props.toolActivityVisible()}>
				<LaunchCompletionMessageView message={message} />
			</Show>
		);
	}
	if (
		message.customType === "irc:incoming" ||
		message.customType === "irc:autoreply" ||
		message.customType === "irc:relay" ||
		message.customType === "irc:workpool"
	) {
		return <IrcMessageView message={message} expanded={props.expanded()} />;
	}
	if (message.customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE && isBackgroundTanDispatchMessage(message)) {
		return <BackgroundTanDispatchView message={message} />;
	}
	if (message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE) {
		const files =
			isRecord(message.details) && Array.isArray(message.details.files)
				? message.details.files.filter(isLateDiagnosticFile)
				: [];
		return <LateDiagnosticsMessageView files={files} expanded={props.expanded()} visible />;
	}
	if (message.customType === COLLAB_PROMPT_MESSAGE_TYPE && isCollabPromptMessage(message)) {
		return <CollabPromptMessageView message={message} />;
	}
	if (isSkillMessage(message)) return <SkillMessageView message={message} expanded={props.expanded()} />;
	if (message.customType === "advisor" && isAdvisorMessageDetails(message.details)) {
		return <AdvisorMessageView details={message.details} expanded={props.expanded()} />;
	}
	if (isHandoffMessage(message)) return <HandoffSummaryMessageView message={message} expanded={props.expanded()} />;
	return (
		<CustomMessageView
			message={message}
			expanded={props.expanded()}
			view={props.getMessageView?.(message.customType)}
		/>
	);
}

/** Shared hook-message renderer with the same safe custom-view fallback policy. */
export function HookMessageDispatchView(props: HookMessageDispatchProps): JSX.Element {
	const message = props.message;
	if (!message.display) return null;
	const view = props.getHookMessageView?.(message.customType);
	let content: JSX.Element | undefined;
	try {
		content = view?.({
			message,
			get expanded() {
				return props.expanded();
			},
		});
	} catch {
		content = undefined;
	}
	return <HookMessageView message={message} expanded={props.expanded()} content={content} />;
}

function isLateDiagnosticFile(value: unknown): value is LateDiagnosticsFile {
	return isRecord(value);
}

function isBackgroundTanDispatchMessage(
	message: CustomMessage<unknown>,
): message is CustomMessage<Partial<BackgroundTanDispatchDetails>> {
	return message.details === undefined || isRecord(message.details);
}

function isCollabPromptMessage(message: CustomMessage<unknown>): message is CustomMessage<CollabPromptDetails> {
	return message.customType === COLLAB_PROMPT_MESSAGE_TYPE;
}

function isAdvisorMessageDetails(value: unknown): value is AdvisorMessageDetails {
	if (!isRecord(value) || !Array.isArray(value.notes)) return false;
	return value.notes.every(
		note =>
			isRecord(note) &&
			typeof note.note === "string" &&
			(note.severity === undefined ||
				note.severity === "nit" ||
				note.severity === "concern" ||
				note.severity === "blocker") &&
			(note.advisor === undefined || typeof note.advisor === "string"),
	);
}
