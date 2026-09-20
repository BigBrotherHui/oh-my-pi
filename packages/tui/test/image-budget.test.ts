import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Style } from "@oh-my-pi/pi-tui";
import { createImagePaintState, ImageBudget, ImageView } from "@oh-my-pi/pi-tui/components/image";
import type { ImagePaintState } from "@oh-my-pi/pi-tui/components/image";
import { createComponent, createElement, insert } from "../src/host/renderer";
import { Portal } from "../src/host/overlay";
import { createSignal } from "../src/reactive";
import type { JSX } from "../src/reactive";
import { render } from "../src/root";
import { renderToRows } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";
import {
	encodeKittyVirtualPlacement,
	getKittyGraphics,
	KITTY_PLACEHOLDER,
	setKittyGraphics,
} from "@oh-my-pi/pi-tui/kitty-graphics";
import type { CellDimensions, TerminalId } from "@oh-my-pi/pi-tui/terminal-capabilities";
import {
	encodeKitty,
	encodeKittyDeleteImage,
	encodeKittyPlacement,
	encodeKittyTransmit,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
	wrapTmuxPassthrough,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

import { VirtualTerminal } from "./virtual-terminal";

const testTheme = loadThemeSync("dark");

function setTerminalProtocol(protocol: ImageProtocol | null): void {
	setTerminalImageProtocol(protocol);
}

function overrideTerminalId(id: TerminalId): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(TERMINAL, "id");
	Object.defineProperty(TERMINAL, "id", { configurable: true, value: id });
	return () => {
		if (descriptor) Object.defineProperty(TERMINAL, "id", descriptor);
	};
}

function imageState(
	budget: ImageBudget,
	imageKey: string,
	options: { maxWidthCells?: number; maxHeightCells?: number } = { maxWidthCells: 4, maxHeightCells: 4 },
	dimensions?: { widthPx: number; heightPx: number },
): ImagePaintState {
	return createImagePaintState({
		base64Data: BASE64_ONE_PIXEL_PNG,
		mimeType: "image/png",
		theme: { fallbackStyle: Style.NONE },
		options: { ...options, budget, imageKey },
		dimensions,
	});
}

function imageView(states: () => readonly ImagePaintState[], text: () => readonly string[] = () => []): JSX.Element {
	const stack = createElement("stack");
	insert(stack, () => {
		const children: JSX.Element[] = states().map(state => ImageView({ state }));
		for (const row of text()) {
			const node = createElement("text");
			insert(node, row);
			children.push(node);
		}
		return children;
	});
	return stack;
}

function imageRows(state: ImagePaintState, width: number): string[] {
	return renderToRows(() => ImageView({ state }), width);
}

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

/** Drive one render pass against the budget with `count` images (ids 1..count, stable across passes). */
function pass(budget: ImageBudget, count: number): { suppressed: boolean[]; retry: boolean; purge: readonly number[] } {
	budget.beginPass();
	const suppressed: boolean[] = [];
	for (let i = 0; i < count; i++) suppressed.push(budget.observe(i + 1));
	const retry = budget.endPass();
	const purge = [...budget.takePurgeIds()];
	return { suppressed, retry, purge };
}

