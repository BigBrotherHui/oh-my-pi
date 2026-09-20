/**
 * Live composer-shape preview used by settings and setup. It mounts the real
 * retained editor chrome; the preview draft is the only stand-in.
 */
import { CustomEditor, CustomEditorView } from "../prompt/custom-editor";
import { parseColor, Style } from "../core/style";
import { createEffect, type JSX, Show, useTheme, useViewport } from "../reactive";
import { getEditorTheme } from "../theme/tui-adapters";
import { StatusLinePreviewView, type StatusLineLayout, type StatusLineSource } from "../status-line";
import type { ComposerShape } from "./composer-shape-registry";

/** The status presentation source used by the native editor's top/bottom slots. */
export type ComposerPreviewStatusSource = StatusLineSource;

/** Stand-in session title shown while previewing an unnamed session. */
const PREVIEW_TITLE = "omp";
const PREVIEW_PROMPT = "Ask anything, edit files, run tools";

function attachmentLayout(shape: ComposerShape): StatusLineLayout | undefined {
	if (shape === "box") return "box";
	if (shape === "band") return "band";
	if (shape === "claude" || shape === "rule") return "plain-right";
	return undefined;
}

function bottomLayout(shape: ComposerShape): StatusLineLayout | undefined {
	if (shape === "claude" || shape === "rule") return "plain-left";
	if (shape === "box" || shape === "band") return undefined;
	return "plain-full";
}

function PreviewAtShape(props: {
	readonly shape: ComposerShape;
	readonly status?: ComposerPreviewStatusSource;
}): JSX.Element {
	const viewport = useViewport();
	const palette = useTheme().theme;
	const previewWidth = Math.max(24, Math.min(viewport().columns, 96));
	const editorTheme = () => ({
		...getEditorTheme(palette()),
		borderStyle: palette().style("borderAccent"),
		textStyle: Style.of({ fg: parseColor(palette().getColorHex("text")) }),
	});
	const editor = new CustomEditor(editorTheme());
	createEffect(() => {
		editor.setTheme(editorTheme());
		editor.promptGutterStyle = palette().style("accent");
	});
	editor.setBorderStyle(props.shape);
	const topLayout = attachmentLayout(props.shape);
	const bottom = bottomLayout(props.shape);
	const topBorder =
		topLayout && props.status ? (
			<StatusLinePreviewView
				source={props.status}
				layout={topLayout}
				previewTitle={PREVIEW_TITLE}
				naturalWidth={topLayout === "plain-right"}
			/>
		) : undefined;
	return (
		<row>
			<box width={previewWidth}>
				<stack>
					<CustomEditorView
						editor={editor}
						topBorder={topBorder}
						cursor={{ text: "", hidden: true }}
						previewText={PREVIEW_PROMPT}
						tabIndex={-1}
					/>
					{props.shape === "rule" || props.shape === "field" || props.shape === "rail" ? <br /> : null}
					{bottom && props.status ? (
						<StatusLinePreviewView source={props.status} layout={bottom} previewTitle={PREVIEW_TITLE} />
					) : null}
				</stack>
			</box>
		</row>
	);
}

/** Preview body without the settings/setup heading. */
export function ComposerShapePreviewRows(props: {
	readonly shape: ComposerShape;
	readonly status?: ComposerPreviewStatusSource;
}): JSX.Element {
	return (
		<Show when={props.shape || "box"} keyed>
			{(shape: ComposerShape) => <PreviewAtShape shape={shape} status={props.status} />}
		</Show>
	);
}

/** Preview heading and production-equivalent candidate composer chrome. */
export function ComposerShapePreviewView(props: {
	readonly shape: ComposerShape;
	readonly status?: ComposerPreviewStatusSource;
}): JSX.Element {
	return (
		<stack>
			<text color="muted">Preview:</text>
			<ComposerShapePreviewRows {...props} />
		</stack>
	);
}

/** Candidate composer chrome without a settings/setup heading. */
export function renderComposerShapePreview(shape: ComposerShape, status?: ComposerPreviewStatusSource): JSX.Element {
	return <ComposerShapePreviewRows shape={shape} status={status} />;
}
