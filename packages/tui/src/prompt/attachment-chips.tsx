import type { ImageContent } from "@oh-my-pi/pi-ai/types";
import {
	createGenerationGuard,
	createMemo,
	createSignal,
	For,
	Show,
	type Accessor,
	type JSX,
	useTheme,
	useViewport,
} from "../reactive";
import { getImageDimensions, ImageProtocol, TERMINAL } from "../terminal-capabilities";
import { getKittyGraphics } from "../kitty-graphics";
import { createImagePaintState, type ImageBudget, type ImagePaintState } from "../components/image";
import { replaceTabs, visibleWidth } from "../utils";
import { convertImageToPng } from "../chat/image-loading";
import { Attr, rgb, Style, type Color } from "../core/style";
import { fileHyperlinkStyle } from "../render/hyperlink";
import { attachmentRgb } from "./composer-attachments";
import { cachedImageDimensions, setCachedImageDimensions } from "./image-references";
import type { ComposerChipDescriptor } from "./custom-editor";

/** Chip card geometry (mirrors omp2): a 12x4 content area inside a 1-cell rounded border. */
const INNER_COLS = 12;
const INNER_ROWS = 4;
const INTERIOR_ROW_INDEXES = [0, 1, 2, 3];
const CARD_COLS = INNER_COLS + 2;
const CARD_GAP = 2;

/** PNG conversion state belongs to the image, rather than a transient card node. */
const kImagePng = Symbol("omp.imagePng");

type ImagePngState =
	| { readonly kind: "pending"; readonly result: Promise<ImageContent | null> }
	| { readonly kind: "ready"; readonly result: ImageContent | null };

declare module "@oh-my-pi/pi-ai/types" {
	interface ImageContent {
		[kImagePng]?: ImagePngState;
	}
}

export interface AttachmentChipsStore {
	readonly chips: Accessor<readonly ComposerChipDescriptor[]>;
	setChips(chips: readonly ComposerChipDescriptor[]): void;
}

/** Own the reactive attachment snapshot displayed immediately above the editor. */
export function createAttachmentChipsStore(initial: readonly ComposerChipDescriptor[] = []): AttachmentChipsStore {
	const [chips, setChips] = createSignal(initial);
	return { chips, setChips };
}

export interface AttachmentChipsViewProps {
	readonly store: AttachmentChipsStore;
	/** Shared TUI graphics budget. The composer must supply its live budget. */
	readonly budget: ImageBudget;
}

function attachmentColor(kind: ComposerChipDescriptor["kind"], n: number): Color {
	const [red, green, blue] = attachmentRgb(kind, n);
	return rgb(red, green, blue);
}

function clippedPlain(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width === 1) return "…";
	let result = "";
	for (const char of text) {
		if (visibleWidth(result + char) > width - 1) break;
		result += char;
	}
	return `${result}…`;
}

/** Pixel dimensions are probed once from the image header and retained with the draft image. */
function imageDimensions(image: ImageContent): { width: number; height: number } | null {
	let dimensions = cachedImageDimensions(image);
	if (dimensions === undefined) {
		const probed = getImageDimensions(image.data, image.mimeType);
		dimensions = probed ? { width: probed.widthPx, height: probed.heightPx } : null;
		setCachedImageDimensions(image, dimensions);
	}
	return dimensions;
}

/**
 * Resolve a PNG for Kitty's f=100 transmit without retaining a detached card's
 * repaint callback. Every attached waiter gets a completion notification; stale
 * waiters are rejected by the card's generation guard.
 */
function kittyDisplayImage(image: ImageContent, onReady: () => void): ImageContent | undefined {
	if (image.mimeType === "image/png") return image;
	const existing = image[kImagePng];
	if (existing?.kind === "ready") return existing.result ?? undefined;
	if (existing?.kind === "pending") {
		void existing.result.then(converted => {
			image[kImagePng] = { kind: "ready", result: converted };
			onReady();
		});
		return undefined;
	}
	const pending = convertImageToPng(image).then(
		converted => converted,
		() => null,
	);
	image[kImagePng] = { kind: "pending", result: pending };
	void pending.then(converted => {
		image[kImagePng] = { kind: "ready", result: converted };
		onReady();
	});
	return undefined;
}

