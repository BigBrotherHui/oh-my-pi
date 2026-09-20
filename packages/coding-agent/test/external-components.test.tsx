import { renderToRows, renderToText } from "@oh-my-pi/pi-tui/testing";
import { beforeAll, describe, expect, it } from "bun:test";
import { McpAuthorizationLinkView } from "@oh-my-pi/pi-coding-agent/modes/components";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { cellGrid } from "../../tui/test/cell-grid";

const AUTH_URL =
	"https://example.test/oauth/authorize?response_type=code&client_id=omp&redirect_uri=http%3A%2F%2Flocalhost%3A14570%2Fcallback&state=0123456789abcdef&code_challenge=abcdefghijklmnopqrstuvwxyz&code_challenge_method=S256";

beforeAll(() => {
	initTheme();
});

describe("external components", () => {
	for (const width of [40, 80, 120]) {
		it(`renders the MCP authorization prompt at ${width} columns`, () => {
			const launchUrl = "http://localhost:14570/launch";
			const prompt = () => McpAuthorizationLinkView({ url: AUTH_URL, launchUrl });
			const rows = renderToRows(prompt, width);
			const text = renderToText(prompt, width).join("\n");

			expect(text).toContain("Open authorization URL:");
			expect(text).toContain("Click here to authorize");
			expect(text).toContain("Copy URL:");
			expect(text).toContain("Local shortcut (this machine only):");
			expect(text.replace(/\s/g, "")).toContain(AUTH_URL);
			expect(text.replace(/\s/g, "")).toContain(launchUrl);

			const linkedText = cellGrid(rows, width)
				.flat()
				.filter(cell => cell.link === AUTH_URL)
				.map(cell => cell.ch)
				.join("");
			expect(linkedText).toBe("Click here to authorize");
		});
	}
});
