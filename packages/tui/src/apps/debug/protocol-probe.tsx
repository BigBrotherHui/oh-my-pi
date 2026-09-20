import * as zlib from "node:zlib";
import { createImagePaintState, type ImageBudget, type ImagePaintState } from "../../host/elements/image";
import { theme } from "../../theme/theme";
import { ImageProtocol, NotifyProtocol, TERMINAL } from "../../terminal-capabilities";
import { rgb, Style } from "../../core/style";
import { type JSX, useTightLayout } from "../../reactive";
import { cellWidth } from "../../core/richtext";
import { encodeTextSized, type TextSizingScale } from "../../utils";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const result = Buffer.alloc(body.length + 8);
	result.writeUInt32BE(data.length, 0);
	body.copy(result, 4);
	result.writeUInt32BE(Bun.hash.crc32(body) >>> 0, result.length - 4);
	return result;
}

export function encodeRgbPng(width: number, height: number, pixels: Uint8Array): Uint8Array {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const stride = width * 3;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", zlib.deflateSync(raw)),
		pngChunk("IEND", new Uint8Array(0)),
	]);
}

export interface SampleImage {
	base64: string;
	mimeType: string;
	dimensions: { widthPx: number; heightPx: number };
}

export function buildSampleImage(width = 192, height = 128): SampleImage {
	const denomX = Math.max(1, width - 1);
	const denomY = Math.max(1, height - 1);
	const pixels = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = (y * width + x) * 3;
			pixels[index] = Math.round((x / denomX) * 255);
			pixels[index + 1] = Math.round((y / denomY) * 255);
			pixels[index + 2] = 128;
		}
	}
	return {
		base64: Buffer.from(encodeRgbPng(width, height, pixels)).toString("base64"),
		mimeType: "image/png",
		dimensions: { widthPx: width, heightPx: height },
	};
}

const LARGE_TEXT_SAMPLE = "Aa Bb 123";

export function buildLargeTextLines(scales: readonly TextSizingScale[] = [2, 3]): string[] {
	const lines: string[] = [];
	for (const scale of scales) {
		lines.push(`  ${encodeTextSized(`${LARGE_TEXT_SAMPLE} (${scale}x)`, { scale })}`);
		for (let reserved = 1; reserved < scale; reserved++) lines.push("");
	}
	return lines;
}

export function LargeTextView({ scales = [2, 3] }: { scales?: readonly TextSizingScale[] }): JSX.Element {
	return (
		<stack>
			{scales.map(scale => {
				const label = `${LARGE_TEXT_SAMPLE} (${scale}x)`;
				return (
					<stack key={scale}>
						<text wrap="none">
							{"  "}
							<span color="accent">
								<raw value={encodeTextSized(label, { scale })} width={cellWidth(label)} />
							</span>
						</text>
						{Array.from({ length: Math.max(0, scale - 1) }, (_, index) => (
							<text key={index}>{""}</text>
						))}
					</stack>
				);
			})}
		</stack>
	);
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
	const chroma = v * s;
	const hue = (((h % 360) + 360) % 360) / 60;
	const second = chroma * (1 - Math.abs((hue % 2) - 1));
	let red = 0;
	let green = 0;
	let blue = 0;
	if (hue < 1) [red, green, blue] = [chroma, second, 0];
	else if (hue < 2) [red, green, blue] = [second, chroma, 0];
	else if (hue < 3) [red, green, blue] = [0, chroma, second];
	else if (hue < 4) [red, green, blue] = [0, second, chroma];
	else if (hue < 5) [red, green, blue] = [second, 0, chroma];
	else [red, green, blue] = [chroma, 0, second];
	const offset = v - chroma;
	return [Math.round((red + offset) * 255), Math.round((green + offset) * 255), Math.round((blue + offset) * 255)];
}

function notifyProtocolLabel(): string {
	switch (TERMINAL.notifyProtocol) {
		case NotifyProtocol.Osc99:
			return "OSC 99 (kitty)";
		case NotifyProtocol.Osc9:
			return "OSC 9 (iTerm2/WezTerm)";
		default:
			return "BEL";
	}
}

function imageProtocolLabel(): string {
	switch (TERMINAL.imageProtocol) {
		case ImageProtocol.Kitty:
			return "Kitty graphics";
		case ImageProtocol.Iterm2:
			return "iTerm2 inline images";
		case ImageProtocol.Sixel:
			return "Sixel";
		default:
			return "none — text fallback";
	}
}

