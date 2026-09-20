import { afterEach, describe, expect, test } from "bun:test";
import {
	CollabInviteStatusView,
	CollabQrCodeView,
	collabBrowserLink,
	collabQrDimensions,
} from "../src/chrome/collab-qrcode";
import { QrCode } from "../src/host/qr-encode";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { createSignal } from "../src/reactive";
import { mountForTest } from "../src/testing";

const url = "https://my.omp.sh/#clip-test";
const qr = QrCode.encodeText(url, "M");

afterEach(() => applyHyperlinkSetting("auto"));

function mountedQr(allocatedRows?: () => number, width = collabQrDimensions(qr).columns) {
	const dimensions = collabQrDimensions(qr);
	return mountForTest(() => <CollabQrCodeView url={url} qr={qr} allocatedRows={allocatedRows} />, {
		width,
		height: dimensions.rows,
	});
}

describe("collaboration QR invite", () => {
	test("preserves the scheme-less browser display and full quiet-zone dimensions", () => {
		const dimensions = collabQrDimensions(qr);

		expect(collabBrowserLink(url)).toBe("my.omp.sh/#clip-test");
		expect(collabBrowserLink(url, "Join")).toBe("Join");
		expect(dimensions).toEqual({
			columns: qr.size + 9,
			rows: Math.ceil((qr.size + 8) / 2),
		});
	});

	test("renders the complete QR with its historical leading gutter when space permits", () => {
		const root = mountedQr();
		try {
			const rows = root.text();
			expect(rows).toHaveLength(collabQrDimensions(qr).rows);
			for (const row of rows) {
				expect(Bun.stringWidth(row)).toBe(collabQrDimensions(qr).columns);
				expect(row.startsWith(" ")).toBe(true);
			}
		} finally {
			root.dispose();
		}
	});

	test("replaces a narrow QR with the single-row terminal-width hint", () => {
		applyHyperlinkSetting("always");
		const root = mountedQr();
		try {
			const width = collabQrDimensions(qr).columns - 1;
			const rows = root.text(width);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toContain("Join QR code hidden: terminal");
			expect(rows[0]).not.toMatch(/[▀▄█]/);
			expect(Bun.stringWidth(rows[0] ?? "")).toBeLessThanOrEqual(width);
		} finally {
			root.dispose();
		}
	});

	test("keeps a literal browser URL when forced hyperlinks are explicitly disabled", () => {
		applyHyperlinkSetting("off");
		const root = mountedQr();
		try {
			const rows = root.text(collabQrDimensions(qr).columns - 1);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toStartWith("my.omp.sh/#clip-test QR code hidden:");
		} finally {
			root.dispose();
		}
	});

	test("reacts to transcript row allocation instead of exposing a clipped quiet zone", () => {
		const dimensions = collabQrDimensions(qr);
		const [allocatedRows, setAllocatedRows] = createSignal(dimensions.rows);
		const root = mountedQr(allocatedRows, dimensions.columns + 40);
		try {
			expect(root.text()).toHaveLength(dimensions.rows);

			setAllocatedRows(dimensions.rows - 1);
			root.flush();
			const rows = root.text();
			expect(rows).toEqual([
				`Join QR code hidden: viewport height ${dimensions.rows - 1}; need ${dimensions.rows}.`,
			]);
		} finally {
			root.dispose();
		}
	});

	test("restores control browser and terminal instructions", () => {
		applyHyperlinkSetting("always");
		const root = mountForTest(() => (
			<CollabInviteStatusView
				url={url}
				terminalLink="relay.example.com/r/full-control"
				heading="Collaboration hosting"
				appName="omp"
				access="control"
			/>
		));
		try {
			const text = root.text().join("\n");
			expect(text).toContain("Join in browser  Collaboration hosting");
			expect(text).toContain('Join from another terminal: omp join "relay.example.com/r/full-control"');
			expect(text).toContain("or any web browser: my.omp.sh/#clip-test");
			expect(text).toContain("Read-only link:");
			expect(text).toContain("/collab view");
		} finally {
			root.dispose();
		}
	});

	test("restores view-only browser and terminal instructions", () => {
		applyHyperlinkSetting("always");
		const root = mountForTest(() => (
			<CollabInviteStatusView
				url={url}
				terminalLink="relay.example.com/r/read-only"
				heading="Collaboration viewing"
				appName="omp"
				access="view"
			/>
		));
		try {
			const text = root.text().join("\n");
			expect(text).toContain('Watch from another terminal: omp join "relay.example.com/r/read-only"');
			expect(text).toContain("Anyone with this link can watch the session but cannot prompt the agent.");
		} finally {
			root.dispose();
		}
	});
});
