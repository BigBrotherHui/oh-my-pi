export { createImagePaintState, type ImageBudget, type ImagePaintState } from "../../components/image";
import { getKittyGraphics } from "../../kitty-graphics";
import { getCellDimensions, imageFallback, renderImage, TERMINAL } from "../../terminal-capabilities";
import type { ImageBudget, ImagePaintState } from "../../components/image";
import { visibleWidth } from "../../utils";
import { Clip, Pad, spaces } from "../../core/out";
import { RichText, RunFlag, type Out } from "../../core/richtext";
import { Style } from "../../core/style";
import { Ellipsis } from "@oh-my-pi/pi-natives";
import { forgetPaintSpan, type CommonInputProps } from "../input";
import { registerElement } from "../registry";
import { Damage, type ElementImpl, type HostElement } from "../types";

const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";
const RESERVED_IMAGE_ROW = "\x1b[0m";
const imageRegistrations = Symbol("host.imageRegistrations");
const imageNatural = Symbol("host.imageNatural");

interface ImageStateWithNatural {
	[imageNatural]?: RichText;
}

interface RegisteredImageBudget extends ImageBudget {
	[imageRegistrations]?: Set<number>;
}

/** Props for a retained terminal image. */
export interface ImageElementProps extends CommonInputProps {
	readonly state: ImagePaintState;
}

interface ImageElementState {
	paintState: ImagePaintState;
	budget: ImageBudget | undefined;
	releaseFrameDependency?: () => void;
}

function propsOf(node: HostElement): ImageElementProps {
	return node.props as unknown as ImageElementProps;
}

function registerBudget(node: HostElement, state: ImagePaintState): void {
	const budget = state.budget;
	if (!budget) return;
	if (state.imageId === undefined) state.imageId = budget.acquireId(state.options.imageKey);
	const registered = budget as RegisteredImageBudget;
	registered[imageRegistrations] ??= new Set();
	registered[imageRegistrations].add(node.id);
}

function unregisterBudget(node: HostElement, budget: ImageBudget | undefined): void {
	if (!budget) return;
	const registered = budget as RegisteredImageBudget;
	registered[imageRegistrations]?.delete(node.id);
	if (registered[imageRegistrations]?.size === 0) delete registered[imageRegistrations];
}

/** Number of currently attached image elements registered with a budget. */
export function imageBudgetRegistrationCount(budget: ImageBudget): number {
	return (budget as RegisteredImageBudget)[imageRegistrations]?.size ?? 0;
}

function paintFallback(state: ImagePaintState, out: Out): void {
	const fallback = imageFallback(state.mimeType, state.dimensions, state.options.filename);
	for (let row = 0; row < state.renderedGraphicRows - 1; row++) {
		out.raw(Style.NONE, RESERVED_IMAGE_ROW, 0, RunFlag.Raw);
		out.br();
	}
	out.push(state.theme.fallbackStyle, fallback);
	out.br();
}

function paintProtocolRows(lines: readonly string[], out: Out): void {
	for (const line of lines) {
		out.raw(Style.NONE, line, visibleWidth(line), RunFlag.Raw | RunFlag.Image);
		out.br();
	}
}

function cellBox(
	state: ImagePaintState,
	available: number,
): { width: number; height: number; align: "left" | "center" } | undefined {
	const requested = state.options.cellBox;
	if (requested === undefined) return undefined;
	const width = Number.isFinite(requested.width) ? Math.max(0, Math.min(available, Math.trunc(requested.width))) : 0;
	const height = Number.isFinite(requested.height) ? Math.max(0, Math.trunc(requested.height)) : 0;
	return { width, height, align: requested.align ?? "left" };
}

/** Replay image output inside its requested fixed cell rectangle. */
function paintCellBox(
	source: RichText,
	out: Out,
	box: { width: number; height: number; align: "left" | "center" },
): void {
	const rows = Math.min(box.height, source.rows);
	const top = box.align === "center" ? Math.max(0, (box.height - rows) >> 1) : 0;
	for (let row = 0; row < top; row++) {
		if (box.width > 0) out.push(Style.NONE, spaces(box.width));
		out.br();
	}
	for (let row = 0; row < rows; row++) {
		const padded = new Pad(out, box.width, Style.NONE, box.align);
		const clipped = new Clip(padded, box.width, Ellipsis.Omit);
		source.replayRow(clipped, row);
		clipped.br();
	}
	for (let row = top + rows; row < box.height; row++) {
		if (box.width > 0) out.push(Style.NONE, spaces(box.width));
		out.br();
	}
}