export interface ProtocolProbeOptions {
	image: SampleImage;
	imageBudget: ImageBudget;
	notificationSuppressed: boolean;
}

function ProbeText({ children }: { children: JSX.Element }): JSX.Element {
	const tight = useTightLayout();
	return (
		<box padding={{ left: tight() ? 0 : 1, right: tight() ? 0 : 1 }}>
			<text wrap="word" pad>
				{children}
			</text>
		</box>
	);
}

interface ProtocolProbeViewProps {
	readonly options: ProtocolProbeOptions;
	readonly imageState?: ImagePaintState;
}

function createProbeImagePaintState(options: ProtocolProbeOptions): ImagePaintState {
	return createImagePaintState({
		base64Data: options.image.base64,
		mimeType: options.image.mimeType,
		theme: { fallbackStyle: theme.style("toolOutput") },
		options: { maxWidthCells: 20, maxHeightCells: 16, budget: options.imageBudget },
		dimensions: options.image.dimensions,
	});
}

export function ProtocolProbeView({ options, imageState }: ProtocolProbeViewProps): JSX.Element {
	const image = imageState ?? createProbeImagePaintState(options);
	const colors = Array.from({ length: 32 }, (_, index) => {
		const [red, green, blue] = hsvToRgb((index / 32) * 360, 0.85, 1);
		return (
			<span key={index} style={Style.of({ bg: rgb(red, green, blue) })}>
				{" "}
			</span>
		);
	});
	return (
		<frame paddingX={0} border={false}>
			<stack>
				<hr char={theme.boxRound.horizontal} />
				<ProbeText>
					<span color="accent" bold>
						Terminal Protocol Test
					</span>
				</ProbeText>
				<ProbeText>
					<span color="muted">Styling (SGR)</span>
					<br />
					{"  "}
					<span bold>bold</span>
					{"  "}
					<span italic>italic</span>
					{"  "}
					<span underline>underline</span>
					{"  "}
					<span strike>strike</span>
					{"  "}
					<span inverse> inverse </span>
					{"  "}
					<span dim>dim</span>
					<br />
					{"  "}
					<span color="accent">accent</span>
					{"  "}
					<span color="success">success</span>
					{"  "}
					<span color="warning">warning</span>
					{"  "}
					<span color="error">error</span>
					<br />
					{"  truecolor: "}
					{colors}
					{" ("}
					<span color="muted">24-bit {TERMINAL.trueColor ? "on" : "off"}</span>
					{")"}
				</ProbeText>
				<text>{""}</text>
				<ProbeText>
					<span color="muted">Hyperlinks (OSC 8)</span>
					{" — "}
					<span color={TERMINAL.hyperlinks ? "success" : "muted"}>
						{TERMINAL.hyperlinks ? "supported" : "unsupported"}
					</span>
					<br />
					{"  "}
					<span link="https://github.com/can1357/oh-my-pi">oh-my-pi repo</span>
				</ProbeText>
				<text>{""}</text>
				<ProbeText>
					<span color="muted">Text sizing (OSC 66)</span>
					{" — "}
					<span color={TERMINAL.textSizing ? "success" : "muted"}>
						{TERMINAL.textSizing ? "supported" : "unsupported"}
					</span>
				</ProbeText>
				{TERMINAL.textSizing ? (
					<LargeTextView />
				) : (
					<ProbeText>
						<span color="dim"> (enable via the tui.textSizing setting on a Kitty terminal)</span>
					</ProbeText>
				)}
				<text>{""}</text>
				<ProbeText>
					<span color="muted">Graphics</span>
					{" — "}
					<span color="dim">{imageProtocolLabel()}</span>
				</ProbeText>
				<image state={image} />
				<text>{""}</text>
				<ProbeText>
					<span color="muted">Notification</span>
					{" ("}
					<span color="dim">{notifyProtocolLabel()}</span>
					{") — "}
					<span color={options.notificationSuppressed ? "warning" : "success"}>
						{options.notificationSuppressed
							? "suppressed (PI_NOTIFICATIONS)"
							: "sent — check your desktop / titlebar"}
					</span>
				</ProbeText>
				<hr char={theme.boxRound.horizontal} />
			</stack>
		</frame>
	);
}
