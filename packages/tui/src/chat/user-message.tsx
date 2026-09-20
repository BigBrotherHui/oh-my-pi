import { formatBytes } from "@oh-my-pi/pi-utils";
import {
	attachmentSgr,
	collapseImageMarkers,
	COMPOSER_TOKEN_REGEX,
	composerTokenRegex,
	modelChipStyle,
	modelMentionChipLabel,
	renderPlaceholders,
	skillChipStyle,
} from "../prompt/composer-attachments";
import { MODEL_MENTION_TAG_RE } from "../prompt/model-mention-syntax";
import { fileHyperlink } from "../render/hyperlink";
import { imageReferenceHyperlink } from "../prompt/image-references";
import { highlightMagicKeywords } from "../prompt/magic-keywords";
import { parseAnsiRow } from "../core/ansi";
import type { Out } from "../core/richtext";
import type { Style } from "../core/style";
import { createDocument } from "../document/document";
import { createMemo, Show, type Accessor, type JSX } from "../reactive";
import { useTheme } from "../theme/reactive";
import { theme, type Theme } from "../theme/theme";
import type { ReactionTarget } from "./reaction";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_CLOSE = "\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07";

/** Presentation options for a prompt bubble. */
export interface UserBubbleOptions {
	readonly imageLinks?: readonly (string | undefined)[];
	readonly synthetic?: boolean;
	readonly skillPath?: (name: string) => string | undefined;
	/** Disable shell prompt-zone markers when replaying inside an alternate-screen overlay. */
	readonly promptZones?: boolean;
}

/**
 * Foreground styling for prose inside a user bubble: magic-keyword glow,
 * attachment chips, model chips, and skill pills all restore the bubble's
 * foreground and background before the next markdown token.
 */
export function userBubbleColor(
	options: UserBubbleOptions = {},
	tokenRegex: RegExp = COMPOSER_TOKEN_REGEX,
	activeTheme: Theme = theme,
): (value: string) => string {
	const { imageLinks, synthetic = false, skillPath } = options;
	const keywordReset = activeTheme.getFgOnBgAnsi("userMessageText", "userMessageBg");
	const bubbleReset = `${keywordReset}${activeTheme.getBgAnsi("userMessageBg")}`;
	const renderText = synthetic
		? (text: string) => activeTheme.fg("dim", text)
		: (text: string) =>
				activeTheme.fgOnBg("userMessageText", "userMessageBg", highlightMagicKeywords(text, keywordReset));
	return (value: string) =>
		renderPlaceholders(
			value,
			{
				renderText,
				renderSkill: (label, name) => {
					const styled = skillChipStyle(label, bubbleReset);
					const path = skillPath?.(name);
					return path ? fileHyperlink(path, styled, { line: 1 }) : styled;
				},
				renderMention: label => modelChipStyle(label, bubbleReset),
				renderReference: (label, kind, index, form) => {
					const styled =
						form === "chip"
							? `${attachmentSgr(kind, index)}\x1b[1m${label}\x1b[22m${keywordReset}`
							: activeTheme.fg("accent", `\x1b[1m${label}\x1b[22m`);
					return kind === "image" || kind === "video"
						? imageReferenceHyperlink(label, index, imageLinks, () => styled)
						: styled;
				},
			},
			tokenRegex,
		);
}

/** A direct compatibility badge or a reactive target owned by the transcript. */
export type UserMessageReaction = string | Accessor<string | undefined> | ReactionTarget;

export interface UserMessageViewProps {
	readonly text: string;
	readonly options?: UserBubbleOptions;
	readonly reaction?: UserMessageReaction;
}

/** Paint chip-decorated prose while preserving the surrounding prompt surface style. */
export function paintBubbleProse(out: Out, text: string, base: Style, color: (value: string) => string): void {
	const target: Out = {
		push(style, value) {
			out.push(style.over(base), value);
		},
		raw(style, payload, width, flags) {
			out.raw(style.over(base), payload, width, flags);
		},
		br() {
			out.br();
		},
		cursor() {
			out.cursor();
		},
	};
	parseAnsiRow(color(text), target);
}

/** A retained, document-backed prompt bubble. */
export function UserMessageView(props: UserMessageViewProps): JSX.Element {
	const options = props.options ?? {};
	const { theme: activeTheme } = useTheme();
	let text = collapseImageMarkers(props.text, Number.POSITIVE_INFINITY, () => {});
	const labels: string[] = [];
	MODEL_MENTION_TAG_RE.lastIndex = 0;
	text = text.replace(MODEL_MENTION_TAG_RE, (_tag, _agent: string, name: string) => {
		const label = modelMentionChipLabel(name);
		labels.push(label);
		return label;
	});
	const tokenRegex = composerTokenRegex(labels);
	const document = createDocument(text);
	const bubbleColor = createMemo(() => userBubbleColor(options, tokenRegex, activeTheme()));
	const markdownOptions = createMemo(() => ({
		ignoreTight: true,
		paddingX: 1,
		defaultTextStyle: {
			style: activeTheme().style(options.synthetic ? "dim" : "userMessageText"),
			paintProse: (out: Out, value: string, base: Style) => paintBubbleProse(out, value, base, bubbleColor()),
		},
	}));
	const reaction = () => {
		if (typeof props.reaction === "string") return props.reaction;
		if (typeof props.reaction === "function") return props.reaction();
		return props.reaction?.reaction();
	};
	// The OSC runs must be the first bytes of their visual rows. Keep the
	// horizontal padding in the children rather than on <box>, whose own
	// padding would precede the shell marker and split the background fill.
	return (
		<box background="userMessageBg">
			<row>
				<text grow={1}>
					<Show when={options.promptZones !== false}>
						<raw value={OSC133_ZONE_START} width={0} styleSafe />
					</Show>{" "}
				</text>
				<Show when={reaction()}>{(emoji: () => string) => <text color="accent">{emoji()}</text>}</Show>
				<text> </text>
			</row>
			<markdown document={document} options={markdownOptions()} />
			<text>
				<Show when={options.promptZones !== false}>
					<raw value={OSC133_ZONE_CLOSE} width={0} styleSafe />
				</Show>{" "}
			</text>
		</box>
	);
}

export interface CollapsedSyntheticMessageViewProps {
	readonly text: string;
	readonly expanded: boolean;
	readonly imageLinks?: readonly (string | undefined)[];
	readonly promptZones?: boolean;
}

/** Compact synthetic-input summary whose expensive markdown body is opt-in. */
export function CollapsedSyntheticMessageView(props: CollapsedSyntheticMessageViewProps): JSX.Element {
	return props.expanded ? (
		<UserMessageView
			text={props.text}
			options={{ synthetic: true, imageLinks: props.imageLinks, promptZones: props.promptZones }}
		/>
	) : (
		<row gap={1} color="dim">
			<icon name="cmd.history" />
			<text grow={1} wrap="none" overflow="ellipsis">
				{summarizeSyntheticInput(props.text)}
			</text>
			<text>ctrl+o</text>
		</row>
	);
}

/** One-line label for deferred synthetic transcript inputs. */
export function summarizeSyntheticInput(text: string): string {
	const lineCount = text === "" ? 0 : text.split("\n").length;
	const heading = text.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1] ?? text.split("\n", 1)[0]?.trim() ?? "";
	const label = heading || "Synthetic input";
	return `${label} · ${formatBytes(Buffer.byteLength(text))} · ${lineCount} line${lineCount === 1 ? "" : "s"}`;
}
