import { type JSX, useTheme } from "../reactive";
import { expandKeyHint } from "../render/render-utils";
import { replaceTabs, wrapTextWithAnsi } from "../utils";

/** Max wrapped rows of the error message shown in the pinned banner. */
const MAX_BANNER_ROWS = 4;
const CONTINUATION_INDENT = "  ";

interface ErrorBannerMessageProps {
	readonly message: string;
	readonly maxRows: number;
}

function ErrorBannerDismiss(props: { readonly text: string }): JSX.Element {
	return (
		<sized
			paint={width => (
				<stack>
					{wrapTextWithAnsi(props.text, Math.max(1, width - 1)).map((line, index) => (
						<text wrap="none">
							<span color={index > 0 ? "dim" : undefined}> </span>
							<span color="dim">{line}</span>
						</text>
					))}
				</stack>
			)}
		/>
	);
}

function ErrorBannerMessage(props: ErrorBannerMessageProps): JSX.Element {
	const palette = useTheme();
	return (
		<sized
			paint={width => {
				const logical = replaceTabs(props.message.replace(/\r\n?/g, "\n"))
					.split("\n")
					.map(line => line.trim())
					.filter(line => line.length > 0);
				if (logical.length === 0) logical.push("Unknown error");

				const wrapped: Array<{ text: string; continuation: boolean }> = [];
				for (let index = 0; index < logical.length; index++) {
					const prefix = index === 0 ? `${palette.theme().status.error} ` : "";
					const lines = wrapTextWithAnsi(
						prefix + logical[index]!,
						Math.max(1, width - CONTINUATION_INDENT.length),
					);
					for (let line = 0; line < lines.length; line++) {
						wrapped.push({ text: lines[line] ?? "", continuation: line > 0 });
					}
				}

				const hidden = Math.max(0, wrapped.length - props.maxRows);
				return (
					<stack>
						{wrapped.slice(0, props.maxRows).map((line, index) => (
							<text wrap="none">
								{index > 0 ? (
									<span color={line.continuation ? "error" : undefined}>{CONTINUATION_INDENT}</span>
								) : null}
								<span color="error" bold={index === 0}>
									{line.text}
								</span>
							</text>
						))}
						{hidden > 0 ? (
							<text color="dim" wrap="none">
								{`${CONTINUATION_INDENT}… +${hidden} more line${hidden === 1 ? "" : "s"} (${expandKeyHint()} to expand)`}
							</text>
						) : null}
					</stack>
				);
			}}
		/>
	);
}

export interface ErrorBannerViewProps {
	readonly message: string;
}

/** Persistent provider-error banner pinned above the editor. */
export function ErrorBannerView(props: ErrorBannerViewProps): JSX.Element {
	const palette = useTheme();
	return (
		<stack>
			<br />
			<hr char={palette.theme().boxRound.horizontal} ruleColor={palette.theme().fgColor("error")} />
			<box padding={{ x: 1 }}>
				<ErrorBannerMessage message={props.message} maxRows={MAX_BANNER_ROWS} />
			</box>
			<ErrorBannerDismiss text="Dismissed when you send your next message." />
			<hr char={palette.theme().boxRound.horizontal} ruleColor={palette.theme().fgColor("error")} />
		</stack>
	);
}
