import { createImagePaintState, type ImageBudget, type ImagePaintState } from "../../host/elements/image";
import { DEFAULT_COLOR, parseColor, Style } from "../../core/style";
import { createMemo, Show, type Accessor, type JSX } from "../../reactive";
import { useTheme } from "../../theme/reactive";

/** Cached author photos supplied by the command host. */
export interface AvatarSource {
	get(email: string, cwd: string): string | null | undefined;
}

/**
 * Deterministic 5x5 mirrored identicon rendered as half-block rows (3 lines,
 * 10 columns). Used while an avatar loads and when none exists.
 */
export function identiconLines(email: string, colorize: (hex: string, text: string) => string): string[] {
	const identicon = buildIdenticon(email);
	return identicon.lines.map(line => colorize(identicon.hex, line));
}

/** Deterministic colored fallback for a missing or still-loading author photo. */
export function IdenticonView({ email }: { readonly email: string }): JSX.Element {
	const identicon = buildIdenticon(email);
	const color = parseColor(identicon.hex);
	const style = Style.of({ fg: color, bg: DEFAULT_COLOR });
	const { lines } = identicon;
	return (
		<stack>
			{lines.map((line, row) => (
				<text key={row} wrap="none">
					<span style={style}>{line}</span>
				</text>
			))}
		</stack>
	);
}

/** The HEAD-author visual: a three-row cached photo, or its identicon fallback. */
export function AvatarView(props: {
	readonly source: AvatarSource;
	readonly email: string;
	readonly cwd: string;
	readonly imageBudget?: ImageBudget;
}): JSX.Element {
	const { capabilities, theme } = useTheme();
	const imageState = createMemo((): ImagePaintState | undefined => {
		if (capabilities.imageProtocol === null) return undefined;
		const base64Data = props.source.get(props.email, props.cwd);
		if (!base64Data) return undefined;
		return createImagePaintState({
			base64Data,
			mimeType: "image/png",
			theme: { fallbackStyle: theme().style("dim") },
			options: {
				maxHeightCells: 3,
				budget: props.imageBudget,
				imageKey: `git-avatar:${props.email}`,
			},
		});
	});
	return (
		<Show when={imageState()} fallback={<IdenticonView email={props.email} />}>
			{(state: Accessor<ImagePaintState>) => <image state={state()} />}
		</Show>
	);
}

function buildIdenticon(email: string): { readonly hex: string; readonly lines: readonly string[] } {
	const bytes = new Bun.CryptoHasher("md5").update(email.trim().toLowerCase()).digest();
	const hex = hslToHex(((bytes[0] << 8) | bytes[1]) % 360, 0.55, 0.58);
	const isFilled = (x: number, y: number): boolean => {
		const column = x < 3 ? x : 4 - x;
		return bytes[3 + column * 5 + y] % 2 === 0;
	};
	const lines: string[] = [];
	for (let row = 0; row < 3; row++) {
		let line = "";
		for (let x = 0; x < 5; x++) {
			const top = isFilled(x, row * 2);
			const bottom = row * 2 + 1 < 5 && isFilled(x, row * 2 + 1);
			line += (top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ").repeat(2);
		}
		lines.push(line);
	}
	return { hex, lines };
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
	const base = lightness - chroma / 2;
	const sector = Math.floor(hue / 60) % 6;
	const rgb = [
		[chroma, second, 0],
		[second, chroma, 0],
		[0, chroma, second],
		[0, second, chroma],
		[second, 0, chroma],
		[chroma, 0, second],
	][sector];
	return `#${rgb
		.map(channel =>
			Math.round((channel + base) * 255)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}