function paintImage(state: ImagePaintState, out: Out, width: number): void {
	const imageProtocol = TERMINAL.imageProtocol;
	const hasProtocol = imageProtocol != null;
	const cellDimensions = getCellDimensions();
	const kittyUnicodePlaceholders = getKittyGraphics().unicodePlaceholders;
	const suppressed = hasProtocol && state.budget !== undefined ? state.budget.observe(state.imageId ?? 0) : false;

	if (
		state.hasCache &&
		state.cachedWidth === width &&
		state.cachedSuppressed === suppressed &&
		state.cachedImageProtocol === imageProtocol &&
		state.cachedCellWidthPx === cellDimensions.widthPx &&
		state.cachedCellHeightPx === cellDimensions.heightPx &&
		state.cachedKittyUnicodePlaceholders === kittyUnicodePlaceholders &&
		(state.imageId == null || state.budget?.shouldTransmit(state.imageId) !== true)
	) {
		state.cache.replay(out);
		return;
	}

	const box = cellBox(state, width);
	const available = box?.width ?? Math.max(0, width - 2);
	const cap = state.options.maxWidthCells;
	const maxWidth = cap != null && cap > 0 ? Math.min(available, cap) : available;
	const maxHeight = box
		? state.options.maxHeightCells === undefined
			? box.height
			: Math.min(box.height, state.options.maxHeightCells)
		: state.options.maxHeightCells;
	const cache = state.cache;
	cache.clear();
	const stateWithNatural: ImagePaintState & ImageStateWithNatural = state;
	const natural = box ? (stateWithNatural[imageNatural] ?? (stateWithNatural[imageNatural] = new RichText())) : cache;
	natural.clear();

	if (hasProtocol && !suppressed) {
		const needsTransmit = state.imageId != null && (state.budget?.shouldTransmit(state.imageId) ?? false);
		const result = renderImage(state.base64Data, state.dimensions, {
			maxWidthCells: maxWidth,
			maxHeightCells: maxHeight,
			imageId: state.imageId,
			includeTransmit: needsTransmit,
		});
		if (result?.transmit && state.imageId != null && state.budget) {
			state.budget.enqueueTransmit(state.imageId, result.transmit);
		}
		if (result?.lines) {
			paintProtocolRows(result.lines, natural);
		} else if (result) {
			if (state.imageId != null && state.budget) {
				state.budget.registerPlacementGeometry(state.imageId, state.dimensions.widthPx, state.dimensions.heightPx);
			}
			for (let row = 0; row < result.rows - 1; row++) {
				natural.raw(Style.NONE, RESERVED_IMAGE_ROW, 0, RunFlag.Raw);
				natural.br();
			}
			const cursorRows = result.rows - 1;
			const moveUp = cursorRows > 0 ? `\x1b[${cursorRows}A` : "";
			const placement = moveUp + (result.sequence ?? "");
			const payload = cursorRows > 0 ? SAVE_CURSOR + placement + RESTORE_CURSOR : placement;
			natural.raw(Style.NONE, payload, 0, RunFlag.Raw | RunFlag.Image);
			natural.br();
		} else {
			paintFallback(state, natural);
		}
		state.renderedGraphicRows = Math.max(state.renderedGraphicRows, natural.rows);
	} else {
		paintFallback(state, natural);
	}
	if (box) {
		natural.finish();
		paintCellBox(natural, cache, box);
	}

	state.hasCache = true;
	state.cachedWidth = width;
	state.cachedSuppressed = suppressed;
	state.cachedImageProtocol = imageProtocol;
	state.cachedCellWidthPx = cellDimensions.widthPx;
	state.cachedCellHeightPx = cellDimensions.heightPx;
	state.cachedKittyUnicodePlaceholders = kittyUnicodePlaceholders;
	cache.replay(out);
}

/** Retained image element implementation. */
export const imageElement: ElementImpl = {
	tag: "image",
	propDamage() {
		return Damage.Layout;
	},
	onAttach(node, context) {
		const paintState = propsOf(node).state;
		registerBudget(node, paintState);
		node.state = {
			paintState,
			budget: paintState.budget,
			releaseFrameDependency: context.trackFrameDependency(node),
		} satisfies ImageElementState;
	},
	onDetach(node) {
		const state = node.state as ImageElementState | undefined;
		state?.releaseFrameDependency?.();
		unregisterBudget(node, state?.budget);
		forgetPaintSpan(node);
		node.state = undefined;
	},
	paint(node, out, width) {
		const paintState = propsOf(node).state;
		let state = node.state as ImageElementState | undefined;
		if (!state) {
			state = { paintState, budget: paintState.budget };
			node.state = state;
		}
		if (state.paintState !== paintState) {
			unregisterBudget(node, state.budget);
			registerBudget(node, paintState);
			state = { paintState, budget: paintState.budget, releaseFrameDependency: state.releaseFrameDependency };
			node.state = state;
		}
		const available = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		paintImage(paintState, out, available);
	},
};

registerElement(imageElement);
