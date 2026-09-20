import type { TextContent } from "@oh-my-pi/pi-ai";
import type { Out } from "../core/richtext";
import { Attr, Style } from "../core/style";
import { createDocument } from "../document/document";
import { createMemo, type JSX, useTheme } from "../reactive";
import { fileHyperlinkStyle } from "../render/hyperlink";
import { COMPOSER_TOKEN_REGEX, collapseSkillTokens, skillChipLabel, skillToken } from "../prompt/composer-attachments";
import type { CustomMessage, SkillPromptDetails } from "./messages";
import { SKILL_PROMPT_MESSAGE_TYPE } from "./messages";
import { paintBubbleProse, type UserBubbleOptions, UserMessageView, userBubbleColor } from "./user-message";

export interface SkillMessageViewProps {
	readonly message: CustomMessage<SkillPromptDetails>;
	readonly expanded: boolean;
	/** Materialized image destinations, indexed by the visible attachment chip number. */
	readonly imageLinks?: readonly (string | undefined)[];
	/** Disable OSC 133 prompt markers while this row is painted in an alternate-screen overlay. */
	readonly promptZones?: boolean;
}

/** Markdown that shares the user-bubble prose, chips, links, and tight-width behavior without another bubble frame. */
function SkillBubbleMarkdown(props: { readonly text: string; readonly options: UserBubbleOptions }): JSX.Element {
	const { theme } = useTheme();
	const document = createDocument(props.text);
	const color = createMemo(() => userBubbleColor(props.options, COMPOSER_TOKEN_REGEX, theme()));
	const options = createMemo(() => ({
		ignoreTight: true,
		defaultTextStyle: {
			style: Style.of({
				fg: theme().fgOnBgColor("userMessageText", "userMessageBg"),
				bg: theme().bgColor("userMessageBg"),
			}),
			paintProse: (out: Out, value: string, base: Style) => paintBubbleProse(out, value, base, color()),
		},
	}));
	return <markdown document={document} options={options()} />;
}

/** Skill pill (linked to SKILL.md) followed by its muted line-count metadata. */
function SkillHeader(props: { readonly label: string; readonly details: SkillPromptDetails | undefined }): JSX.Element {
	const { theme } = useTheme();
	const chip = createMemo(() => {
		let style = theme().style("customMessageLabel", "customMessageBg").plus(Attr.Bold);
		if (props.details?.path) style = fileHyperlinkStyle(props.details.path, { line: 1 }, style);
		return style;
	});
	const metadata = createMemo(() => theme().style("muted", "userMessageBg"));
	return (
		<row>
			<text style={chip()}>{props.label}</text>
			{typeof props.details?.lineCount === "number" ? (
				<>
					<text>{"  "}</text>
					<text style={metadata()}>
						{`${props.details.lineCount} ${props.details.lineCount === 1 ? "line" : "lines"}`}
					</text>
				</>
			) : null}
		</row>
	);
}

/** Expanded SKILL.md body, constructed only after the transcript expansion toggle opens it. */
function SkillPromptSection(props: { readonly text: string; readonly options: UserBubbleOptions }): JSX.Element | null {
	const { theme } = useTheme();
	const label = createMemo(() => theme().style("muted", "userMessageBg"));
	return props.text.length === 0 ? null : (
		<stack>
			<br />
			<text style={label()}>prompt</text>
			<br />
			<SkillBubbleMarkdown text={props.text} options={props.options} />
		</stack>
	);
}

/** A user bubble whose skill-colored rail remains continuous across its entire callout. */
function SkillCallout(props: { readonly children: JSX.Element }): JSX.Element {
	const { theme } = useTheme();
	return (
		<rail
			prefix={
				<text color="customMessageLabel" background="userMessageBg">
					{theme().symbol("skill.rail")}
				</text>
			}
		>
			<box background="userMessageBg" padding={1}>
				{props.children}
			</box>
		</rail>
	);
}

/**
 * Transcript row for a user-invoked skill. A leading invocation becomes a
 * railed callout; a mid-prompt invocation remains an ordinary user bubble with
 * only the dispatched token collapsed into a linked skill pill.
 */
export function SkillMessageView(props: SkillMessageViewProps): JSX.Element {
	const details = props.message.details;
	const name = details?.name.trim() || "unknown";
	const token = skillToken(name);
	const display = collapseSkillTokens(
		details?.prompt ?? (details?.args ? `${token} ${details.args}` : token),
		candidate => candidate === name,
		() => {},
	);
	const label = skillChipLabel(name);
	const options: UserBubbleOptions = {
		imageLinks: props.imageLinks,
		skillPath: candidate => (candidate === name ? details?.path : undefined),
		promptZones: props.promptZones,
	};
	const prompt =
		typeof props.message.content === "string"
			? props.message.content
			: props.message.content
					.filter((item): item is TextContent => item.type === "text")
					.map(item => item.text)
					.join("\n");

	if (!(display.startsWith(label) && /^\s*$/.test(display.charAt(label.length)))) {
		return props.expanded ? (
			<stack>
				<UserMessageView text={display} options={options} />
				<SkillCallout>
					<stack>
						<SkillHeader label={label} details={details} />
						<SkillPromptSection text={prompt} options={options} />
					</stack>
				</SkillCallout>
			</stack>
		) : (
			<UserMessageView text={display} options={options} />
		);
	}

	const body = display.slice(label.length).trim();
	return (
		<SkillCallout>
			<stack>
				<SkillHeader label={label} details={details} />
				{body ? (
					<>
						<br />
						<SkillBubbleMarkdown text={body} options={options} />
					</>
				) : null}
				{props.expanded ? <SkillPromptSection text={prompt} options={options} /> : null}
			</stack>
		</SkillCallout>
	);
}

export function isSkillMessage(message: CustomMessage<unknown>): message is CustomMessage<SkillPromptDetails> {
	return message.customType === SKILL_PROMPT_MESSAGE_TYPE;
}
