import {
	DIM_OFF,
	DIM_ON,
	geometry,
	isShapeVariantName,
	normalize,
	renderMany,
	resolveShape,
	SHAPE_VARIANT_NAMES,
	SHAPE_VARIANTS,
	type Shape,
	type ShapeTarget,
	type ShapeVariantName,
} from "@oh-my-pi/snapcompact";
import { createEffect, createMemo, createSignal, onCleanup, useTheme, type Accessor, type JSX } from "../reactive";
import { createImagePaintState, type ImageBudget } from "../components/image";
import { getKittyGraphics } from "../kitty-graphics";
import { ImageProtocol, TERMINAL } from "../terminal-capabilities";

/** Mini-frame edge in px — a small page from the real rasterizer ≈ a zoomed crop. */
const SRC_FRAME_PX = 128;
/** Nearest-neighbor upscale factor; keeps glyph pixels crisp on HiDPI cell boxes. */
const ZOOM_SCALE = 4;
/** Display box in terminal cells (square-ish at the typical 1:2 cell aspect). */
const MAX_IMAGE_COLS = 28;
const MAX_IMAGE_ROWS = 14;

/** Sample transcript with `<out>…</out>` bodies wrapped in dim-ink toggles. */
const SAMPLE_DOCUMENT = `¶user:Fix the settings overlay crash. Wheeling past the last row throws.

¶call:read(path="src/select-list.ts:140-180")//Reading the select-list hit test
<out>
162: const index = Math.floor(line / rowHeight); index is never checked against bounds.
</out>

¶ai:Found it. The hit test indexes past the filtered list; clamping to the last row fixes the crash.

¶user:Does the fix survive filtering?

¶think:Check whether the clamp runs before or after filtering.

¶ai:Yes. The clamp applies after the filter pass, so a narrowed list keeps the hit map in sync. Added a regression test that wheels past the last row with a filter active and asserts no throw.`;
const PREVIEW_TEXT = SAMPLE_DOCUMENT.replace(
	/<out>\n([\s\S]*?)\n<\/out>/g,
	(_match, body: string) => `<out>\n${DIM_ON}${body}${DIM_OFF}\n</out>`,
);

type PreviewEntry =
	| { readonly state: "rendering" }
	| { readonly state: "failed" }
	| { readonly state: "ready"; readonly data: string; readonly edgePx: number };

export interface SnapcompactShapePreviewViewProps {
	/** Highlighted choice; `auto` resolves against the active model. */
	readonly value: Accessor<string>;
	/** Active model (api + id); resolves what `auto` maps to for this reader. */
	readonly model?: ShapeTarget;
	/** Shared TUI image budget: stable graphics ids, transmit-once, exit cleanup. */
	readonly imageBudget?: ImageBudget;
}

interface SnapcompactShapePreviewRowsProps {
	readonly entry: PreviewEntry | undefined;
	readonly shape: Shape;
	readonly name: ShapeVariantName;
	readonly selected: ShapeVariantName | "auto";
	readonly imageBudget: ImageBudget | undefined;
	readonly width: number;
}

/**
 * Live preview for the `snapcompact.shape` setting. It renders a sample session
 * through the real rasterizer as a miniature page, then nearest-neighbour scales
 * it so cell size, ink hues, highlight bands, and dim tool-result spans remain
 * legible at terminal scale.
 */
