import { ProcessTerminal } from "@oh-my-pi/pi-tui";
import { getImageDimensions } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { createImagePaintState, ImageView } from "@oh-my-pi/pi-tui/components/image";
import { Style } from "../src/core/style";
import { createElement, insert } from "../src/host/renderer";
import { render } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";

const testImagePath = Bun.argv[2] || "/tmp/test-image.png";

console.log("Loading image from:", testImagePath);

let imageBuffer: Uint8Array;
try {
	imageBuffer = await Bun.file(testImagePath).bytes();
} catch {
	console.error(`Failed to load image: ${testImagePath}`);
	console.error("Usage: bun test/image-test.ts [path-to-image.png]");
	process.exit(1);
}

const base64Data = imageBuffer.toBase64();
const dims = getImageDimensions(base64Data, "image/png");
console.log("Image dimensions:", dims);
console.log("");

const terminal = new ProcessTerminal();
const image = dims
	? createImagePaintState({
			base64Data,
			mimeType: "image/png",
			theme: { fallbackStyle: Style.NONE },
			options: { maxWidthCells: 60 },
			dimensions: dims,
		})
	: undefined;

const root = render(
	() => {
		const stack = createElement("stack");
		insert(stack, () => {
			const header = createElement("text");
			insert(header, "Image Rendering Test");
			const footer = createElement("text");
			insert(footer, "Press Ctrl+C to exit");
			if (image) return [header, ImageView({ state: image }), footer];
			const error = createElement("text");
			insert(error, "Could not parse image dimensions");
			return [header, error, footer];
		});
		return stack;
	},
	{ terminal, theme: loadThemeSync("dark") },
);

function stop(): void {
	root.dispose();
	process.exit(0);
}

root.tui.setHostInputHandler(data => {
	if (data.charCodeAt(0) === 3) stop();
});
process.on("SIGINT", stop);