function BorderRow(props: {
	readonly color: Color;
	readonly caption: string;
	readonly edge: "top" | "bottom";
	readonly link?: string;
}): JSX.Element {
	const { theme } = useTheme();
	const symbols = theme().boxRound;
	const left = props.edge === "top" ? symbols.topLeft : symbols.bottomLeft;
	const right = props.edge === "top" ? symbols.topRight : symbols.bottomRight;
	if (!props.caption) {
		return (
			<text wrap="none" color={props.color}>
				{left}
				{symbols.horizontal.repeat(INNER_COLS)}
				{right}
			</text>
		);
	}
	const caption = clippedPlain(props.caption, INNER_COLS - 2);
	const fill = Math.max(0, INNER_COLS - visibleWidth(caption) - 2);
	const leftFill = fill >> 1;
	const rightFill = fill - leftFill;
	const titleStyle = Style.of({ fg: props.color, attrs: Attr.Bold });
	const linkedTitleStyle = props.link ? fileHyperlinkStyle(props.link, undefined, titleStyle) : titleStyle;
	return (
		<text wrap="none" color={props.color}>
			{left}
			{symbols.horizontal.repeat(leftFill)} <span style={linkedTitleStyle}>{caption}</span>{" "}
			{symbols.horizontal.repeat(rightFill)}
			{right}
		</text>
	);
}

function InteriorRow(props: { readonly color: Color; readonly children?: JSX.Element }): JSX.Element {
	const { theme } = useTheme();
	const vertical = theme().boxRound.vertical;
	return (
		<text wrap="none">
			<span color={props.color}>{vertical}</span>
			{props.children}
			<span color={props.color}>{vertical}</span>
		</text>
	);
}

function MutedInterior(props: { readonly text: string; readonly align?: "left" | "center" }): JSX.Element {
	const clipped = clippedPlain(props.text, INNER_COLS);
	const remaining = Math.max(0, INNER_COLS - visibleWidth(clipped));
	const left = props.align === "center" ? remaining >> 1 : 0;
	return (
		<>
			{left > 0 ? " ".repeat(left) : null}
			<span color="muted">{clipped}</span>
			{remaining - left > 0 ? " ".repeat(remaining - left) : null}
		</>
	);
}

function TextCard(props: { readonly chip: Extract<ComposerChipDescriptor, { kind: "paste" }> }): JSX.Element {
	const { theme } = useTheme();
	const chip = props.chip;
	const color = attachmentColor(chip.kind, chip.n);
	const icon = theme().symbol("chip.paste");
	const lines = chip.text.content.split("\n");
	const caption = chip.text.lineCount > 1 ? `+${chip.text.lineCount} lines` : `${chip.text.charCount} chars`;
	return (
		<stack width={CARD_COLS} minWidth={CARD_COLS} maxWidth={CARD_COLS} grow={0} shrink={0}>
			<BorderRow color={color} caption={`${icon} #${chip.n}`} edge="top" />
			<For each={INTERIOR_ROW_INDEXES}>
				{row => (
					<InteriorRow color={color}>
						<MutedInterior text={replaceTabs(lines[row] ?? "")} />
					</InteriorRow>
				)}
			</For>
			<BorderRow color={color} caption={caption} edge="bottom" />
		</stack>
	);
}

function ImageSide(props: { readonly color: Color }): JSX.Element {
	const { theme } = useTheme();
	const vertical = theme().boxRound.vertical;
	return (
		<stack width={1} minWidth={1} maxWidth={1} grow={0} shrink={0}>
			<For each={INTERIOR_ROW_INDEXES}>
				{() => (
					<text wrap="none" color={props.color}>
						{vertical}
					</text>
				)}
			</For>
		</stack>
	);
}