describe("ImageBudget", () => {
	it("keeps every image live while at or under the cap", () => {
		const budget = new ImageBudget(3, () => {});
		const first = pass(budget, 2);
		expect(first.suppressed).toEqual([false, false]);
		expect(first.retry).toBe(false);

		const second = pass(budget, 3);
		expect(second.suppressed).toEqual([false, false, false]);
		expect(second.retry).toBe(false);
		expect(second.purge).toEqual([]);
	});

	it("repeats an over-cap pass before emission and purges the oldest graphics id", () => {
		let renders = 0;
		const budget = new ImageBudget(2, () => {
			renders += 1;
		});

		// At cap: nothing demoted.
		expect(pass(budget, 2).suppressed).toEqual([false, false]);

		// Discovery identifies the stricter split and requires a retry before emit.
		const overflow = pass(budget, 3);
		expect(overflow.suppressed).toEqual([false, false, false]);
		expect(overflow.retry).toBe(true);
		expect(renders).toBe(1);

		// The retry demotes the oldest image and purges its id (1).
		const demote = pass(budget, 3);
		expect(demote.suppressed).toEqual([true, false, false]);
		expect(demote.retry).toBe(false);
		expect(demote.purge).toEqual([1]);

		// Steady state: no further retries while the count is unchanged.
		const steady = pass(budget, 3);
		expect(steady.suppressed).toEqual([true, false, false]);
		expect(steady.retry).toBe(false);
		expect(steady.purge).toEqual([]);
	});

	it("keeps exactly `cap` images live as more arrive", () => {
		const budget = new ImageBudget(2, () => {});
		// Walk up to 5 images; each addition settles in a pre-emission retry.
		for (let count = 3; count <= 5; count++) {
			pass(budget, count); // discovery pass requests a retry
			pass(budget, count); // retry applies the demotion
		}
		const settled = pass(budget, 5);
		// Newest 2 live, oldest 3 demoted.
		expect(settled.suppressed).toEqual([true, true, true, false, false]);
	});

	it("treats cap <= 0 as unlimited: never demotes, never schedules a redraw", () => {
		let renders = 0;
		const budget = new ImageBudget(0, () => {
			renders += 1;
		});
		expect(budget.enabled).toBe(false);
		const result = pass(budget, 6);
		expect(result.suppressed).toEqual([false, false, false, false, false, false]);
		expect(result.retry).toBe(false);
		expect(result.purge).toEqual([]);
		expect(renders).toBe(0);
	});

	it("restores demoted images once the count settles back within the cap", () => {
		const budget = new ImageBudget(2, () => {});
		pass(budget, 3); // overflow
		pass(budget, 3); // demote oldest
		expect(pass(budget, 3).suppressed).toEqual([true, false, false]);

		// Drop back to 2 images; after the threshold settles nothing is demoted.
		pass(budget, 2);
		const restored = pass(budget, 2);
		expect(restored.suppressed).toEqual([false, false]);
		expect(restored.retry).toBe(false);
		expect(restored.purge).toEqual([]);
	});

	it("hands back a stable graphics id per key and fresh ids without one", () => {
		const budget = new ImageBudget(3, () => {});
		const a1 = budget.acquireId("tool:0");
		const a2 = budget.acquireId("tool:0");
		const b = budget.acquireId("tool:1");
		expect(a1).toBe(a2);
		expect(b).not.toBe(a1);
		expect(budget.acquireId()).not.toBe(budget.acquireId());
	});

	it("initializes separate budgets with different starting IDs", () => {
		const budget1 = new ImageBudget();
		const budget2 = new ImageBudget();
		expect(budget1.acquireId()).not.toBe(budget2.acquireId());
	});
	it("evicts demoted IDs from the key map so a returned key gets a fresh ID", () => {
		const budget = new ImageBudget(2, () => {});
		const id1 = budget.acquireId("keyA");
		const id2 = budget.acquireId("keyB");
		const id3 = budget.acquireId("keyC");

		// At cap: only 2 images.
		budget.beginPass();
		budget.observe(id1);
		budget.observe(id2);
		budget.endPass();

		// acquireId should return the same IDs.
		expect(budget.acquireId("keyA")).toBe(id1);
		expect(budget.acquireId("keyB")).toBe(id2);

		// Overflow: observe 3 images.
		budget.beginPass();
		budget.observe(id1);
		budget.observe(id2);
		budget.observe(id3);
		budget.endPass(); // schedules demotion of id1

		// The key map still holds id1 until the retry applies the demotion.
		expect(budget.acquireId("keyA")).toBe(id1);

		// Retry pass: applies the purge of id1 without requiring another pass.
		budget.beginPass();
		budget.observe(id1);
		budget.observe(id2);
		budget.observe(id3);
		const retry = budget.endPass();
		expect(retry).toBe(false);

		// id1 was purged. Acquiring "keyA" now yields a fresh ID.
		const id1Fresh = budget.acquireId("keyA");
		expect(id1Fresh).not.toBe(id1);

		// The other keys are still intact.
		expect(budget.acquireId("keyB")).toBe(id2);
		expect(budget.acquireId("keyC")).toBe(id3);
	});

	it("evicts keys reacquired for images that remain suppressed", () => {
		const budget = new ImageBudget(2, () => {});
		const oldId = budget.acquireId("keyA");
		const id2 = budget.acquireId("keyB");
		const id3 = budget.acquireId("keyC");

		budget.beginPass();
		budget.observe(oldId);
		budget.observe(id2);
		budget.observe(id3);
		budget.endPass();

		budget.beginPass();
		budget.observe(oldId);
		budget.observe(id2);
		budget.observe(id3);
		expect(budget.endPass()).toBe(false);
		expect([...budget.takePurgeIds()]).toEqual([oldId]);

		const suppressedId = budget.acquireId("keyA");
		expect(suppressedId).not.toBe(oldId);

		budget.beginPass();
		expect(budget.observe(suppressedId)).toBe(true);
		expect(budget.observe(id2)).toBe(false);
		expect(budget.observe(id3)).toBe(false);
		expect(budget.endPass()).toBe(false);
		expect([...budget.takePurgeIds()]).toEqual([]);

		expect(budget.acquireId("keyA")).not.toBe(suppressedId);
	});

	it("clears all keys from the map on takeAllTransmittedIds", () => {
		const budget = new ImageBudget(3, () => {});
		const id1 = budget.acquireId("keyA");
		const id2 = budget.acquireId("keyB");

		// ensure they're in the transmit tracking
		budget.enqueueTransmit(id1, "TX1");
		budget.enqueueTransmit(id2, "TX2");

		budget.takeAllTransmittedIds();

		// The keys must yield fresh IDs now.
		expect(budget.acquireId("keyA")).not.toBe(id1);
		expect(budget.acquireId("keyB")).not.toBe(id2);
	});

	it("setCap(0) clears a previously applied demotion threshold", () => {
		const budget = new ImageBudget(2, () => {});
		pass(budget, 3);
		pass(budget, 3);
		expect(pass(budget, 3).suppressed).toEqual([true, false, false]);

		budget.setCap(0);
		const result = pass(budget, 3);
		expect(result.suppressed).toEqual([false, false, false]);
	});

	it("replays the committed live/text split by id during a stable (partial) pass", () => {
		const budget = new ImageBudget(2, () => {});
		// Settle to the steady split for 4 images at cap 2: oldest two (ids 1,2)
		// demoted to text, newest two (ids 3,4) live.
		pass(budget, 4); // threshold rises to 2
		pass(budget, 4); // applies the demotion of ids 1,2
		expect(pass(budget, 4).suppressed).toEqual([true, true, false, false]);

		// The resize fast path observes the visible tail bottom-up and only a
		// subset of images. A stable pass must therefore decide live/text by the
		// committed per-id split, NOT by call order: observing the newest images
		// first (4, then 3) must still report them live, and the oldest text —
		// the index-based path would wrongly suppress whichever arrives first.
		budget.beginPass(true);
		expect(budget.observe(4)).toBe(false); // newest, stays live
		expect(budget.observe(3)).toBe(false); // stays live
		expect(budget.observe(2)).toBe(true); // committed text
		expect(budget.observe(1)).toBe(true); // committed text
		// An id with no committed state (a brand-new image) defaults to live.
		expect(budget.observe(99)).toBe(false);

		// The stable pass left the ledger untouched: the next full pass reports
		// the same split and schedules no purge or redraw.
		const after = pass(budget, 4);
		expect(after.suppressed).toEqual([true, true, false, false]);
		expect(after.retry).toBe(false);
		expect(after.purge).toEqual([]);
	});
});

