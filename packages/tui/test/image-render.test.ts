import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToRows } from "../src/testing";
import { Style } from "../src/core/style";
import { createImagePaintState, ImageBudget, ImageView } from "@oh-my-pi/pi-tui/components/image";
import { visibleWidth } from "../src/utils";
import type { ImagePaintState } from "@oh-my-pi/pi-tui/components/image";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import type { CellDimensions } from "@oh-my-pi/pi-tui/terminal-capabilities";
import {
	getCellDimensions,
	ImageProtocol,
	isWindowsTerminalPreviewSixelSupported,
	renderImage,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

function setTerminalProtocol(protocol: ImageProtocol | null): void {
	setTerminalImageProtocol(protocol);
}

const BASE64_DUMMY = "AA==";
const SQUARE_DIMENSIONS = { widthPx: 100, heightPx: 100 };
const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
function imageState(
	options: Parameters<typeof createImagePaintState>[0]["options"],
	dimensions = SQUARE_DIMENSIONS,
): ImagePaintState {
	return createImagePaintState({
		base64Data: BASE64_ONE_PIXEL_PNG,
		mimeType: "image/png",
		theme: { fallbackStyle: Style.NONE },
		options,
		dimensions,
	});
}

function imageRows(state: ImagePaintState, width: number): string[] {
	return renderToRows(() => ImageView({ state }), width);
}

function parseKittyParam(sequence: string, key: "c" | "r" | "C"): number | null {
	const match = sequence.match(new RegExp(`${key}=(\\d+)`));
	if (!match) return null;
	return Number.parseInt(match[1], 10);
}

function parseITermWidth(sequence: string): string | null {
	const match = sequence.match(/width=([^;:]+)/);
	return match?.[1] ?? null;
}

describe("terminal image rendering", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalCellDims: CellDimensions;
	const originalGraphics = { ...getKittyGraphics() };

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		setTerminalProtocol(null);
		setKittyGraphics({ unicodePlaceholders: false });
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		setTerminalProtocol(originalProtocol);
		setKittyGraphics(originalGraphics);
	});

	it("fits Kitty images within max width and max height while preserving aspect ratio", () => {
		setTerminalProtocol(ImageProtocol.Kitty);
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(2);
		expect(parseKittyParam(result?.sequence ?? "", "c")).toBe(2);
		expect(parseKittyParam(result?.sequence ?? "", "r")).toBe(2);
	});

	it("anchors Kitty display commands before renderer-managed cursor movement", () => {
		setTerminalProtocol(ImageProtocol.Kitty);
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(parseKittyParam(result?.sequence ?? "", "C")).toBe(1);
	});

	it("re-renders a cached fallback once an image protocol becomes available", () => {
		const image = imageState({ maxWidthCells: 10, maxHeightCells: 2 });

		expect(imageRows(image, 20).join("")).toContain("[Image:");

		setTerminalProtocol(ImageProtocol.Kitty);
		const rerendered = imageRows(image, 20).join("");

		expect(rerendered).toContain("\x1b_Ga=T");
		expect(rerendered).toContain("C=1");
	});

	it("re-renders a cached image when cell dimensions change", () => {
		setTerminalProtocol(ImageProtocol.Kitty);
		const image = imageState({ maxWidthCells: 10, maxHeightCells: 10 });

		const first = imageRows(image, 20).join("");
		expect(parseKittyParam(first, "c")).toBe(10);

		setCellDimensions({ widthPx: 20, heightPx: 10 });
		const second = imageRows(image, 20).join("");

		expect(parseKittyParam(second, "c")).toBe(5);
	});

	it("centers protocol images in a fixed cell box and clips the box to its parent", () => {
		setTerminalProtocol(ImageProtocol.Kitty);
		setKittyGraphics({ unicodePlaceholders: true });
		const image = imageState({
			budget: new ImageBudget(),
			imageKey: "fixed-cell-box",
			cellBox: { width: 12, height: 4, align: "center" },
		});

		const full = imageRows(image, 12);
		expect(full).toHaveLength(4);
		expect(full.every(row => visibleWidth(row) === 12)).toBe(true);
		expect(full.join("")).toContain("U=1");

		const clipped = imageRows(image, 7);
		expect(clipped).toHaveLength(4);
		expect(clipped.every(row => visibleWidth(row) === 7)).toBe(true);
	});

	it("re-renders a cached Kitty image when Unicode placeholder support changes", () => {
		setTerminalProtocol(ImageProtocol.Kitty);
		setKittyGraphics({ unicodePlaceholders: false });
		const budget = new ImageBudget(1, () => {});
		const image = imageState({ budget, imageKey: "placeholder-cache", maxWidthCells: 10, maxHeightCells: 2 });

		const direct = imageRows(image, 20).join("");
		expect(direct).toContain("\x1b_Ga=p");

		setKittyGraphics({ unicodePlaceholders: true });
		const placeholder = imageRows(image, 20).join("");

		expect(placeholder).toContain("U=1");
		expect(placeholder).not.toBe(direct);
	});

	it("uses intrinsic image size when no bounds are provided", () => {
		setTerminalProtocol(ImageProtocol.Kitty);
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS);

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(10);
		expect(parseKittyParam(result?.sequence ?? "", "c")).toBe(10);
		expect(parseKittyParam(result?.sequence ?? "", "r")).toBe(10);
	});

	it("transmits stable Kitty images in-band before placement", () => {
		setTerminalProtocol(ImageProtocol.Kitty);
		const result = renderImage(BASE64_ONE_PIXEL_PNG, SQUARE_DIMENSIONS, {
			imageId: 42,
			includeTransmit: true,
		});

		expect(result).not.toBeNull();
		expect(result?.transmit).toBe(`\x1b_Ga=t,f=100,q=2,i=42;${BASE64_ONE_PIXEL_PNG}\x1b\\`);
		expect(result?.transmit).not.toContain("t=t");
	});

	it("reduces iTerm2 width when max height is the limiting bound", () => {
		setTerminalProtocol(ImageProtocol.Iterm2);
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(2);
		expect(parseITermWidth(result?.sequence ?? "")).toBe("2");
		expect(result?.sequence).toContain("height=auto");
	});

	it("encodes SIXEL output when protocol is SIXEL", () => {
		setTerminalProtocol(ImageProtocol.Sixel);
		const result = renderImage(BASE64_ONE_PIXEL_PNG, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		// SIXEL height is rounded DOWN to a multiple of 6 (band size) so it
		// never exceeds the caller's maxHeightCells cap. With 10px cells and
		// maxHeightCells=2, targetHeightPx=18 (not 20), rows=2 — within cap.
		expect(result?.rows).toBe(2);
		expect((result?.sequence ?? "").startsWith("\x1bP")).toBe(true);
	});

	it("moves back up before multi-row direct Kitty output and restores the cursor below it", () => {
		setTerminalProtocol(ImageProtocol.Kitty);
		const image = imageState({ maxWidthCells: 10, maxHeightCells: 3 });

		const lines = imageRows(image, 20);
		const imageLine = lines.at(-1) ?? "";

		expect(lines).toHaveLength(3);
		expect(lines.slice(0, -1)).toEqual(["\x1b[0m", "\x1b[0m"]);
		expect(imageLine.startsWith("\x1b7\x1b[2A")).toBe(true);
		expect(imageLine).toContain("\x1b_Ga=T");
		expect(imageLine).toContain("C=1");
		expect(imageLine).toContain("c=3");
		expect(imageLine).toContain("r=3");
		expect(imageLine.endsWith("\x1b8")).toBe(true);
	});

	it("does not emit cursor movement around single-row direct Kitty output", () => {
		setTerminalProtocol(ImageProtocol.Kitty);
		const image = imageState({ maxWidthCells: 10, maxHeightCells: 1 });

		const lines = imageRows(image, 20);
		const imageLine = lines.at(-1) ?? "";

		expect(lines).toHaveLength(1);
		expect(imageLine.startsWith("\x1b_Ga=T")).toBe(true);
		expect(imageLine).toContain("C=1");
		expect(imageLine).toContain("c=1");
		expect(imageLine).toContain("r=1");
		expect(imageLine.endsWith("\x1b\\")).toBe(true);
		expect(imageLine).not.toContain("\x1b[0A");
		expect(imageLine).not.toContain("\x1b[0B");
		expect(imageLine).not.toMatch(/\x1b\[\d+[AB]/);
	});
});