export function SnapcompactShapePreviewView(props: SnapcompactShapePreviewViewProps): JSX.Element {
	const [entries, setEntries] = createSignal<ReadonlyMap<ShapeVariantName, PreviewEntry>>(new Map());
	const selected = createMemo<ShapeVariantName | "auto">(() => {
		const value = props.value();
		return isShapeVariantName(value) ? value : "auto";
	});
	const shape = createMemo(() => resolveShape(props.model, selected()));
	const name = createMemo(() => resolvedVariantName(shape()));
	const entry = createMemo(() => entries().get(name()));
	let disposed = false;

	const replaceEntry = (variant: ShapeVariantName, next: PreviewEntry): void => {
		setEntries(current => {
			const updated = new Map(current);
			updated.set(variant, next);
			return updated;
		});
	};

	const buildEntry = async (variant: ShapeVariantName, selectedShape: Shape): Promise<void> => {
		try {
			// Fill the mini-page so every variant shows a fully inked window.
			const capacity = geometry(selectedShape, SRC_FRAME_PX).capacity;
			let text = PREVIEW_TEXT;
			while (normalize(text).length < capacity) text += ` ${PREVIEW_TEXT}`;
			const frame = (await renderMany(text, { shape: selectedShape, frameSize: SRC_FRAME_PX, maxFrames: 1 }))[0];
			if (!frame) throw new Error("empty sample frame");
			const edgePx = SRC_FRAME_PX * ZOOM_SCALE;
			const zoomed = await new Bun.Image(Buffer.from(frame.data, "base64"))
				.resize(edgePx, edgePx, { filter: "nearest" })
				.png()
				.bytes();
			if (!disposed) replaceEntry(variant, { state: "ready", data: zoomed.toBase64(), edgePx });
		} catch {
			if (!disposed) replaceEntry(variant, { state: "failed" });
		}
	};

	createEffect(() => {
		const variant = name();
		const selectedShape = shape();
		if (!props.imageBudget || !TERMINAL.imageProtocol || entries().has(variant)) return;
		replaceEntry(variant, { state: "rendering" });
		void buildEntry(variant, selectedShape);
	});
	onCleanup(() => {
		disposed = true;
	});

	return (
		<sized
			key={`${selected()}:${name()}:${entry()?.state ?? "rendering"}`}
			paint={width => (
				<SnapcompactShapePreviewRows
					entry={entry()}
					shape={shape()}
					name={name()}
					selected={selected()}
					imageBudget={props.imageBudget}
					width={width}
				/>
			)}
		/>
	);
}

function SnapcompactShapePreviewRows(props: SnapcompactShapePreviewRowsProps): JSX.Element {
	const { theme } = useTheme();
	const geo = geometry(props.shape);
	const label = props.selected === "auto" ? `auto → ${props.name}` : props.name;
	const chars = geo.capacity >= 1000 ? `${(geo.capacity / 1000).toFixed(1)}k` : String(geo.capacity);
	const tokens =
		props.shape.frameTokenEstimate >= 1000
			? `${(props.shape.frameTokenEstimate / 1000).toFixed(1)}k`
			: String(props.shape.frameTokenEstimate);
	const stats = `full frame ${geo.cols}×${geo.rows} cells ≈ ${chars} chars ≈ ${tokens} tokens`;
	const imageWidth = Math.max(8, Math.min(MAX_IMAGE_COLS, props.width - 4));
	const canRenderGraphic = props.imageBudget !== undefined && TERMINAL.imageProtocol !== null;
	const supportsPlaceholder = TERMINAL.imageProtocol === ImageProtocol.Kitty && getKittyGraphics().unicodePlaceholders;

	let body: JSX.Element;
	if (!canRenderGraphic) {
		body = (
			<text color="dim" wrap="overflow">
				{" "}
				(graphic sample needs a Kitty-graphics terminal)
			</text>
		);
	} else if (!supportsPlaceholder) {
		body = (
			<text color="dim" wrap="overflow">
				{" "}
				(graphic sample needs Kitty unicode-placeholder graphics)
			</text>
		);
	} else if (!props.entry || props.entry.state === "rendering") {
		body = (
			<text color="dim" wrap="overflow">
				{" "}
				rendering sample…
			</text>
		);
	} else if (props.entry.state === "failed") {
		body = (
			<text color="dim" wrap="overflow">
				{" "}
				(sample render failed)
			</text>
		);
	} else {
		body = (
			<box padding={{ x: 2, y: 0 }}>
				<image
					state={createImagePaintState({
						base64Data: props.entry.data,
						mimeType: "image/png",
						dimensions: { widthPx: props.entry.edgePx, heightPx: props.entry.edgePx },
						theme: { fallbackStyle: theme().style("dim") },
						options: {
							maxWidthCells: imageWidth,
							maxHeightCells: MAX_IMAGE_ROWS,
							budget: props.imageBudget,
							imageKey: `snapshape:${props.name}:${props.entry.edgePx}`,
						},
					})}
				/>
			</box>
		);
	}

	return (
		<stack>
			<text color="muted" wrap="overflow">
				{" "}
				Sample (zoomed) · {label} · {stats}
			</text>
			<br />
			{body}
		</stack>
	);
}

/** Resolve the concrete table variant picked for `auto`. */
function resolvedVariantName(shape: Shape): ShapeVariantName {
	for (const name of SHAPE_VARIANT_NAMES) {
		const candidate = SHAPE_VARIANTS[name];
		if (
			candidate.font === shape.font &&
			candidate.cellWidth === shape.cellWidth &&
			candidate.cellHeight === shape.cellHeight &&
			candidate.variant === shape.variant &&
			candidate.lineRepeat === shape.lineRepeat &&
			candidate.frameSize === shape.frameSize
		) {
			return name;
		}
	}
	return "5x8-sent";
}
