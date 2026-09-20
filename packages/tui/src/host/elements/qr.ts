import { ansi16, Style } from "../../core/style";
import { registerElement } from "../registry";
import { Damage, type ElementImpl } from "../types";

/** Structural QR matrix accepted by the host renderer. */
export interface QrMatrix {
	readonly size: number;
	module(x: number, y: number): boolean;
}

/** Props for a camera-readable half-block QR rendering. */
export interface QrProps {
	readonly qr: QrMatrix;
	readonly margin?: number;
}

const QR_STYLE = Style.of({ fg: ansi16(30), bg: ansi16(37) });

const qrElement: ElementImpl = {
	tag: "qr",
	propDamage: () => Damage.Layout,
	paint(node, out) {
		const props = node.props as unknown as QrProps;
		const margin = Math.max(0, Math.trunc(props.margin ?? 4));
		const dimension = props.qr.size + margin * 2;
		const dark = (gridX: number, gridY: number): boolean => {
			const x = gridX - margin;
			const y = gridY - margin;
			return x >= 0 && x < props.qr.size && y >= 0 && y < props.qr.size && props.qr.module(x, y);
		};
		for (let y = 0; y < dimension; y += 2) {
			let row = "";
			for (let x = 0; x < dimension; x++) {
				const top = dark(x, y);
				const bottom = y + 1 < dimension && dark(x, y + 1);
				row += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
			}
			out.push(QR_STYLE, row);
			out.br();
		}
	},
};

registerElement(qrElement);