function ImageFallback(props: { readonly icon: string }): JSX.Element {
	return (
		<stack width={INNER_COLS} minWidth={INNER_COLS} maxWidth={INNER_COLS} grow={0} shrink={0}>
			<For each={INTERIOR_ROW_INDEXES}>
				{row => (
					<text wrap="none">
						<MutedInterior text={row === 1 ? props.icon : ""} align="center" />
					</text>
				)}
			</For>
		</stack>
	);
}

function ImageCard(props: {
	readonly chip: Extract<ComposerChipDescriptor, { kind: "image" | "video" }>;
	readonly budget: ImageBudget;
}): JSX.Element {
	const { theme } = useTheme();
	const [imageRevision, setImageRevision] = createSignal(0);
	const guard = createGenerationGuard();
	const chip = props.chip;
	const color = attachmentColor(chip.kind, chip.n);
	const icon = theme().symbol(chip.kind === "video" ? "chip.video" : "chip.image");
	const dimensions = imageDimensions(chip.image);
	const image = createMemo((): ImagePaintState | undefined => {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty || !getKittyGraphics().unicodePlaceholders) return undefined;
		const generation = guard.next();
		imageRevision();
		const display = kittyDisplayImage(chip.image, () => {
			guard.commit(generation, () => setImageRevision(revision => revision + 1));
		});
		if (!display) return undefined;
		return createImagePaintState({
			base64Data: display.data,
			mimeType: display.mimeType,
			dimensions: dimensions ? { widthPx: dimensions.width, heightPx: dimensions.height } : undefined,
			theme: { fallbackStyle: theme().style("muted") },
			options: {
				maxWidthCells: INNER_COLS,
				maxHeightCells: INNER_ROWS,
				cellBox: { width: INNER_COLS, height: INNER_ROWS, align: "center" },
				budget: props.budget,
				imageKey: `chip:${display.mimeType}:${display.data.length}:${display.data.slice(0, 32)}`,
			},
		});
	});
	return (
		<stack width={CARD_COLS} minWidth={CARD_COLS} maxWidth={CARD_COLS} grow={0} shrink={0}>
			<BorderRow color={color} caption={`${icon} #${chip.n}`} edge="top" link={chip.link} />
			<row gap={0} width={CARD_COLS} minWidth={CARD_COLS} maxWidth={CARD_COLS} grow={0} shrink={0}>
				<ImageSide color={color} />
				<Show when={image()} fallback={<ImageFallback icon={icon} />}>
					{(state: Accessor<ImagePaintState>) => <image state={state()} />}
				</Show>
				<ImageSide color={color} />
			</row>
			<BorderRow
				color={color}
				caption={dimensions ? `${dimensions.width}x${dimensions.height}` : ""}
				edge="bottom"
			/>
		</stack>
	);
}

function AttachmentCard(props: { readonly chip: ComposerChipDescriptor; readonly budget: ImageBudget }): JSX.Element {
	return props.chip.kind === "paste" ? (
		<TextCard chip={props.chip} />
	) : (
		<ImageCard chip={props.chip} budget={props.budget} />
	);
}

/**
 * Reactive composer attachment band. It reflects the editor's chip snapshot:
 * deleting an inline token removes its card, while the editor retains token
 * selection/removal semantics. Cards that cannot fit stay omitted rather than
 * wrapping below the editor.
 */
export function AttachmentChipsView(props: AttachmentChipsViewProps): JSX.Element {
	const viewport = useViewport();
	const visible = createMemo(() => {
		const chips = props.store.chips();
		const count = Math.min(
			chips.length,
			Math.max(0, Math.floor((viewport().columns + CARD_GAP) / (CARD_COLS + CARD_GAP))),
		);
		return chips.slice(0, count);
	});
	return (
		<Show when={visible().length > 0}>
			<row gap={CARD_GAP}>
				<For each={visible()}>{chip => <AttachmentCard chip={chip} budget={props.budget} />}</For>
			</row>
		</Show>
	);
}
