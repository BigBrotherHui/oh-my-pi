import { beforeAll, describe, expect, it } from "bun:test";
import {
	buildLargeTextLines,
	buildSampleImage,
	encodeRgbPng,
	LargeTextView,
	ProtocolProbeView,
} from "@oh-my-pi/pi-tui/apps/debug/protocol-probe";
import { getImageDimensions, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import { ImageBudget } from "../src/components/image";
import { renderToRows, renderToText } from "../src/testing";
import { initTheme } from "../src/theme";
import { setTuiTight } from "../src/utils";

beforeAll(async () => {
	await initTheme();
});

describe("protocol probe assets", () => {
	it("encodes sample images as PNGs with their requested dimensions", () => {
		const sample = buildSampleImage(48, 24);
		expect(sample.mimeType).toBe("image/png");
		expect(sample.dimensions).toEqual({ widthPx: 48, heightPx: 24 });
		expect(getImageDimensions(sample.base64, sample.mimeType)).toEqual(sample.dimensions);
	});

	it("encodes an arbitrary RGB buffer as a PNG", () => {
		const png = encodeRgbPng(3, 2, new Uint8Array(3 * 2 * 3));
		expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(getImageDimensions(Buffer.from(png).toString("base64"), "image/png")).toEqual({ widthPx: 3, heightPx: 2 });
	});

	it("returns raw large-text lines with every scale's reserved rows", () => {
		const lines = buildLargeTextLines([2, 3]);
		expect(lines).toHaveLength(5);
		expect(lines[0]).toContain("\x1b]66;s=2;");
		expect(lines[1]).toBe("");
		expect(lines[2]).toContain("\x1b]66;s=3;");
		expect(lines[3]).toBe("");
		expect(lines[4]).toBe("");
	});

	it("gives separately mounted probe images independent graphics ids", () => {
		const originalImageProtocol = TERMINAL.imageProtocol;
		const budget = new ImageBudget(8, () => {});
		const options = {
			image: buildSampleImage(8, 8),
			imageBudget: budget,
			notificationSuppressed: true,
		};
		setTerminalImageProtocol(ImageProtocol.Kitty);
		try {
			budget.beginPass();
			const first = renderToRows(() => ProtocolProbeView({ options }), 80).join("\n");
			budget.endPass();
			budget.beginPass();
			const second = renderToRows(() => ProtocolProbeView({ options }), 80).join("\n");
			budget.endPass();

			const firstId = first.match(/i=(\d+)/)?.[1];
			const secondId = second.match(/i=(\d+)/)?.[1];
			expect(firstId).toBeDefined();
			expect(secondId).toBeDefined();
			expect(secondId).not.toBe(firstId);
		} finally {
			setTerminalImageProtocol(originalImageProtocol);
		}
	});

	it("renders large-text sizing spans with their reserved rows", () => {
		const rows = renderToRows(() => LargeTextView({ scales: [2, 3] }), Number.MAX_SAFE_INTEGER);
		expect(rows).toHaveLength(5);
		expect(rows[0]).toContain("\x1b]66;s=2;");
		expect(rows[2]).toContain("\x1b]66;s=3;");
		expect(rows.slice(1)).toContain("");
	});
});

describe("protocol probe panel", () => {
	it("keeps each protocol panel visible while compact layout removes its historical gutters", () => {
		const options = {
			image: buildSampleImage(8, 8),
			imageBudget: new ImageBudget(),
			notificationSuppressed: true,
		};
		setTuiTight(false);
		try {
			const expanded = renderToText(() => ProtocolProbeView({ options }), 80);
			setTuiTight(true);
			const compact = renderToText(() => ProtocolProbeView({ options }), 24);
			const expandedTitle = expanded.find(line => line.includes("Terminal Protocol Test"));
			const compactTitle = compact.find(line => line.includes("Terminal Protocol Test"));

			expect(expanded.join("\n")).toContain("Styling (SGR)");
			expect(expanded.join("\n")).toContain("Hyperlinks (OSC 8)");
			expect(expanded.join("\n")).toContain("Text sizing (OSC 66)");
			expect(expanded.join("\n")).toContain("Graphics");
			expect(expanded.join("\n")).toContain("Notification");
			expect(expandedTitle?.startsWith(" ")).toBe(true);
			expect(compactTitle?.startsWith(" ")).toBe(false);
			expect(compact.join("\n")).toContain("Notification");
		} finally {
			setTuiTight(false);
		}
	});
});