describe("encodeKittyDeleteImage", () => {
	it("emits an APC delete-by-id that frees the image and suppresses the reply", () => {
		expect(encodeKittyDeleteImage(42)).toBe("\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
	});
});

describe("tmux Kitty graphics passthrough", () => {
	beforeEach(() => {
		Bun.env.TMUX = "/tmp/tmux-1000/default,1,0";
	});

	it("wraps every Kitty graphics command in a tmux DCS envelope", () => {
		const expected = (payload: string) => `\x1bPtmux;${payload.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;

		expect(encodeKitty("AA==", { columns: 1, rows: 1 })).toBe(expected("\x1b_Ga=T,f=100,q=2,C=1,c=1,r=1;AA==\x1b\\"));
		expect(encodeKittyTransmit("AA==", 9)).toBe(expected("\x1b_Ga=t,f=100,q=2,i=9;AA==\x1b\\"));
		expect(encodeKittyPlacement({ imageId: 9, placementId: 9, columns: 3, rows: 2 })).toBe(
			expected("\x1b_Ga=p,q=2,C=1,i=9,p=9,c=3,r=2\x1b\\"),
		);
		expect(encodeKittyVirtualPlacement({ imageId: 9, placementId: 9, columns: 3, rows: 2 })).toBe(
			expected("\x1b_Ga=p,U=1,q=2,i=9,p=9,c=3,r=2\x1b\\"),
		);
		expect(encodeKittyDeleteImage(9)).toBe(expected("\x1b_Ga=d,d=I,i=9,q=2\x1b\\"));
	});

	it("wraps each quiet chunk of a multi-part Kitty transmission separately", () => {
		const sequence = encodeKittyTransmit("A".repeat(4097), 9);
		expect(sequence.match(/\x1bPtmux;/gu)).toHaveLength(2);
		expect(sequence.match(/\x1b\x1b_G/gu)).toHaveLength(2);
		expect(sequence.match(/\x1b\x1b\\\x1b\\/gu)).toHaveLength(2);
		expect(sequence).toContain("\x1b\x1b_Gq=2,m=0;");
	});

	it("leaves Kitty graphics commands bare outside tmux", () => {
		delete Bun.env.TMUX;
		expect(encodeKittyTransmit("AA==", 9)).toBe("\x1b_Ga=t,f=100,q=2,i=9;AA==\x1b\\");
		expect(wrapTmuxPassthrough("\x1b_Gpayload\x1b\\")).toBe("\x1bPtmux;\x1b\x1b_Gpayload\x1b\x1b\\\x1b\\");
	});
});

describe("Image budget integration", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		setTerminalProtocol(ImageProtocol.Kitty);
		// These tests pin the direct `a=p` placement contract.
		setKittyGraphics({ unicodePlaceholders: false });
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		setTerminalProtocol(originalProtocol);
		setKittyGraphics(originalGraphics);
	});

	it("renders within-budget images as graphics carrying their stable id", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = imageState(budget, "k", { maxWidthCells: 4, maxHeightCells: 4 });

		budget.beginPass();
		const lines = imageRows(image, 20);
		budget.endPass();

		const last = lines.at(-1) ?? "";
		expect(last).toContain("\x1b_G");
		expect(last).toContain(`i=${id}`);
		expect(last).not.toContain("[Image:");
	});

	it("transmits the base64 once via the budget and renders only a placement line", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = imageState(budget, "k", { maxWidthCells: 4, maxHeightCells: 4 });

		budget.beginPass();
		const lines = imageRows(image, 20);
		budget.endPass();

		// One transmit, carrying the base64 data, keyed by the image id.
		const transmits = [...budget.takeTransmits()];
		expect(transmits).toHaveLength(1);
		expect(transmits[0]).toContain("\x1b_Ga=t");
		expect(transmits[0]).toContain(`i=${id}`);
		expect(transmits[0]).toContain(BASE64_ONE_PIXEL_PNG);
		// The render line is a placement (`a=p`) without the base64.
		const last = lines.at(-1) ?? "";
		expect(last).toContain("\x1b_Ga=p");
		expect(last).not.toContain(BASE64_ONE_PIXEL_PNG);

		// A second render (cache hit) does not re-enqueue the data.
		budget.beginPass();
		imageRows(image, 20);
		budget.endPass();
		expect([...budget.takeTransmits()]).toEqual([]);
	});

	it("moves back up before multi-row direct Kitty placements and restores the cursor below them", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = imageState(budget, "k", { maxWidthCells: 4, maxHeightCells: 4 }, { widthPx: 40, heightPx: 40 });

		budget.beginPass();
		const lines = imageRows(image, 20);
		budget.endPass();

		const last = lines.at(-1) ?? "";
		expect(lines).toHaveLength(4);
		expect(lines.slice(0, -1)).toEqual(["\x1b[0m", "\x1b[0m", "\x1b[0m"]);
		expect(last.startsWith("\x1b7\x1b[3A")).toBe(true);
		expect(last.endsWith("\x1b8")).toBe(true);
		expect(last).toContain("\x1b_Ga=p");
		expect(last).toContain("C=1");
		expect(last).toContain(`i=${id}`);
		expect(last).toContain("c=4");
		expect(last).toContain("r=4");
	});

	it("does not move the cursor around single-row direct Kitty placements", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = imageState(budget, "k", { maxWidthCells: 4, maxHeightCells: 1 });

		budget.beginPass();
		const lines = imageRows(image, 20);
		budget.endPass();

		const last = lines.at(-1) ?? "";
		expect(lines).toHaveLength(1);
		expect(last.startsWith("\x1b_Ga=p")).toBe(true);
		expect(last).toContain("C=1");
		expect(last).toContain(`i=${id}`);
		expect(last).toContain("r=1");
		expect(last.endsWith("\x1b\\")).toBe(true);
		expect(last).not.toContain("\x1b[0A");
		expect(last).not.toContain("\x1b[0B");
		expect(last).not.toMatch(/\x1b\[\d+[AB]/);
	});

	it("renders an over-budget image as its text fallback instead of graphics", () => {
		const budget = new ImageBudget(1, () => {});
		const older = imageState(budget, "old", { maxWidthCells: 4, maxHeightCells: 4 });
		const newer = imageState(budget, "new", { maxWidthCells: 4, maxHeightCells: 4 });

		// First pass lets the budget notice the overflow; the second applies the
		// demotion (older image is observed first, so it is demoted first).
		let olderLines: readonly string[] = [];
		let newerLines: readonly string[] = [];
		for (let i = 0; i < 2; i++) {
			budget.beginPass();
			olderLines = imageRows(older, 20);
			newerLines = imageRows(newer, 20);
			budget.endPass();
		}

		expect(olderLines.join("")).toContain("[Image:");
		expect(olderLines.join("")).not.toContain("\x1b_G");
		expect(newerLines.at(-1) ?? "").toContain("\x1b_G");
	});
});

describe("Image budget + Unicode placeholders", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		setTerminalProtocol(ImageProtocol.Kitty);
		setKittyGraphics({ unicodePlaceholders: true });
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		setTerminalProtocol(originalProtocol);
		setKittyGraphics(originalGraphics);
	});

	it("renders a transmitted image as a virtual-placement placeholder grid", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = imageState(budget, "k", { maxWidthCells: 4, maxHeightCells: 4 });

		budget.beginPass();
		const lines = imageRows(image, 20);
		budget.endPass();

		// Line 0 carries the U=1 virtual placement keyed by the image id.
		expect(lines[0]).toContain(`\x1b_Ga=p,U=1,q=2,i=${id}`);
		// Every rendered line is a real placeholder-cell row (no empty/cursor-up trick).
		expect(lines.every(l => l.includes(KITTY_PLACEHOLDER))).toBe(true);
		expect(lines.join("")).not.toContain("\x1b[1A");
		// The image id is encoded in the cell foreground color (low 24 bits).
		expect(lines[0]).toContain(`38;2;${(id >> 16) & 0xff};${(id >> 8) & 0xff};${id & 0xff}m`);
		// Render lines never carry the base64 — data goes via the one-time transmit.
		expect(lines.join("")).not.toContain(BASE64_ONE_PIXEL_PNG);
		const transmits = [...budget.takeTransmits()];
		expect(transmits).toHaveLength(1);
		expect(transmits[0]).toContain("\x1b_Ga=t");
		expect(transmits[0]).toContain(`i=${id}`);
	});

	it("re-emits the virtual placement (not base64) on a fresh render after cache invalidation", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = imageState(budget, "k", { maxWidthCells: 4, maxHeightCells: 4 });
		budget.beginPass();
		imageRows(image, 20);
		budget.endPass();
		expect([...budget.takeTransmits()]).toHaveLength(1);

		// A fresh retained image node re-emits the placement but never the data.
		budget.beginPass();
		const lines = imageRows(image, 20);
		budget.endPass();
		expect(lines[0]).toContain(encodeKittyVirtualPlacement({ imageId: id, placementId: id, columns: 4, rows: 4 }));
		expect([...budget.takeTransmits()]).toEqual([]);
	});
});

describe("retained inline-image budget", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCellDims: CellDimensions;
	let restoreTerminalId: (() => void) | undefined;
	let monotonicNow = 0;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		setTerminalProtocol(ImageProtocol.Kitty);
		setKittyGraphics({ unicodePlaceholders: false });
		restoreTerminalId = overrideTerminalId("base");
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 40;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setCellDimensions(originalCellDims);
		setTerminalProtocol(originalProtocol);
		restoreTerminalId?.();
		setKittyGraphics(originalGraphics);
	});

	async function settle(term: VirtualTerminal): Promise<void> {
		for (let i = 0; i < 4; i++) {
			const tick = Promise.withResolvers<void>();
			process.nextTick(tick.resolve);
			await tick.promise;
			// TUI's production scheduler advances on its real 30fps cadence; this
			// terminal integration must wait for that scheduled frame to reach VT.
			await Bun.sleep(40);
			await term.flush();
		}
	}

	function mountImages(term: VirtualTerminal) {
		const [states, setStates] = createSignal<readonly ImagePaintState[]>([]);
		const [rows, setRows] = createSignal<readonly string[]>([]);
		const [fullscreenStates, setFullscreenStates] = createSignal<readonly ImagePaintState[]>([]);
		const [fullscreenVisible, setFullscreenVisible] = createSignal(false);
		const [overlayStates, setOverlayStates] = createSignal<readonly ImagePaintState[]>([]);
		const [overlayRows, setOverlayRows] = createSignal<readonly string[]>([]);
		const [overlayVisible, setOverlayVisible] = createSignal(false);
		const root = render(
			() => {
				createComponent(Portal, {
					to: "overlay",
					fullscreen: true,
					get visible() {
						const visible = fullscreenVisible();
						return () => visible;
					},
					get children() {
						return imageView(fullscreenStates);
					},
				});
				createComponent(Portal, {
					to: "overlay",
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
					get visible() {
						const visible = overlayVisible();
						return () => visible;
					},
					get children() {
						return imageView(overlayStates, overlayRows);
					},
				});
				return imageView(states, rows);
			},
			{ terminal: term, theme: testTheme },
		);
		return {
			root,
			setStates,
			setRows,
			setFullscreenStates,
			setFullscreenVisible,
			setOverlayStates,
			setOverlayRows,
			setOverlayVisible,
		};
	}

	it("renders following text below a multi-row direct Kitty placement", async () => {
		const originalGraphics = { ...getKittyGraphics() };
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		setKittyGraphics({ unicodePlaceholders: false });
		const mounted = mountImages(term);
		try {
			const image = imageState(
				mounted.root.tui.imageBudget,
				"direct",
				{ maxWidthCells: 4, maxHeightCells: 4 },
				{ widthPx: 40, heightPx: 40 },
			);
			mounted.setStates([image]);
			mounted.setRows(["after-image"]);
			await settle(term);
			expect(writes.join("")).toContain("\x1b7\x1b[3A");
			expect(
				term
					.getViewport()
					.map(line => line.trimEnd())
					.slice(0, 5),
			).toEqual(["", "", "", "", "after-image"]);
		} finally {
			mounted.root.dispose();
			setKittyGraphics(originalGraphics);
		}
	});

	it("clips a direct Kitty placement during an in-place width repaint", async () => {
		const term = new VirtualTerminal(40, 6);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "1";
		const mounted = mountImages(term);
		try {
			mounted.setStates([
				imageState(
					mounted.root.tui.imageBudget,
					"resize-direct",
					{ maxWidthCells: 4, maxHeightCells: 4 },
					{ widthPx: 40, heightPx: 40 },
				),
			]);
			mounted.setRows(["after-0", "after-1", "after-2"]);
			await settle(term);
			writes.length = 0;
			term.resize(30, 6);
			await settle(term);
			expect(writes.join("")).toContain("a=p,q=2,C=1");
			expect(writes.join("")).toContain("c=4,r=3,y=10,h=30");
		} finally {
			mounted.root.dispose();
		}
	});

	it("applies the image budget before emitting the first frame", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const mounted = mountImages(term);
		try {
			mounted.root.tui.setMaxInlineImages(1);
			const budget = mounted.root.tui.imageBudget;
			mounted.setStates([imageState(budget, "old"), imageState(budget, "new")]);
			await settle(term);
			const output = writes.join("");
			expect(output.match(/\x1b_Ga=t/g)).toHaveLength(1);
			expect(
				term
					.getViewport()
					.map(line => line.trimEnd())
					.filter(line => line.includes("[Image:")),
			).toHaveLength(1);
		} finally {
			mounted.root.dispose();
		}
	});

	it("deletes every kitty image on a destructive display reset", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const mounted = mountImages(term);
		try {
			const state = imageState(mounted.root.tui.imageBudget, "only");
			mounted.setStates([state]);
			await settle(term);
			writes.length = 0;
			mounted.root.tui.resetDisplay();
			await settle(term);
			const output = writes.join("");
			const deleteIndex = output.indexOf("\x1b_Ga=d,d=A,q=2\x1b\\");
			expect(deleteIndex).toBeGreaterThanOrEqual(0);
			expect(output.indexOf("\x1b_Ga=t", deleteIndex)).toBeGreaterThan(deleteIndex);
			expect(output).toContain(BASE64_ONE_PIXEL_PNG);
		} finally {
			mounted.root.dispose();
		}
	});

	it("purges demoted image graphics and repaints the fallback without a destructive replay", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		const mounted = mountImages(term);
		try {
			mounted.root.tui.setMaxInlineImages(1);
			const budget = mounted.root.tui.imageBudget;
			const oldId = budget.acquireId("old");
			mounted.setStates([imageState(budget, "old")]);
			await settle(term);
			writes.length = 0;
			mounted.setStates([imageState(budget, "old"), imageState(budget, "new")]);
			await settle(term);
			expect(writes.join("")).not.toContain("\x1b[2J");
			expect(writes.join("")).not.toContain("\x1b[3J");
			expect(writes.join("")).toContain(encodeKittyDeleteImage(oldId));
			expect(
				term
					.getViewport()
					.map(line => line.trimEnd())
					.filter(line => line.includes("[Image:")),
			).toHaveLength(1);
		} finally {
			mounted.root.dispose();
		}
	});

	it("retransmits current images after a destructive redraw", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		const mounted = mountImages(term);
		try {
			mounted.setStates([imageState(mounted.root.tui.imageBudget, "only")]);
			await settle(term);
			writes.length = 0;
			mounted.root.tui.requestRender(true, { clearScrollback: true });
			await settle(term);
			expect(writes.join("")).toContain("\x1b_Ga=p");
			expect(writes.join("")).toContain(BASE64_ONE_PIXEL_PNG);
		} finally {
			mounted.root.dispose();
		}
	});

	it("releases a demoted image's key once its graphic is actually retired", async () => {
		const term = new VirtualTerminal(40, 20);
		const mounted = mountImages(term);
		try {
			mounted.root.tui.setMaxInlineImages(2);
			const budget = mounted.root.tui.imageBudget;
			const oldestId = budget.acquireId("row-0");
			mounted.setStates([imageState(budget, "row-0"), imageState(budget, "row-1"), imageState(budget, "row-2")]);
			await settle(term);
			expect(budget.acquireId("row-0")).not.toBe(oldestId);
			expect(budget.acquireId("row-2")).toBe(budget.acquireId("row-2"));
		} finally {
			mounted.root.dispose();
		}
	});

	it("keeps a shared image placed when an over-cap fullscreen overlay demotes it", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		const mounted = mountImages(term);
		try {
			mounted.root.tui.setMaxInlineImages(2);
			const budget = mounted.root.tui.imageBudget;
			const sharedId = budget.acquireId("shared");
			mounted.setStates([imageState(budget, "behind"), imageState(budget, "shared")]);
			await settle(term);
			writes.length = 0;
			mounted.setFullscreenStates([
				imageState(budget, "shared"),
				imageState(budget, "modal-0"),
				imageState(budget, "modal-1"),
			]);
			mounted.setFullscreenVisible(true);
			await settle(term);
			mounted.setFullscreenVisible(false);
			await settle(term);
			expect(writes.join("")).not.toContain(encodeKittyDeleteImage(sharedId));
		} finally {
			mounted.root.dispose();
		}
	});

	it("keeps a shared image's key when the overlay's demotion is refused", async () => {
		const term = new VirtualTerminal(40, 12);
		const mounted = mountImages(term);
		try {
			mounted.root.tui.setMaxInlineImages(2);
			const budget = mounted.root.tui.imageBudget;
			const sharedId = budget.acquireId("shared");
			mounted.setStates([imageState(budget, "shared"), imageState(budget, "other")]);
			await settle(term);
			mounted.setFullscreenStates([
				imageState(budget, "shared"),
				imageState(budget, "modal-0"),
				imageState(budget, "modal-1"),
			]);
			mounted.setFullscreenVisible(true);
			await settle(term);
			mounted.setFullscreenVisible(false);
			await settle(term);
			expect(budget.acquireId("shared")).toBe(sharedId);
		} finally {
			mounted.root.dispose();
		}
	});

	it("keeps normal-buffer placements visible across a fullscreen overlay pass", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		const mounted = mountImages(term);
		try {
			const budget = mounted.root.tui.imageBudget;
			const firstId = budget.acquireId("behind-0");
			const secondId = budget.acquireId("behind-1");
			mounted.setStates([imageState(budget, "behind-0"), imageState(budget, "behind-1")]);
			await settle(term);
			writes.length = 0;
			mounted.setFullscreenStates([imageState(budget, "modal")]);
			mounted.setFullscreenVisible(true);
			await settle(term);
			mounted.setFullscreenVisible(false);
			await settle(term);
			const output = writes.join("");
			expect(output).toContain("\x1b[?1049h");
			expect(output).toContain("\x1b[?1049l");
			expect(output).not.toContain(encodeKittyDeleteImage(firstId));
			expect(output).not.toContain(encodeKittyDeleteImage(secondId));
		} finally {
			mounted.root.dispose();
		}
	});

	it("starts each alternate-buffer lifecycle without the previous overlay's split", async () => {
		const term = new VirtualTerminal(40, 12);
		const mounted = mountImages(term);
		try {
			mounted.root.tui.setMaxInlineImages(2);
			const budget = mounted.root.tui.imageBudget;
			mounted.setFullscreenStates([
				imageState(budget, "first-0"),
				imageState(budget, "first-1"),
				imageState(budget, "first-2"),
			]);
			mounted.setFullscreenVisible(true);
			await settle(term);
			mounted.setFullscreenVisible(false);
			await settle(term);
			const secondId = budget.acquireId("second");
			mounted.setFullscreenStates([imageState(budget, "second")]);
			mounted.setFullscreenVisible(true);
			await settle(term);
			expect(budget.acquireId("second")).toBe(secondId);
		} finally {
			mounted.root.dispose();
		}
	});

	it("lets a full-width non-fullscreen overlay replace Unicode image placeholder rows", async () => {
		const originalGraphics = { ...getKittyGraphics() };
		const term = new VirtualTerminal(40, 12);
		setKittyGraphics({ unicodePlaceholders: true });
		const mounted = mountImages(term);
		try {
			mounted.setStates([imageState(mounted.root.tui.imageBudget, "behind")]);
			await settle(term);
			mounted.setOverlayRows(["MODEL SELECTOR", "MODEL ROW 2", "MODEL ROW 3", "MODEL ROW 4"]);
			mounted.setOverlayVisible(true);
			await settle(term);
			const modalViewport = term.getViewport().join("\n");
			expect(modalViewport).toContain("MODEL SELECTOR");
			expect(modalViewport).not.toContain(KITTY_PLACEHOLDER);
			mounted.setOverlayVisible(false);
			await settle(term);
			expect(term.getViewport().join("\n")).toContain(KITTY_PLACEHOLDER);
		} finally {
			mounted.root.dispose();
			setKittyGraphics(originalGraphics);
		}
	});

	it("keeps a non-fullscreen overlay image placed while the provider frame fills the cap", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		const mounted = mountImages(term);
		try {
			mounted.root.tui.setMaxInlineImages(2);
			const budget = mounted.root.tui.imageBudget;
			const modalId = budget.acquireId("modal");
			mounted.setStates([imageState(budget, "behind-0"), imageState(budget, "behind-1")]);
			await settle(term);
			mounted.setOverlayStates([imageState(budget, "modal")]);
			mounted.setOverlayVisible(true);
			await settle(term);
			mounted.root.tui.requestRender();
			await settle(term);
			expect(writes.join("")).toContain(`i=${modalId}`);
		} finally {
			mounted.root.dispose();
		}
	});

	it("spares a screen image whose suppression the reconcile undercut", async () => {
		const term = new VirtualTerminal(40, 12);
		const mounted = mountImages(term);
		try {
			mounted.root.tui.setMaxInlineImages(1);
			const budget = mounted.root.tui.imageBudget;
			const keptId = budget.acquireId("kept");
			mounted.setStates([imageState(budget, "older"), imageState(budget, "kept")]);
			await settle(term);
			mounted.setFullscreenStates([imageState(budget, "modal")]);
			mounted.setFullscreenVisible(true);
			await settle(term);
			mounted.setFullscreenVisible(false);
			mounted.setStates([imageState(budget, "kept")]);
			await settle(term);
			expect(budget.acquireId("kept")).toBe(keptId);
		} finally {
			mounted.root.dispose();
		}
	});

	it("names forgotten placeholder images in a reset's own deletions", async () => {
		const originalGraphics = { ...getKittyGraphics() };
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		setKittyGraphics({ unicodePlaceholders: true });
		const mounted = mountImages(term);
		try {
			const budget = mounted.root.tui.imageBudget;
			const goneId = budget.acquireId("gone");
			mounted.setStates([imageState(budget, "gone")]);
			await settle(term);
			mounted.setStates([]);
			writes.length = 0;
			mounted.root.tui.resetDisplay();
			await settle(term);
			expect(writes.join("")).toContain(`\x1b_Ga=d,d=I,i=${goneId}`);
		} finally {
			mounted.root.dispose();
			setKittyGraphics(originalGraphics);
		}
	});

	it("holds a reset's deletions until the repaint that restores them", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		const mounted = mountImages(term);
		try {
			const budget = mounted.root.tui.imageBudget;
			const id = budget.acquireId("transcript");
			mounted.setStates([imageState(budget, "transcript")]);
			await settle(term);
			mounted.setFullscreenVisible(true);
			await settle(term);
			writes.length = 0;
			mounted.root.tui.resetDisplay();
			await settle(term);
			expect(writes.join("")).not.toContain(encodeKittyDeleteImage(id));
		} finally {
			mounted.root.dispose();
		}
	});

	it("keeps transcript placements when the shutdown flush runs under a fullscreen overlay", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		const mounted = mountImages(term);
		const budget = mounted.root.tui.imageBudget;
		const id = budget.acquireId("behind");
		mounted.setStates([imageState(budget, "behind")]);
		await settle(term);
		mounted.setFullscreenStates([imageState(budget, "modal")]);
		mounted.setFullscreenVisible(true);
		await settle(term);
		writes.length = 0;
		mounted.root.dispose();
		expect(writes.join("")).not.toContain(encodeKittyDeleteImage(id));
	});

	it("does not demote transcript images under a closing overlay's suppression threshold", async () => {
		const term = new VirtualTerminal(40, 12);
		const mounted = mountImages(term);
		try {
			mounted.root.tui.setMaxInlineImages(2);
			const budget = mounted.root.tui.imageBudget;
			const ids = [budget.acquireId("behind-0"), budget.acquireId("behind-1")];
			mounted.setStates([imageState(budget, "behind-0"), imageState(budget, "behind-1")]);
			await settle(term);
			mounted.setFullscreenStates([
				imageState(budget, "modal-0"),
				imageState(budget, "modal-1"),
				imageState(budget, "modal-2"),
			]);
			mounted.setFullscreenVisible(true);
			await settle(term);
			mounted.setFullscreenVisible(false);
			await settle(term);
			expect(budget.acquireId("behind-0")).toBe(ids[0]);
			expect(budget.acquireId("behind-1")).toBe(ids[1]);
		} finally {
			mounted.root.dispose();
		}
	});

	it("holds the cap over a provider frame plus its non-fullscreen overlay", async () => {
		const term = new VirtualTerminal(40, 12);
		const mounted = mountImages(term);
		try {
			mounted.root.tui.setMaxInlineImages(2);
			const budget = mounted.root.tui.imageBudget;
			mounted.setStates([imageState(budget, "behind-0"), imageState(budget, "behind-1")]);
			mounted.setOverlayStates([imageState(budget, "modal-0"), imageState(budget, "modal-1")]);
			mounted.setOverlayVisible(true);
			await settle(term);
			expect(budget.acquireId("modal-0")).toBe(budget.acquireId("modal-0"));
			expect(budget.acquireId("modal-1")).toBe(budget.acquireId("modal-1"));
		} finally {
			mounted.root.dispose();
		}
	});

	it("deletes every tracked Kitty image during live cleanup", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		const mounted = mountImages(term);
		try {
			const budget = mounted.root.tui.imageBudget;
			const ids = [budget.acquireId("first"), budget.acquireId("second")];
			mounted.setStates([imageState(budget, "first"), imageState(budget, "second")]);
			await settle(term);
			writes.length = 0;
			mounted.root.tui.clearInlineImages();
			expect(writes.join("")).toContain(encodeKittyDeleteImage(ids[0]));
			expect(writes.join("")).toContain(encodeKittyDeleteImage(ids[1]));
		} finally {
			mounted.root.dispose();
		}
	});

	it("holds the first Ghostty image paint until the startup settle window passes", async () => {
		const originalGraphics = { ...getKittyGraphics() };
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		restoreTerminalId?.();
		restoreTerminalId = overrideTerminalId("ghostty");
		setKittyGraphics({ unicodePlaceholders: true });
		const mounted = mountImages(term);
		try {
			mounted.setStates([imageState(mounted.root.tui.imageBudget, "only")]);
			await Promise.resolve();
			expect(writes.join("")).not.toContain("\x1b_Ga=t");
			// Ghostty's terminal store ignores early graphics; drive the actual
			// production settle window instead of replacing its scheduler.
			await Bun.sleep(100);
			await term.flush();
			expect(writes.join("")).toContain("\x1b_Ga=t");
			expect(writes.join("")).toContain(BASE64_ONE_PIXEL_PNG);
		} finally {
			mounted.root.dispose();
			setKittyGraphics(originalGraphics);
		}
	});

	it("leaves transmitted images in the terminal store on stop so scrollback keeps them", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		const mounted = mountImages(term);
		const state = imageState(mounted.root.tui.imageBudget, "persist");
		mounted.setStates([state]);
		await settle(term);
		writes.length = 0;
		mounted.root.dispose();
		expect(writes.join("")).not.toContain("a=d,d=I");
	});
});

describe("kitty transmit / placement encoding", () => {
	it("encodeKittyTransmit loads data by id without displaying it", () => {
		const seq = encodeKittyTransmit(BASE64_ONE_PIXEL_PNG, 9);
		expect(seq.startsWith("\x1b_Ga=t,f=100,q=2,i=9;")).toBe(true);
		expect(seq.endsWith("\x1b\\")).toBe(true);
		expect(seq).toContain(BASE64_ONE_PIXEL_PNG);
		expect(seq).not.toContain("a=p");
	});

	it("encodeKittyPlacement displays a transmitted image by id with a stable placement id", () => {
		const seq = encodeKittyPlacement({ imageId: 9, placementId: 9, columns: 3, rows: 2 });
		expect(seq).toBe("\x1b_Ga=p,q=2,C=1,i=9,p=9,c=3,r=2\x1b\\");
		expect(seq).not.toContain(BASE64_ONE_PIXEL_PNG);
	});
});

describe("ImageBudget transmit tracking", () => {
	it("transmits an id once and clears the queue when drained", () => {
		const budget = new ImageBudget(3, () => {});
		expect(budget.shouldTransmit(1)).toBe(true);
		budget.enqueueTransmit(1, "TX1");
		expect(budget.shouldTransmit(1)).toBe(false);
		budget.enqueueTransmit(1, "TX1-dup"); // already transmitted => no-op
		expect([...budget.takeTransmits()]).toEqual(["TX1"]);
		expect([...budget.takeTransmits()]).toEqual([]);
	});

	it("purges all transmitted ids for terminal-session cleanup", () => {
		const budget = new ImageBudget(3, () => {});
		budget.enqueueTransmit(1, "TX1");
		budget.enqueueTransmit(2, "TX2");
		expect(budget.shouldTransmit(1)).toBe(false);

		expect([...budget.takeAllTransmittedIds()]).toEqual([1, 2]);
		expect([...budget.takeTransmits()]).toEqual([]);
		expect(budget.shouldTransmit(1)).toBe(true);
		expect([...budget.takeAllTransmittedIds()]).toEqual([]);
	});

	it("re-transmits an image after a purge frees its data", () => {
		const budget = new ImageBudget(2, () => {});
		budget.enqueueTransmit(1, "TX1");
		expect([...budget.takeTransmits()]).toEqual(["TX1"]);
		expect(budget.shouldTransmit(1)).toBe(false);

		// Push past the cap so the oldest image (id 1) is demoted and purged.
		pass(budget, 3); // discovery pass requests a retry
		const demote = pass(budget, 3); // retry purges id 1
		expect(demote.purge).toEqual([1]);

		// d=I freed the data, so the image must transmit again if it returns.
		expect(budget.shouldTransmit(1)).toBe(true);
	});
});