describe("Windows Terminal Preview SIXEL detection", () => {
	it("requires Windows platform, WT session, and known version 1.22+", () => {
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.22.2362.0" },
				"win32",
			),
		).toBe(true);
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.21.0.0" },
				"win32",
			),
		).toBe(false);
		expect(
			isWindowsTerminalPreviewSixelSupported({ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal" }, "win32"),
		).toBe(false);
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.22.2362.0" },
				"linux",
			),
		).toBe(false);
	});
});

describe("isImageLine — composed placeholder rows", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	afterEach(() => {
		setTerminalProtocol(originalProtocol);
	});

	it("keeps deeply prefixed Kitty placeholder rows on the verbatim image-line path", () => {
		setTerminalProtocol(ImageProtocol.Kitty);
		// Composer attachment chip interior row: border SGR + │ + reset + pad +
		// image-id fg + placement-id underline put the first placeholder cell at
		// code unit 63 — past the old 64-unit needle window, which silently sent
		// the row through SGR coalescing/truncation instead of verbatim output.
		const cells = "\u{10eeee}\u030d\u0305".repeat(9);
		const chipRow = `\x1b[38;2;255;179;102m│\x1b[39m \x1b[38;2;122;231;55m\x1b[58:2::122:231:55m${cells}\x1b[39;59m  \x1b[38;2;255;179;102m│\x1b[39m`;
		expect(TERMINAL.isImageLine(chipRow)).toBe(true);
		// Second card in the band: the needle sits hundreds of units in.
		const secondCard = `${chipRow}  ${chipRow}`;
		expect(TERMINAL.isImageLine(secondCard.slice(chipRow.length + 2))).toBe(true);
		expect(TERMINAL.isImageLine(secondCard)).toBe(true);
	});

	it("still rejects plain styled text rows", () => {
		setTerminalProtocol(ImageProtocol.Kitty);
		expect(TERMINAL.isImageLine("\x1b[38;2;255;179;102m│\x1b[39m plain text row")).toBe(false);
	});
});
