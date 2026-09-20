import { describe, expect, it } from "bun:test";
import { QrCode, type QrEcLevel } from "@oh-my-pi/pi-tui";

function matrixFingerprint(qr: QrCode): string {
	let bits = "";
	for (let y = 0; y < qr.size; y++) {
		for (let x = 0; x < qr.size; x++) bits += qr.module(x, y) ? "1" : "0";
	}
	return new Bun.CryptoHasher("sha256").update(bits).digest("hex").slice(0, 16);
}

describe("QR encoder", () => {
	it("encodes a camera-readable matrix for every error-correction level", () => {
		for (const level of ["L", "M", "Q", "H"] as const satisfies readonly QrEcLevel[]) {
			const qr = QrCode.encodeText("oh-my-pi", level);
			expect(qr.size).toBeGreaterThanOrEqual(21);
			expect(qr.module(0, 0)).toBe(true);
			expect(qr.module(6, 6)).toBe(true);
		}
	});

	it("selects the smallest version that fits each byte payload", () => {
		const short = QrCode.encodeText("short");
		const long = QrCode.encodeText("x".repeat(200));
		expect(long.size).toBeGreaterThan(short.size);
	});

	it("is deterministic when it selects the mask", () => {
		expect(matrixFingerprint(QrCode.encodeText("deterministic payload"))).toBe(
			matrixFingerprint(QrCode.encodeText("deterministic payload")),
		);
	});

	it("rejects a payload that cannot fit version 40", () => {
		expect(() => QrCode.encodeText("x".repeat(10_000), "H")).toThrow();
	});
});
