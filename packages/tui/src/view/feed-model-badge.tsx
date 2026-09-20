import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { createMemo, Show, useTheme, type JSX } from "../reactive";
import { FEED_MODEL_BADGE_WIDTH } from "../render/render-utils";

/** Resolved effort displayed beside a model identity in activity feeds. */
export type FeedModelThinkingLevel = ThinkingLevel | "auto";

/** Model identity and execution qualifiers for a native one-line feed badge. */
export interface FeedModelBadgeProps {
	readonly modelIdentity?: string;
	readonly thinkingLevel?: FeedModelThinkingLevel;
	readonly advisor?: boolean;
}

/** Render the compact resolved-model badge with native clipping and reactive theme symbols. */
export function FeedModelBadge(props: FeedModelBadgeProps): JSX.Element {
	const theme = useTheme();
	const identity = createMemo(() =>
		sanitizeText(props.modelIdentity ?? "")
			.replace(/\s+/gu, " ")
			.trim(),
	);
	const glyph = createMemo(() => {
		const level = props.thinkingLevel;
		if (level === undefined || level === ThinkingLevel.Inherit) return "";
		if (level === ThinkingLevel.Off) return theme.symbol("status.disabled");
		return theme.theme().thinking[level === "auto" ? "autoPending" : level].split(" ")[0] ?? "";
	});
	return (
		<Show when={identity()}>
			<text maxWidth={FEED_MODEL_BADGE_WIDTH} minWidth={0} shrink={2} wrap="none" overflow="ellipsis" color="dim">
				{glyph() ? `${glyph()} ` : ""}
				{identity()}
				{props.advisor ? ` ${theme.symbol("icon.advisor")}` : ""}
			</text>
		</Show>
	);
}
